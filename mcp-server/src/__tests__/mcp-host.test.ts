/**
 * The MCP host (`dev-browser mcp --http`) as the plugin's shim will use it:
 * token and Origin checks, sessions pinned by X-DevBrowser-Session, and the
 * standalone server started on demand. Everything runs on private ports with
 * a private DEV_BROWSER_DIR, so a developer's own relay and browser are
 * untouched.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const base = 34000 + Math.floor(Math.random() * 3000);
process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-mcp-host-test-"));
process.env.DEV_BROWSER_SERVE_PORT = String(base);
process.env.DEV_BROWSER_RELAY_PORT = String(base + 10); // nothing listens: no relay in these tests
process.env.DEV_BROWSER_MCP_PORT = String(base + 20);

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { portAnswers, start, stop } from "../daemon.js";

const url = `http://127.0.0.1:${base + 20}/mcp`;
let token = "";
const clients: Client[] = [];

type Content = Array<{ type: string; text?: string }>;

async function connectAs(session?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        "X-DevBrowser-Token": token,
        ...(session ? { "X-DevBrowser-Session": session } : {}),
      },
    },
  });
  const client = new Client({ name: "mcp-host-test", version: "0.0.1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Content).map((c) => c.text ?? "").join("\n");
  if (result.isError) throw new Error(text);
  return text;
}

beforeAll(async () => {
  await start("mcp");
  token = readFileSync(join(process.env.DEV_BROWSER_DIR!, "token"), "utf8").trim();
}, 60000);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {});
  await stop("mcp").catch(() => {});
  await stop("serve").catch(() => {});
}, 60000);

const post = (headers: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    }),
  });

describe("MCP host auth", () => {
  test("rejects requests without the token", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ "X-DevBrowser-Token": "wrong" })).status).toBe(401);
  });

  test("rejects requests from web pages, even with the token", async () => {
    const res = await post({ "X-DevBrowser-Token": token, Origin: "https://example.com" });
    expect(res.status).toBe(403);
  });

  test("rejects a malformed session header", async () => {
    const res = await post({
      "X-DevBrowser-Token": token,
      "X-DevBrowser-Session": "bad session/../x",
    });
    expect(res.status).toBe(400);
  });
});

describe("MCP host sessions and on-demand server", () => {
  test("starts the standalone server on first use and uses the pinned session", async () => {
    expect(await portAnswers(base)).toBe(false);
    const a = await connectAs("t2-shared");
    const ctx = JSON.parse(await call(a, "tabs_context"));
    expect(ctx).toMatchObject({ mode: "launch", session: "t2-shared" }); // the standalone server reports "launch"
    expect(await portAnswers(base)).toBe(true);
  }, 120000);

  test("connections with the same session share pages; others don't", async () => {
    const a = await connectAs("t2-shared");
    await call(a, "navigate", { url: "data:text/html,<title>Shared</title>", page: "shared-page" });

    const b = await connectAs("t2-shared");
    const seen = JSON.parse(await call(b, "tabs_context")).namedPages as string[];
    expect(seen).toContain("shared-page");

    const c = await connectAs("t2-other");
    const other = JSON.parse(await call(c, "tabs_context"));
    expect(other.session).toBe("t2-other");
    expect(other.namedPages).not.toContain("shared-page");
  }, 120000);

  test("without the header, each connection gets its own session", async () => {
    const d = await connectAs();
    expect(JSON.parse(await call(d, "tabs_context")).session).toMatch(/^mcp-/);
  }, 60000);
});
