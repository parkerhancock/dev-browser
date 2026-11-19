/**
 * Smoke tests for the MCP server: tool registration and the tools that
 * work without a running browser server.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDevSessionsServer, buildServer, createState, type BrowserState } from "../server.js";
import type { DevBrowserClient } from "../../../skills/dev-browser/src/client.js";
import { start } from "../daemon.js";

// Never launch a real background server from these tests: the MCP server
// starts the standalone server on demand, and these run against the
// machine's real ~/.dev-browser and ports
vi.mock("../daemon.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon.js")>()),
  start: vi.fn(async () => {
    throw new Error("background start refused in tests");
  }),
}));

async function connectedClient(
  state: BrowserState = createState({ session: "mcp-test" }),
  server = buildServer(state)
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

/** A connected client whose browser answers Runtime.evaluate with `result`. */
async function clientWithEvaluateResult(result: unknown) {
  const batch = vi.fn(async () => ({ results: [{ result }], completed: 1 }));
  const state = createState({ mode: "standalone", session: "mcp-test" });
  const browser = { page: vi.fn(async () => ({})), batch };
  state.clients.set("standalone", browser as unknown as DevBrowserClient);
  return { client: await connectedClient(state), batch };
}

describe("dev-browser MCP server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("registers the vendor-parity tool surface", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    const expected = [
      "tabs_context",
      "navigate",
      "read_page",
      "get_page_text",
      "find",
      "ref_action",
      "form_input",
      "browser_batch",
      "cdp_batch",
      "javascript",
      "screenshot",
      "computer",
      "resize_window",
      "file_upload",
      "tabs_create",
      "tabs_close",
      "tabs_select",
      "read_console_messages",
      "read_network_requests",
      "switch_browser",
      "list_connected_browsers",
      "preview_start",
      "preview_list",
      "preview_logs",
      "preview_stop",
      "gif_creator",
      "upload_image",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  test("restricted extension verifies the profile, pins dispatch, and refuses a replacement connection", async () => {
    const profileId = "a".repeat(64);
    const health = {
      mode: "extension", extensionConnected: true, sshAccessEnabled: true,
      extensionProfileId: profileId, extensionConnectionId: "first",
    };
    const sent: (string | null)[] = [];
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/health" || path === "/") return Response.json(health);
      sent.push(new Headers(options.headers).get("X-DevBrowser-Extension-Connection"));
      return Response.json({ pages: [], targets: [] });
    });
    async function attach(profile: string) {
      const state = createState({ mode: "extension" });
      return connectedClient(state, (await buildDevSessionsServer(state, "extension", profile)).server);
    }
    const context = async (client: Client) => {
      const result = await client.callTool({ name: "tabs_context", arguments: {} });
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    const wrong = await attach("b".repeat(64));
    expect(wrong.getServerCapabilities()?.experimental?.["dev-sessions/browser"]).toMatchObject({ refusal: { code: "BROWSER_PROFILE_MISMATCH" } });
    expect(await context(wrong)).toMatchObject({ code: "BROWSER_PROFILE_MISMATCH" });
    expect(sent).toEqual([]);
    const client = await attach(profileId);
    expect(client.getServerVersion()?.name).toBe("dev-sessions-browser");
    expect(client.getServerCapabilities()?.experimental).toHaveProperty("dev-sessions/browser");
    expect((await client.listTools()).tools.map((tool) => tool.name).sort())
      .toEqual(["get_page_text", "navigate", "observe_existing_tab", "tabs_context"]);
    expect((await client.callTool({ name: "javascript", arguments: { code: "0" } })).isError).toBe(true);
    expect(await context(client)).toMatchObject({
      mode: "extension", extensionConnected: true, extensionProfileId: profileId, extensionConnectionId: "first",
    });
    expect(sent).toEqual(["first", "first"]);
    health.extensionConnectionId = "replacement";
    expect(await context(client)).toMatchObject({ code: "BROWSER_EXTENSION_CHANGED" });
    health.extensionConnectionId = "first";
    expect(await context(client)).toMatchObject({ code: "BROWSER_EXTENSION_CHANGED" });
    expect(sent).toHaveLength(2);
    const fresh = await attach(profileId);
    health.sshAccessEnabled = false;
    expect(await context(fresh)).toMatchObject({ code: "BROWSER_EXTENSION_UNAVAILABLE" });
    health.sshAccessEnabled = true;
    expect(await context(fresh)).toMatchObject({ code: "BROWSER_EXTENSION_UNAVAILABLE" });
    expect(sent).toHaveLength(2);
    await Promise.all([client.close(), wrong.close(), fresh.close()]);
  });

  test("only the opt-in stdio launcher receives the scope preamble", () => {
    const cli = fileURLToPath(new URL("../../bin/dev-browser.mjs", import.meta.url));
    const args = [cli, "mcp", "--mode", "extension", "--dev-sessions", "standalone"];
    const run = (extra: string[]) => spawnSync(process.execPath, [...args, ...extra], {
      input: "", encoding: "utf8", timeout: 15_000,
    });
    const ready = run(["--scope-ready"]);
    expect(ready.status).toBe(0);
    expect(ready.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(ready.stdout)).toMatchObject({
      scope: "dev-sessions/browser", mode: "standalone", refusal: { code: "BROWSER_MODE_MISMATCH" },
    });
    const direct = run([]);
    expect(direct.status).toBe(0);
    expect(direct.stdout).toBe("");
  }, 35_000);

  test("restricted standalone normalizes context and refuses a mismatched launch mode", async () => {
    const state = createState({ mode: "standalone" });
    const browser = { getServerInfo: async () => ({ mode: "launch" }), list: async () => [], allTargets: async () => [] };
    state.clients.set("standalone", browser as unknown as DevBrowserClient);
    const client = await connectedClient(state, (await buildDevSessionsServer(state, "standalone")).server);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["get_page_text", "navigate", "tabs_context"]);
    const context = await client.callTool({ name: "tabs_context", arguments: {} });
    expect(JSON.parse((context.content as { text: string }[])[0]!.text).mode).toBe("standalone");
    const wrong = await connectedClient(state, (await buildDevSessionsServer(state, "extension", "a".repeat(64))).server);
    const refusal = await wrong.callTool({ name: "tabs_context", arguments: {} });
    expect(refusal.isError).toBe(true);
    expect(JSON.parse((refusal.content as { text: string }[])[0]!.text).code).toBe("BROWSER_MODE_MISMATCH");
    await Promise.all([client.close(), wrong.close()]);
  });

  test("tab_group names the session's tab group before the page opens", async () => {
    const calls: string[] = [];
    const state = createState({ mode: "extension", session: "mcp-test" });
    const browser = {
      setTabGroup: vi.fn(async (title: string) => void calls.push(`group:${title}`)),
      page: vi.fn(
        async (name: string) => (calls.push(`page:${name}`), { url: () => "about:blank" })
      ),
      getServerInfo: vi.fn(async () => ({ mode: "extension", extensionConnected: true })),
      list: vi.fn(async () => ["work"]),
      allTargets: vi.fn(async () => []),
    };
    state.clients.set("extension", browser as unknown as DevBrowserClient);
    const client = await connectedClient(state);

    await client.callTool({
      name: "tabs_create",
      arguments: { page: "work", tab_group: "Aetna benefits" },
    });
    await client.callTool({
      name: "tabs_create",
      arguments: { page: "work", tab_group: "Aetna benefits" },
    });
    const context = await client.callTool({ name: "tabs_context", arguments: {} });

    expect(calls).toEqual(["group:Aetna benefits", "page:work", "page:work"]);
    const text = (context.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).tabGroup).toBe("Aetna benefits");
  });

  test("list_connected_browsers works without any server running", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "list_connected_browsers",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(parsed).toHaveProperty("standalone");
    expect(parsed).toHaveProperty("extension");
  });

  test("with no server running, tools try to start the standalone server and report failure", async () => {
    // Fail the health probes so this can't reach a server running on this
    // machine, where navigate would open a real tab.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const client = await connectedClient();
    const result = await client.callTool({
      name: "navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    expect(start).toHaveBeenCalledWith("serve");
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("starting the standalone server failed");
  });

  test("javascript evaluates in REPL mode so top-level await works", async () => {
    const { client, batch } = await clientWithEvaluateResult({ result: { value: 42 } });
    const result = await client.callTool({
      name: "javascript",
      arguments: { code: "await Promise.resolve(42)" },
    });
    expect(batch).toHaveBeenCalledWith("main", [
      {
        method: "Runtime.evaluate",
        params: {
          expression: "await Promise.resolve(42)",
          returnByValue: true,
          awaitPromise: true,
          replMode: true,
        },
      },
    ]);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("42");
  });

  test("javascript reports page exceptions as tool errors", async () => {
    const { client } = await clientWithEvaluateResult({
      result: {},
      exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } },
    });
    const result = await client.callTool({
      name: "javascript",
      arguments: { code: "throw new Error('boom')" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("Error: boom");
  });

  test("screenshots are saved under DEV_BROWSER_DIR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-browser-mcp-"));
    vi.stubEnv("DEV_BROWSER_DIR", dir);
    const state = createState({ mode: "standalone", session: "mcp-test" });
    const page = { screenshot: async () => Buffer.from("png") };
    const browser = { page: async () => page };
    state.clients.set("standalone", browser as unknown as DevBrowserClient);
    const client = await connectedClient(state);

    const result = await client.callTool({ name: "screenshot", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const path = content[1]!.text.replace("Saved to ", "");
    expect(path.startsWith(join(dir, "screenshots"))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("browser_batch refuses nesting and unknown tools", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "browser_batch",
      arguments: { actions: [{ tool: "browser_batch" }, { tool: "navigate" }] },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as Array<{ error?: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.error).toContain("cannot be nested");
  });
});
