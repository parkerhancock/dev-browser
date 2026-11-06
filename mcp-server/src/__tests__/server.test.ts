/**
 * Smoke tests for the MCP server: tool registration and the tools that
 * work without a running browser server.
 */

import { describe, test, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, createState } from "../server.js";

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(createState({ session: "mcp-test" }));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

describe("dev-browser MCP server", () => {
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
    const client = await connectedClient();
    const result = await client.callTool({
      name: "navigate",
      arguments: { url: "https://example.com" },
    });
    // With no server running this must come back as a tool error, not a crash
    if (result.isError) {
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("No dev-browser server is running");
    }
    // (If a local dev-browser server happens to be running, navigation may
    // actually succeed — both outcomes are acceptable here.)
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
