// End-to-end: drive the dev-browser MCP server over stdio against the
// standalone server on :9222.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["bin/dev-browser.mjs", "mcp", "--mode", "standalone", "--session", "e2e-test"],
  cwd: "/Users/parkerhancock/Projects/parker-monorepo/tools/dev-browser/mcp-server",
});
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);

function text(result: any): string {
  return (result.content as any[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const nav = await client.callTool({
  name: "navigate",
  arguments: { url: "https://example.com", page: "e2e" },
});
console.log("navigate:", text(nav).slice(0, 200), "isError:", nav.isError ?? false);

const pageText = await client.callTool({
  name: "get_page_text",
  arguments: { page: "e2e" },
});
console.log("text:", JSON.stringify(text(pageText).slice(0, 120)));

const md = await client.callTool({
  name: "get_page_text",
  arguments: { page: "e2e", format: "markdown" },
});
console.log("markdown:", JSON.stringify(text(md).slice(0, 120)));

const found = await client.callTool({
  name: "find",
  arguments: { page: "e2e", query: "Learn more" },
});
console.log("find:", text(found).slice(0, 200));

const net = await client.callTool({
  name: "read_network_requests",
  arguments: { page: "e2e" },
});
console.log("network total:", JSON.parse(text(net)).total);

const js = await client.callTool({
  name: "javascript",
  arguments: { page: "e2e", code: "console.warn('e2e-marker'); 21*2" },
});
console.log("javascript 21*2 =", text(js));

const consoleResult = await client.callTool({
  name: "read_console_messages",
  arguments: { page: "e2e", pattern: "e2e-marker" },
});
console.log("console captured marker:", text(consoleResult).includes("e2e-marker"));

const batch = await client.callTool({
  name: "browser_batch",
  arguments: {
    actions: [
      { tool: "resize_window", input: { page: "e2e", width: 800, height: 600 } },
      { tool: "javascript", input: { page: "e2e", code: "innerWidth" } },
    ],
  },
});
console.log("batch:", text(batch));

const ctx = await client.callTool({ name: "tabs_context", arguments: {} });
console.log(
  "tabs_context mode:",
  JSON.parse(text(ctx)).mode,
  "pages:",
  JSON.parse(text(ctx)).namedPages
);

await client.callTool({ name: "tabs_close", arguments: { page: "e2e" } });
console.log("closed");
await client.close();
process.exit(0);
