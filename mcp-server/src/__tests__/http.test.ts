/**
 * Tests for the streamable-HTTP MCP handler: per-connection MCP sessions
 * (each with its own dev-browser session) and protocol error handling.
 * No browser server needed — initialize and tools/list don't touch one.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpNodeHandler } from "../http.js";

describe("MCP streamable-HTTP handler", () => {
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    const handler = createMcpNodeHandler({ mode: "standalone" });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    url = new URL(`http://127.0.0.1:${port}/`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("serves tools over HTTP with a session per connection", async () => {
    const t1 = new StreamableHTTPClientTransport(url);
    const c1 = new Client({ name: "t1", version: "0.0.1" });
    await c1.connect(t1);

    const { tools } = await c1.listTools();
    expect(tools.map((t) => t.name)).toContain("navigate");
    expect(t1.sessionId).toBeDefined();

    // A second connection gets a distinct MCP session (and therefore a
    // distinct dev-browser page namespace).
    const t2 = new StreamableHTTPClientTransport(url);
    const c2 = new Client({ name: "t2", version: "0.0.1" });
    await c2.connect(t2);
    expect(t2.sessionId).toBeDefined();
    expect(t2.sessionId).not.toBe(t1.sessionId);

    await c1.close();
    await c2.close();
  });

  test("rejects a non-initialize request without a session id", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for an unknown session id", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "not-a-real-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(404);
  });
});
