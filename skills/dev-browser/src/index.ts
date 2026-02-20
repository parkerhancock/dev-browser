import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";
import { createLogger } from "./logging.js";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

// Helper to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries = 5,
  delayMs = 500
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const headless = options.headless ?? true;
  const cdpPort = options.cdpPort ?? 9223;
  const profileDir = options.profileDir;

  // Validate port numbers
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  // Determine user data directory for persistent context
  const userDataDir = profileDir
    ? join(profileDir, "browser-data")
    : join(process.cwd(), ".browser-data");

  // Create directory if it doesn't exist
  mkdirSync(userDataDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);

  console.log("Launching browser with persistent context...");

  // Launch persistent context - this persists cookies, localStorage, cache, etc.
  const launchArgs = [`--remote-debugging-port=${cdpPort}`];

  // When running headed, prevent the browser from stealing focus on launch
  if (!headless) {
    launchArgs.push("--silent-launch", "--no-startup-window");
  }

  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: launchArgs,
  });
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
  }

  // Session state for agent isolation
  interface SessionState {
    pageNames: Set<string>;
  }

  // Registry: namespaced key (session:name) -> PageEntry
  const registry = new Map<string, PageEntry>();
  const sessions = new Map<string, SessionState>();

  // Tab limits
  const TAB_WARNING_THRESHOLD = 3;
  const TAB_LIMIT = 5;

  // Logging
  const { log, logFile } = createLogger("server", { stdout: true });

  // Helper to get or create session state
  function getOrCreateSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { pageNames: new Set() };
      sessions.set(sessionId, session);
    }
    return session;
  }

  // Helper to count pages for a session
  function getSessionPageCount(sessionId: string): number {
    const session = sessions.get(sessionId);
    return session ? session.pageNames.size : 0;
  }

  // Helper to get CDP targetId for a page
  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse = { wsEndpoint };
    res.json(response);
  });

  // GET /pages - list pages for this session
  app.get("/pages", (req: Request, res: Response) => {
    const agentSession = req.get("X-DevBrowser-Session") ?? "default";
    const session = sessions.get(agentSession);
    const response: ListPagesResponse = {
      pages: session ? Array.from(session.pageNames) : [],
    };
    res.json(response);
  });

  // POST /pages - get or create page (namespaced by session)
  app.post("/pages", async (req: Request, res: Response) => {
    const agentSession = req.get("X-DevBrowser-Session") ?? "default";
    const body = req.body as GetPageRequest;
    const { name, viewport } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }

    if (name.length === 0) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    if (name.length > 256) {
      res.status(400).json({ error: "name must be 256 characters or less" });
      return;
    }

    // Internal key includes session prefix for isolation
    const pageKey = `${agentSession}:${name}`;
    const sessionState = getOrCreateSession(agentSession);
    const sessionPageCount = getSessionPageCount(agentSession);

    // Check if page already exists for THIS session
    let entry = registry.get(pageKey);
    let warning: string | undefined;

    if (entry) {
      log(`POST /pages session=${agentSession} name=${name} action=reused total=${registry.size} sessionTotal=${sessionPageCount}`);
    } else {
      // Check tab limits before creating
      if (sessionPageCount >= TAB_LIMIT) {
        log(`POST /pages session=${agentSession} name=${name} action=rejected-limit total=${registry.size} sessionTotal=${sessionPageCount}`);
        res.status(429).json({
          error: `Tab limit exceeded. Session "${agentSession}" already has ${sessionPageCount} tabs (limit: ${TAB_LIMIT}). Close some tabs before opening new ones.`,
        });
        return;
      }

      // Warn if approaching limit
      if (sessionPageCount >= TAB_WARNING_THRESHOLD) {
        warning = `Warning: Session "${agentSession}" has ${sessionPageCount} tabs. Limit is ${TAB_LIMIT}. Consider closing unused tabs.`;
        log(`POST /pages session=${agentSession} name=${name} warning=approaching-limit sessionTotal=${sessionPageCount}`);
      }

      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");

      // Inject stealth overrides before any navigation occurs.
      // Sites like X.com detect CDP/automation and degrade functionality.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          configurable: true,
          get: () => undefined,
        });
      });

      // Apply viewport if provided
      if (viewport) {
        await page.setViewportSize(viewport);
      }

      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(pageKey, entry);
      sessionState.pageNames.add(name);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        log(`PAGE_CLOSED session=${agentSession} name=${name} total=${registry.size}`);
        registry.delete(pageKey);
        sessionState.pageNames.delete(name);
      });

      log(`POST /pages session=${agentSession} name=${name} action=created total=${registry.size} sessionTotal=${sessionState.pageNames.size}`);
    }

    const response: GetPageResponse & { warning?: string } = {
      wsEndpoint,
      name, // Return without session prefix
      targetId: entry.targetId,
    };
    if (warning) {
      response.warning = warning;
    }
    res.json(response);
  });

  // DELETE /pages/:name - close a page (filtered by session)
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    const agentSession = req.get("X-DevBrowser-Session") ?? "default";
    const name = decodeURIComponent(req.params.name);
    const pageKey = `${agentSession}:${name}`;
    const entry = registry.get(pageKey);

    if (entry) {
      await entry.page.close();
      registry.delete(pageKey);
      const sessionState = sessions.get(agentSession);
      if (sessionState) {
        sessionState.pageNames.delete(name);
      }
      log(`DELETE /pages session=${agentSession} name=${name} action=deleted total=${registry.size}`);
      res.json({ success: true });
      return;
    }

    log(`DELETE /pages session=${agentSession} name=${name} action=not-found`);
    res.status(404).json({ error: "page not found" });
  });

  // GET /stats - server stats for debugging
  app.get("/stats", (_req: Request, res: Response) => {
    // Group pages by session
    const bySession: Record<string, Array<{ name: string; url: string }>> = {};
    for (const [pageKey, entry] of registry) {
      const parts = pageKey.split(":");
      const session = parts[0] ?? "unknown";
      const name = parts.slice(1).join(":");
      if (!bySession[session]) {
        bySession[session] = [];
      }
      bySession[session].push({ name, url: entry.page.url() });
    }

    res.json({
      totalPages: registry.size,
      totalSessions: sessions.size,
      tabLimit: TAB_LIMIT,
      tabWarningThreshold: TAB_WARNING_THRESHOLD,
      bySession,
    });
  });

  // Start the server
  const server = app.listen(port, () => {
    log(`HTTP API server running on port ${port}`);
    log(`Log file: ${logFile}`);
  });

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");

    // Close all active HTTP connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close all pages
    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    // Close context (this also closes the browser)
    try {
      await context.close();
    } catch {
      // Context might already be closed
    }

    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // Best effort
    }
  };

  // Signal handlers (consolidated to reduce duplication)
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  const errorHandler = async (err: unknown) => {
    console.error("Unhandled error:", err);
    await cleanup();
    process.exit(1);
  };

  // Register handlers
  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
