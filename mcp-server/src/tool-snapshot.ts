/**
 * The MCP server's tool list as plain JSON, for the plugin's stdio shim
 * (../mcp-shim.mjs). The shim serves this list before the runtime is set up,
 * so the host shows dev-browser's tools from the first session.
 *
 * Regenerate with `npm run snapshot-tools` after changing any tool; a test
 * fails while the committed snapshot is stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, createState } from "./server.js";

export const SNAPSHOT_PATH = fileURLToPath(new URL("../../mcp-shim-tools.json", import.meta.url));

export interface ToolSnapshot {
  server: { name: string; version: string };
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

/** List the tools a freshly built server offers. Needs no browser. */
export async function buildToolSnapshot(): Promise<ToolSnapshot> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(createState({ session: "tool-snapshot" })).connect(serverTransport);
  const client = new Client({ name: "tool-snapshot", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const server = client.getServerVersion() ?? { name: "dev-browser", version: "0.0.0" };
    const tools: ToolSnapshot["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { server: { name: server.name, version: server.version }, tools };
  } finally {
    await client.close();
  }
}

export function readToolSnapshot(): ToolSnapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ToolSnapshot;
}

export async function writeToolSnapshot(): Promise<ToolSnapshot> {
  const snapshot = await buildToolSnapshot();
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const snapshot = await writeToolSnapshot();
  console.log(`Wrote ${snapshot.tools.length} tools to ${SNAPSHOT_PATH}`);
}
