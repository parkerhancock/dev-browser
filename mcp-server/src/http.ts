/**
 * Streamable-HTTP handler for the dev-browser MCP server.
 *
 * Used two ways:
 *  - `dev-browser mcp --http PORT` serves it on its own port
 *  - `dev-browser serve --mcp` / `relay --mcp` mount it at /mcp on the
 *    browser server's own port (behind that server's token auth)
 *
 * Stateful: each MCP initialize creates its own transport + MCP server with
 * its own dev-browser session (`mcp-<id>`), so concurrent agents sharing one
 * endpoint keep separate page namespaces — the HTTP equivalent of what
 * CLAUDE_SESSION_ID gives each stdio process. An initialize request carrying
 * X-DevBrowser-Session pins that session instead, so a client (the plugin's
 * stdio shim) can keep one agent session's pages across connections.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, createState, type BrowserMode } from "./server.js";
import { TOKEN_HEADER, tokensMatch } from "../../skills/dev-browser/src/auth.js";

export const SESSION_HEADER = "x-devbrowser-session";
const VALID_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Auth for a standalone MCP endpoint (`dev-browser mcp --http`), matching the
 * relay: reject web pages by Origin (a page can send simple cross-site POSTs
 * to loopback), then require the shared token in X-DevBrowser-Token or
 * ?token=. Returns the refusal, or null to allow.
 */
export function checkMcpRequest(
  req: IncomingMessage,
  token: string
): { status: number; message: string } | null {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//i.test(origin)) {
    return {
      status: 403,
      message: "Forbidden: web origins may not use the dev-browser MCP endpoint",
    };
  }
  const header = req.headers[TOKEN_HEADER.toLowerCase()];
  const fromQuery = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  const candidate = (Array.isArray(header) ? header[0] : header) ?? fromQuery ?? undefined;
  if (candidate && tokensMatch(candidate, token)) return null;
  return {
    status: 401,
    message:
      "Unauthorized: missing or invalid X-DevBrowser-Token (read it from ~/.dev-browser/token)",
  };
}

export interface McpHttpOptions {
  /** Force a browser mode; default probes extension then standalone. */
  mode?: BrowserMode;
  /**
   * Fixed dev-browser session shared by every MCP connection. Default:
   * each MCP connection gets its own (`mcp-<connection id>`).
   */
  session?: string;
}

export type McpNodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    })
  );
}

export function createMcpNodeHandler(options: McpHttpOptions = {}): McpNodeHandler {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return async (req, res) => {
    try {
      const sidHeader = req.headers["mcp-session-id"];
      const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;

      // Requests on an established MCP session (POST calls, GET SSE stream,
      // DELETE termination) route to that session's transport.
      if (sid) {
        const transport = transports.get(sid);
        if (!transport) {
          // Expired/unknown session: 404 tells the client to re-initialize
          jsonError(res, 404, "Unknown mcp-session-id; re-initialize");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST") {
        jsonError(res, 400, "Missing mcp-session-id");
        return;
      }

      const body = await readJsonBody(req);
      if (!isInitializeRequest(body)) {
        jsonError(res, 400, "Expected an initialize request");
        return;
      }

      const pinned = req.headers[SESSION_HEADER];
      const requested = Array.isArray(pinned) ? pinned[0] : pinned;
      if (requested !== undefined && !VALID_SESSION.test(requested)) {
        jsonError(
          res,
          400,
          "Invalid X-DevBrowser-Session: use 1-128 letters, digits, '.', '_', ':', or '-'"
        );
        return;
      }

      const newSid = randomUUID();
      const state = createState({
        mode: options.mode,
        session: options.session ?? requested ?? `mcp-${newSid.slice(0, 8)}`,
      });
      const server = buildServer(state);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSid,
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        transports.delete(newSid);
        for (const client of state.clients.values()) {
          client.disconnect().catch(() => {});
        }
        state.clients.clear();
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("MCP HTTP error:", err);
      if (!res.headersSent) {
        jsonError(res, 500, String(err));
      }
    }
  };
}
