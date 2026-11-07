/**
 * Smoke tests for the MCP server: tool registration and the tools that
 * work without a running browser server.
 */

import { afterEach, describe, test, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, createState, type BrowserState } from "../server.js";
import type { DevBrowserClient } from "../../../skills/dev-browser/src/client.js";

async function connectedClient(
  state: BrowserState = createState({ session: "mcp-test" })
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(state);
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
      "read_console_messages",
      "read_network_requests",
      "switch_browser",
      "list_connected_browsers",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
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

  test("tools report errors instead of throwing when no browser is running", async () => {
    // Fail the health probes so this can't reach a server running on this
    // machine, where navigate would open a real tab.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const client = await connectedClient();
    const result = await client.callTool({
      name: "navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("No dev-browser server is running");
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
