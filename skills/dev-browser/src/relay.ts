/**
 * CDP Relay Server for Chrome Extension mode
 *
 * This server acts as a bridge between Playwright clients and a Chrome extension.
 * Instead of launching a browser, it waits for the extension to connect and
 * forwards CDP commands/events between them.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createNodeWebSocket } from "@hono/node-ws";
import { TOKEN_HEADER, tokensMatch } from "./auth.js";
import type { RelayOptions, RelayServer } from "./relay/types.js";
import { createRelayContext } from "./relay/context.js";
import { registerStatusRoutes } from "./relay/routes-status.js";
import { registerPageRoutes } from "./relay/routes-pages.js";
import { registerTabRoutes } from "./relay/routes-tabs.js";
import { registerCdpRoutes } from "./relay/routes-cdp.js";
import { registerCaptureRoutes } from "./relay/routes-capture.js";
import { registerSnapshotRoutes } from "./relay/routes-snapshot.js";
import { registerExtensionSocket } from "./relay/extension-socket.js";

export type {
  DialogPolicy,
  RelayOptions,
  DownloadRecord,
  ExtensionBrowserInfo,
  ConsoleMessage,
  RelayServer,
} from "./relay/types.js";

export async function serveRelay(options: RelayOptions = {}): Promise<RelayServer> {
  const ctx = createRelayContext(options);
  const {
    port,
    host,
    requireAuth,
    token,
    log,
    logFile,
    live,
    pdfCleanupInterval,
    idleCleanupInterval,
    groupSweepInterval,
  } = ctx;

  // ============================================================================
  // HTTP/WebSocket Server
  // ============================================================================

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // ---- Auth (§4): shared token on every HTTP request and WS upgrade ----
  // The /extension WS upgrade additionally accepts a chrome-extension://
  // Origin in place of the token (browser WebSockets can't set headers, and
  // web pages can't fake a chrome-extension:// Origin). http(s) Origins are
  // always rejected — that's a web page attempting a cross-site connection.
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    const extensionOrigin = !!origin && /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/iu.test(origin);
    if (c.req.path === "/pairing/complete" || c.req.path === "/extension/paired") {
      return extensionOrigin ? next() : c.json({ error: "Browser extension origin required" }, 403);
    }
    if (!requireAuth) return next();
    const candidate = c.req.header(TOKEN_HEADER) ?? c.req.query("token");
    const hasValidToken = !!candidate && tokensMatch(candidate, token);

    if (c.req.path === "/extension") {
      if (origin && /^https?:\/\//i.test(origin)) {
        log(`Rejected /extension upgrade with web Origin: ${origin}`);
        return c.json({ error: "Forbidden: web origins may not connect" }, 403);
      }
      if (hasValidToken || (origin && origin.startsWith("chrome-extension://"))) {
        return next();
      }
      log("Rejected /extension upgrade: no token and no extension Origin");
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (hasValidToken) return next();
    return c.json(
      {
        error:
          "Unauthorized: missing or invalid X-DevBrowser-Token (read it from ~/.dev-browser/token)",
      },
      401
    );
  });

  app.post("/pairing/start", (c) => {
    if (!requireAuth) return c.json({ error: "Pairing requires relay authentication" }, 403);
    if (ctx.pairing.profileId) return c.json({ error: "Relay already paired" }, 409);
    return c.json({ code: ctx.pairing.begin() }, 201, { "Cache-Control": "no-store" });
  });
  app.post("/pairing/complete", async (c) => {
    if (!requireAuth) return c.json({ error: "Pairing requires relay authentication" }, 403);
    const body = await c.req.json().catch(() => null);
    const profileId = ctx.pairing.redeem(body?.code, body?.credential);
    if (!profileId) return c.json({ error: "Invalid or expired pairing code" }, 403);
    live.persistedPages = [];
    ctx.debouncedSave();
    live.extensionWs?.close(1008, "Pairing required");
    return c.json({ profileId }, 201, { "Cache-Control": "no-store" });
  });

  app.use("*", async (c, next) => {
    const connection = c.req.header("X-DevBrowser-Extension-Connection");
    if (!connection) return next();
    if (live.extensionConnectionId !== connection) {
      return c.json({ error: "Approved extension connection ended" }, 409);
    }
    await ctx.connectionScope.run(connection, next);
    if (live.extensionConnectionId !== connection) {
      c.res = c.json({ error: "Approved extension connection ended" }, 409);
    }
  });

  // ---- Optional MCP endpoint (handler injected by the CLI) ----
  // Registered after the auth middleware, so /mcp requires the token too.
  if (options.mcpHandler) {
    const mcpHandler = options.mcpHandler;
    app.all("/mcp", async (c) => {
      const { incoming, outgoing } = c.env as {
        incoming: import("node:http").IncomingMessage;
        outgoing: import("node:http").ServerResponse;
      };
      await mcpHandler(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  /** Resolve the origin of a page's current URL for policy checks. */

  registerStatusRoutes(app, ctx);
  registerPageRoutes(app, ctx);
  registerTabRoutes(app, ctx);
  registerCdpRoutes(app, ctx);
  registerCaptureRoutes(app, ctx);
  registerSnapshotRoutes(app, ctx);
  registerExtensionSocket(app, upgradeWebSocket, ctx);

  // ============================================================================
  // Start Server
  // ============================================================================

  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  const wsEndpoint = `ws://${host}:${port}/cdp`;

  log("CDP relay server started");
  log(`  HTTP: http://${host}:${port}`);
  log(`  CDP endpoint: ${wsEndpoint}`);
  log(`  Extension endpoint: ws://${host}:${port}/extension`);
  log(`  Log file: ${logFile}`);
  log("");
  log("Waiting for extension to connect...");

  return {
    wsEndpoint,
    port,
    async stop() {
      live.extensionWs?.close(1000, "Server stopped");
      clearInterval(pdfCleanupInterval);
      clearInterval(idleCleanupInterval);
      clearInterval(groupSweepInterval);
      server.close();
    },
  };
}
