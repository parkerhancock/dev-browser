import { Hono } from "hono";
import { serve as honoServe } from "@hono/node-server";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import {
  getAgentSession,
  validatePageName,
  withTimeout,
  TAB_WARNING_THRESHOLD,
  TAB_LIMIT,
} from "./types";
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

  mkdirSync(userDataDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);
  console.log("Launching browser with persistent context...");

  // Launch persistent context - preserves cookies, localStorage, cache
  const launchArgs = [`--remote-debugging-port=${cdpPort}`];
  if (!headless) {
    launchArgs.push("--silent-launch", "--no-startup-window");
  }

  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: launchArgs,
  });
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Registry types
  interface PageEntry {
    page: Page;
    targetId: string;
  }

  interface SessionState {
    pageNames: Set<string>;
  }

  const registry = new Map<string, PageEntry>();
  const sessions = new Map<string, SessionState>();

  const { log, logFile } = createLogger("server", { stdout: true });

  function getOrCreateSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { pageNames: new Set() };
      sessions.set(sessionId, session);
    }
    return session;
  }

  function getSessionPageCount(sessionId: string): number {
    return sessions.get(sessionId)?.pageNames.size ?? 0;
  }

  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  // Hono app
  const app = new Hono();

  // GET / - server info
  app.get("/", (c) => {
    return c.json({ wsEndpoint } satisfies ServerInfoResponse);
  });

  // GET /pages - list pages for this session
  app.get("/pages", (c) => {
    const agentSession = getAgentSession(c);
    const session = sessions.get(agentSession);
    return c.json({
      pages: session ? Array.from(session.pageNames) : [],
    } satisfies ListPagesResponse);
  });

  // POST /pages - get or create page (namespaced by session)
  app.post("/pages", async (c) => {
    const agentSession = getAgentSession(c);
    const body = (await c.req.json()) as GetPageRequest;
    const { name, viewport } = body;

    const nameError = validatePageName(name);
    if (nameError) return c.json({ error: nameError }, 400);

    const pageKey = `${agentSession}:${name}`;
    const sessionState = getOrCreateSession(agentSession);
    const sessionPageCount = getSessionPageCount(agentSession);

    let entry = registry.get(pageKey);
    let warning: string | undefined;

    if (entry) {
      log(`POST /pages session=${agentSession} name=${name} action=reused total=${registry.size} sessionTotal=${sessionPageCount}`);
    } else {
      if (sessionPageCount >= TAB_LIMIT) {
        log(`POST /pages session=${agentSession} name=${name} action=rejected-limit total=${registry.size} sessionTotal=${sessionPageCount}`);
        return c.json({
          error: `Tab limit exceeded. Session "${agentSession}" already has ${sessionPageCount} tabs (limit: ${TAB_LIMIT}). Close some tabs before opening new ones.`,
        }, 429);
      }

      if (sessionPageCount >= TAB_WARNING_THRESHOLD) {
        warning = `Warning: Session "${agentSession}" has ${sessionPageCount} tabs. Limit is ${TAB_LIMIT}. Consider closing unused tabs.`;
        log(`POST /pages session=${agentSession} name=${name} warning=approaching-limit sessionTotal=${sessionPageCount}`);
      }

      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");

      // Inject stealth overrides before any navigation
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          configurable: true,
          get: () => undefined,
        });
      });

      if (viewport) {
        await page.setViewportSize(viewport);
      }

      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(pageKey, entry);
      sessionState.pageNames.add(name);

      page.on("close", () => {
        log(`PAGE_CLOSED session=${agentSession} name=${name} total=${registry.size}`);
        registry.delete(pageKey);
        sessionState.pageNames.delete(name);
      });

      log(`POST /pages session=${agentSession} name=${name} action=created total=${registry.size} sessionTotal=${sessionState.pageNames.size}`);
    }

    const response: GetPageResponse & { warning?: string } = {
      wsEndpoint,
      name,
      targetId: entry.targetId,
    };
    if (warning) {
      response.warning = warning;
    }
    return c.json(response);
  });

  // DELETE /pages/:name - close a page (filtered by session)
  app.delete("/pages/:name", async (c) => {
    const agentSession = getAgentSession(c);
    const name = decodeURIComponent(c.req.param("name"));
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
      return c.json({ success: true });
    }

    log(`DELETE /pages session=${agentSession} name=${name} action=not-found`);
    return c.json({ error: "page not found" }, 404);
  });

  // GET /stats - server stats for debugging
  app.get("/stats", (c) => {
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

    return c.json({
      totalPages: registry.size,
      totalSessions: sessions.size,
      tabLimit: TAB_LIMIT,
      tabWarningThreshold: TAB_WARNING_THRESHOLD,
      bySession,
    });
  });

  // Start the server
  const server = honoServe({ fetch: app.fetch, port }, () => {
    log(`HTTP API server running on port ${port}`);
    log(`Log file: ${logFile}`);
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");

    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    try {
      await context.close();
    } catch {
      // Context might already be closed
    }

    server.close();
    console.log("Server stopped.");
  };

  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // Best effort
    }
  };

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

  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);
  process.on("exit", syncCleanup);

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
