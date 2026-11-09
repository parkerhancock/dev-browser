/**
 * The plugin's stdio shim (../../mcp-shim.mjs), driven the way a host drives
 * it: before setup (no runtime, no host), with a runtime it starts the host
 * from, across a host restart, and with a pinned session. Private ports and
 * a private DEV_BROWSER_DIR keep a developer's own servers out of it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const base = 37000 + Math.floor(Math.random() * 2000);
const env = {
  DEV_BROWSER_DIR: mkdtempSync(join(tmpdir(), "dev-browser-shim-test-")),
  DEV_BROWSER_SERVE_PORT: String(base),
  DEV_BROWSER_RELAY_PORT: String(base + 10), // nothing listens
  DEV_BROWSER_MCP_PORT: String(base + 20),
};
Object.assign(process.env, env);

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { portAnswers, start, stop } from "../daemon.js";
import { buildToolSnapshot, readToolSnapshot } from "../tool-snapshot.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SHIM = join(REPO, "mcp-shim.mjs");
const clients: Client[] = [];

type Content = Array<{ type: string; text?: string }>;

async function connectShim(extraEnv: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SHIM],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...env,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "shim-test", version: "0.0.1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (result: unknown) =>
  ((result as { content: Content }).content ?? []).map((c) => c.text ?? "").join("\n");

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {});
  await stop("mcp").catch(() => {});
  await stop("serve").catch(() => {});
}, 60000);

describe("tool snapshot", () => {
  test("the committed snapshot matches the server's tools (run npm run snapshot-tools)", async () => {
    expect(readToolSnapshot()).toEqual(await buildToolSnapshot());
  });
});

describe("shim before setup", () => {
  test("answers the handshake fast, lists the tools, and returns the setup command", async () => {
    const startedAt = Date.now();
    const client = await connectShim({ DEV_BROWSER_APP: join(env.DEV_BROWSER_DIR, "no-runtime") });
    expect(Date.now() - startedAt).toBeLessThan(5000);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(readToolSnapshot().tools.map((t) => t.name));

    const result = await client.callTool({
      name: "navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/\/dev-browser:setup/);
    expect(text(result)).toContain(join(REPO, "scripts", "setup.mjs"));
    expect(await portAnswers(base + 20)).toBe(false);
  }, 30000);
});

describe("shim with the runtime installed", () => {
  // The repo checkout serves as the runtime, as `setup --link` will make it
  const runtime = { DEV_BROWSER_APP: REPO, CLAUDE_CODE_SESSION_ID: "shim-session" };

  test("answers the handshake at once, starts the host, and forwards the first call", async () => {
    expect(await portAnswers(base + 20)).toBe(false);
    const startedAt = Date.now();
    const client = await connectShim(runtime);
    expect(Date.now() - startedAt).toBeLessThan(5000); // never waits on the host start
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(readToolSnapshot().tools.length);
    const previews = await client.callTool({ name: "preview_list", arguments: {} });
    expect(text(previews)).not.toMatch(/setup|didn't start/);
    expect(previews.isError).toBeFalsy();
    expect(await portAnswers(base + 20)).toBe(true);
  }, 90000);

  test("pins the agent's session, starting the browser server on demand", async () => {
    const client = await connectShim(runtime);
    const ctx = JSON.parse(text(await client.callTool({ name: "tabs_context", arguments: {} })));
    expect(ctx.session).toBe("shim-session");
  }, 120000);

  test("survives a host restart", async () => {
    const client = await connectShim(runtime);
    await client.callTool({ name: "preview_list", arguments: {} });
    await stop("mcp");
    await start("mcp");
    const after = await client.callTool({ name: "preview_list", arguments: {} });
    expect(after.isError).toBeFalsy();
  }, 120000);

  test("restarts a host that went away", async () => {
    const client = await connectShim(runtime);
    await stop("mcp");
    expect(await portAnswers(base + 20)).toBe(false);
    const after = await client.callTool({ name: "preview_list", arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(await portAnswers(base + 20)).toBe(true);
  }, 120000);
});
