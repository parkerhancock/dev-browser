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
 * CLAUDE_SESSION_ID gives each stdio process.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, createState, type BrowserMode } from "./server.js";

export interface McpHttpOptions {
  /** Force a browser mode; default probes extension then standalone. */
  mode?: BrowserMode;
  /**
   * Fixed dev-browser session shared by every MCP connection. Default:
   * each MCP connection gets its own (`mcp-<connection id>`).
   */
  session?: string;
}

export type McpNodeHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void>;

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

function jsonError(
  res: ServerResponse,
  status: number,
  message: string
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    })
  );
}

export function createMcpNodeHandler(
  options: McpHttpOptions = {}
): McpNodeHandler {
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

      const newSid = randomUUID();
      const state = createState({
        mode: options.mode,
        session: options.session ?? `mcp-${newSid.slice(0, 8)}`,
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
