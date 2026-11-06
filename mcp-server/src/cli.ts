/**
 * dev-browser CLI — one binary for all modes:
 *
 *   dev-browser serve    [--port 9222] [--headed] [--profile NAME] [--browser chromium|chrome|msedge] [--profile-dir PATH]
 *   dev-browser relay    [--port 9224]
 *   dev-browser mcp      [--http PORT] [--mode standalone|extension] [--session ID]
 *   dev-browser browsers
 *
 * Replaces skills/dev-browser/{server,start,stop}.sh.
 */

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { buildServer, createState, type BrowserMode } from "./server.js";

function usage(): never {
  console.error(
    [
      "Usage: dev-browser <command> [options]",
      "",
      "Commands:",
      "  serve      Start the standalone Chromium server (:9222)",
      "             --port N, --headed, --profile NAME, --browser chromium|chrome|msedge, --profile-dir PATH",
      "  relay      Start the Chrome-extension relay (:9224)",
      "             --port N",
      "  mcp        Start the MCP server (stdio by default)",
      "             --http PORT (streamable HTTP), --mode standalone|extension, --session ID",
      "  browsers   Show which dev-browser servers are reachable",
    ].join("\n")
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "serve": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string" },
          headed: { type: "boolean", default: false },
          profile: { type: "string" },
          browser: { type: "string" },
          "profile-dir": { type: "string" },
        },
      });
      const { serve } = await import("../../skills/dev-browser/src/index.js");
      await serve({
        port: values.port ? Number(values.port) : undefined,
        headless: !values.headed,
        profile: values.profile,
        browser: values.browser as "chromium" | "chrome" | "msedge" | undefined,
        profileDir: values["profile-dir"],
      });
      break;
    }

    case "relay": {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" } },
      });
      const { serveRelay } = await import("../../skills/dev-browser/src/relay.js");
      await serveRelay({
        port: values.port ? Number(values.port) : undefined,
      });
      break;
    }

    case "mcp": {
      const { values } = parseArgs({
        args: rest,
        options: {
          http: { type: "string" },
          mode: { type: "string" },
          session: { type: "string" },
        },
      });
      const state = createState({
        mode: values.mode as BrowserMode | undefined,
        session: values.session,
      });

      if (values.http) {
        const port = Number(values.http);
        const httpServer = createHttpServer(async (req, res) => {
          // Stateless streamable HTTP: a fresh server+transport per request
          try {
            const server = buildServer(state);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
            });
            res.on("close", () => {
              transport.close();
              server.close();
            });
            await server.connect(transport);
            await transport.handleRequest(req, res);
          } catch (err) {
            console.error("MCP HTTP error:", err);
            if (!res.headersSent) {
              res.writeHead(500).end(JSON.stringify({ error: String(err) }));
            }
          }
        });
        httpServer.listen(port, "127.0.0.1", () => {
          console.error(`dev-browser MCP listening on http://127.0.0.1:${port}/`);
        });
      } else {
        const server = buildServer(state);
        await server.connect(new StdioServerTransport());
        console.error("dev-browser MCP server running on stdio");
      }
      break;
    }

    case "browsers": {
      const { authHeaders } = await import("../../skills/dev-browser/src/auth.js");
      for (const [mode, port] of [
        ["standalone", 9222],
        ["extension", 9224],
      ] as const) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1500);
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: authHeaders(),
            signal: controller.signal,
          });
          clearTimeout(timer);
          console.log(`${mode} (:${port}):`, res.ok ? await res.text() : `HTTP ${res.status}`);
        } catch {
          console.log(`${mode} (:${port}): not running`);
        }
      }
      break;
    }

    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
