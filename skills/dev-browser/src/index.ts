import { Hono, type Context } from "hono";
import { serve as honoServe } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createNodeWebSocket } from "@hono/node-ws";
import { chromium, type BrowserContext, type Page } from "patchright";
import { mkdirSync, readFileSync, statSync, copyFileSync } from "fs";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TOKEN_HEADER, loadOrCreateToken, tokensMatch } from "./auth.js";
import type { DownloadRecord } from "./relay.js";
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
import { DEFAULT_VIEWPORT, stealthLaunchArgs } from "./launch-args.js";
import { connectBrowserCdp } from "./browser-cdp.js";

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

/**
 * The user agent this browser sends when it isn't headless. Headless builds say
 * "HeadlessChrome", which sites can block on. Only the browser knows its version.
 */
async function headedUserAgent(channel: string | undefined): Promise<string> {
  const probe = await chromium.launch({ channel });
  try {
    const page = await probe.newPage();
    const userAgent = await page.evaluate<string>("navigator.userAgent");
    return userAgent.replace(/HeadlessChrome\/(\d+)[\d.]*/, "Chrome/$1.0.0.0");
  } finally {
    await probe.close();
  }
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const host = options.host ?? "127.0.0.1";
  const headless = options.headless ?? true;
  const cdpPort = options.cdpPort ?? 9223;
  const profileDir = options.profileDir;
  const browser = options.browser ?? "chromium";
  const requireAuth = options.requireAuth ?? true;
  const startedAt = Date.now();

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

  // Determine user data directory for persistent context.
  // Named profiles get their own directory so their state stays separate.
  const dataDirName = options.profile
    ? `browser-data-${options.profile}`
    : "browser-data";
  const userDataDir = profileDir
    ? join(profileDir, dataDirName)
    : join(process.cwd(), `.${dataDirName}`);

  mkdirSync(userDataDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);
  console.log("Launching browser with persistent context...");

  // Launch persistent context - preserves cookies, localStorage, cache
  const launchArgs = [`--remote-debugging-port=${cdpPort}`, ...stealthLaunchArgs(headless)];
  if (!headless) {
    launchArgs.push("--silent-launch", "--no-startup-window");
  }

  // "chrome" / "msedge" launch a locally installed branded browser.
  // Headless runs pass --headless=new themselves (see launch-args.ts), so
  // Playwright's own headless option stays off.
  const channel = browser === "chromium" ? undefined : browser;
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: launchArgs,
    channel,
    userAgent: headless ? await headedUserAgent(channel) : undefined,
    viewport: headless ? DEFAULT_VIEWPORT : undefined,
  });
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);
  const browserCdp = connectBrowserCdp(wsEndpoint);

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

  // Open each page in its own window. Pages that share a window are
  // background tabs, which Chrome marks hidden, and Playwright's actionability
  // checks stall on hidden pages.
  async function newWindowPage(): Promise<Page> {
    const created = browserCdp
      .send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true })
      .then((r) => r.targetId);
    const [page] = await Promise.all([
      context.waitForEvent("page", {
        predicate: async (p) => (await getTargetId(p)) === (await created),
        timeout: 30000,
      }),
      created,
    ]);
    return page;
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
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // ---- Auth (§4): shared token on every HTTP request and WS upgrade ----
  // Same scheme as the relay. The /cdp WS upgrade carries the token as a
  // ?token= query param because Playwright's connectOverCDP can't send
  // custom headers.
  const token = requireAuth ? loadOrCreateToken() : "";
  app.use("*", async (c, next) => {
    if (!requireAuth) return next();
    const candidate = c.req.header(TOKEN_HEADER) ?? c.req.query("token");
    if (candidate && tokensMatch(candidate, token)) return next();
    return c.json(
      {
        error:
          "Unauthorized: missing or invalid X-DevBrowser-Token (read it from ~/.dev-browser/token or set DEV_BROWSER_TOKEN)",
      },
      401
    );
  });

  /**
   * The CDP WS URL we advertise: this server's authenticated /cdp proxy,
   * addressed by whatever host the client dialed (works through Docker port
   * mapping and remote hosts). Chromium's raw endpoint is never advertised.
   */
  function advertisedWsEndpoint(c: Context): string {
    const dialedHost =
      c.req.header("host") ??
      `${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;
    return `ws://${dialedHost}/cdp`;
  }

  // ---- CDP WebSocket proxy: /cdp[/:session][?token=...] ----
  // Bridges each incoming connection to Chromium's loopback-only debug
  // endpoint. The trailing session segment is an isolation marker only.
  const cdpProxyHandler = upgradeWebSocket(() => {
    let upstream: WebSocket | null = null;
    const queued: string[] = [];
    return {
      onOpen(_event, ws) {
        upstream = new WebSocket(wsEndpoint);
        upstream.addEventListener("open", () => {
          for (const msg of queued) upstream!.send(msg);
          queued.length = 0;
        });
        upstream.addEventListener("message", (ev) => {
          ws.send(typeof ev.data === "string" ? ev.data : String(ev.data));
        });
        upstream.addEventListener("close", () => ws.close());
        upstream.addEventListener("error", () => ws.close());
      },
      onMessage(event, ws) {
        const msg =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf8");

        // Remote Playwright clients send Browser.setDownloadBehavior with a
        // downloadPath from THEIR machine, which breaks downloads in the
        // browser (and clobbers this server's own download tracking).
        // Answer it here instead of forwarding, so the server stays the
        // owner of download behavior.
        try {
          const parsed = JSON.parse(msg) as {
            id?: number;
            method?: string;
          };
          if (parsed.method === "Browser.setDownloadBehavior") {
            if (parsed.id !== undefined) {
              ws.send(JSON.stringify({ id: parsed.id, result: {} }));
            }
            return;
          }
        } catch {
          // Not JSON — forward as-is
        }

        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(msg);
        } else {
          queued.push(msg);
        }
      },
      onClose() {
        try {
          upstream?.close();
        } catch {
          // Upstream may already be closed
        }
      },
    };
  });
  app.get("/cdp", cdpProxyHandler);
  app.get("/cdp/:session", cdpProxyHandler);

  // ---- Downloads (server-side; survives remote clients) ----
  // Completed downloads are copied out of Playwright's temp artifacts dir
  // (which Playwright may clean at any time, and which dies with the
  // context) into a stable folder inside the profile dir, so GET
  // /download/:id can serve the bytes for as long as the server runs.
  const downloadsDir = join(userDataDir, "downloads");
  mkdirSync(downloadsDir, { recursive: true });
  const downloads: DownloadRecord[] = [];
  const downloadSessions = new Map<number, string>();
  let nextDownloadId = 1;

  function trackPageDownloads(page: Page, agentSession: string): void {
    page.on("download", (download) => {
      const record: DownloadRecord = {
        id: nextDownloadId++,
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        state: "inProgress",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      downloads.push(record);
      downloadSessions.set(record.id, agentSession);
      if (downloads.length > 100) {
        const dropped = downloads.shift();
        if (dropped) downloadSessions.delete(dropped.id);
      }
      download
        .path()
        .then((artifactPath) => {
          const safeName = (record.suggestedFilename ?? "download").replace(
            /[/\\]/g,
            "_"
          );
          const dest = join(downloadsDir, `${record.id}-${safeName}`);
          copyFileSync(artifactPath, dest);
          record.path = dest;
          record.state = "completed";
          try {
            record.fileSize = statSync(dest).size;
          } catch {
            // Size is best-effort
          }
          record.updatedAt = Date.now();
        })
        .catch(() => {
          record.state = "interrupted";
          record.updatedAt = Date.now();
        });
    });
  }

  // ---- Optional MCP endpoint (handler injected by the CLI) ----
  if (options.mcpHandler) {
    const mcpHandler = options.mcpHandler;
    app.all("/mcp", async (c) => {
      const { incoming, outgoing } = c.env as {
        incoming: IncomingMessage;
        outgoing: ServerResponse;
      };
      await mcpHandler(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  // GET / - server info
  app.get("/", (c) => {
    return c.json({
      wsEndpoint: advertisedWsEndpoint(c),
      wsPath: "/cdp",
      mode: "launch",
      browser,
    } satisfies ServerInfoResponse & {
      mode: string;
      browser: string;
    });
  });

  // GET /health - health probe
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      mode: "launch",
      browser,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      totalPages: registry.size,
      totalSessions: sessions.size,
    });
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

      const page = await withTimeout(newWindowPage(), 30000, "Page creation timed out after 30s");

      if (viewport) {
        await page.setViewportSize(viewport);
      }

      trackPageDownloads(page, agentSession);

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
      wsEndpoint: advertisedWsEndpoint(c),
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

  // GET /downloads - downloads for this session, newest state in place.
  // `since` is an epoch-ms floor on each download's start time.
  app.get("/downloads", (c) => {
    const agentSession = getAgentSession(c);
    const sinceRaw = c.req.query("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const list = downloads.filter(
      (d) =>
        downloadSessions.get(d.id) === agentSession &&
        (since === undefined || Number.isNaN(since) || d.startedAt >= since)
    );
    return c.json({ downloads: list });
  });

  // GET /download/:id - serve a completed download's bytes. The file is
  // Playwright's artifact on this machine; it is never deleted here.
  app.get("/download/:id", (c) => {
    const id = Number(c.req.param("id"));
    const record = downloads.find((d) => d.id === id);
    if (!record) return c.json({ error: "Unknown download id" }, 404);
    if (record.state !== "completed" || !record.path) {
      return c.json({ error: `Download not complete (state: ${record.state})` }, 409);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(record.path));
    } catch (err) {
      return c.json({ error: `Failed to read download: ${String(err)}` }, 500);
    }
    const filename = (record.suggestedFilename ?? "download").replace(/"/g, "");
    return new Response(bytes, {
      headers: {
        "Content-Type": record.mime ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
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
  const server = honoServe({ fetch: app.fetch, port, hostname: host }, () => {
    log(`HTTP API server running on ${host}:${port}`);
    log(`Log file: ${logFile}`);
  });
  injectWebSocket(server);

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

    browserCdp.close();
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
