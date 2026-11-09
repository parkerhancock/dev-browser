/**
 * dev-browser CLI — one binary for all modes:
 *
 *   dev-browser serve    [--port 9222] [--host 127.0.0.1] [--headed] [--profile NAME] [--browser chromium|chrome|msedge] [--profile-dir PATH] [--mcp]
 *                        [--proxy URL] [--proxy-bypass HOSTS] [--locale de-DE] [--timezone Europe/Berlin]
 *   dev-browser relay    [--port 9224] [--mcp]
 *   dev-browser mcp      [--http PORT] [--mode standalone|extension] [--session ID]
 *   dev-browser browsers
 *
 * --mcp mounts the MCP streamable-HTTP endpoint at /mcp on the same port
 * (behind the server's token auth), so one process serves both the library
 * HTTP API and MCP — the Docker/remote-service deployment shape.
 *
 * Replaces skills/dev-browser/{server,start,stop}.sh.
 */

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer as createHttpServer } from "node:http";
import { buildServer, createState, type BrowserMode } from "./server.js";
import { createMcpNodeHandler } from "./http.js";

function usage(): never {
  console.error(
    [
      "Usage: dev-browser <command> [options]",
      "",
      "Commands:",
      "  serve      Start the standalone Chromium server (:9222)",
      "             --port N, --host ADDR (0.0.0.0 for containers), --headed,",
      "             --profile NAME, --browser chromium|chrome|msedge,",
      "             --profile-dir PATH, --mcp (mount MCP at /mcp),",
      "             --proxy URL (http://user:pass@host:port or socks5://...; or DEV_BROWSER_PROXY),",
      "             --proxy-bypass HOSTS, --locale de-DE, --timezone Europe/Berlin",
      "  relay      Start the Chrome-extension relay (:9224)",
      "             --port N, --mcp (mount MCP at /mcp)",
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
          host: { type: "string" },
          headed: { type: "boolean", default: false },
          profile: { type: "string" },
          browser: { type: "string" },
          "profile-dir": { type: "string" },
          mcp: { type: "boolean", default: false },
          proxy: { type: "string" },
          "proxy-bypass": { type: "string" },
          locale: { type: "string" },
          timezone: { type: "string" },
        },
      });
      const { serve } = await import("../../skills/dev-browser/src/index.js");
      const { parseProxyUrl } = await import("../../skills/dev-browser/src/types.js");
      const proxyUrl = values.proxy ?? process.env.DEV_BROWSER_PROXY;
      await serve({
        port: values.port ? Number(values.port) : undefined,
        host: values.host,
        headless: !values.headed,
        profile: values.profile,
        browser: values.browser as "chromium" | "chrome" | "msedge" | undefined,
        profileDir: values["profile-dir"],
        proxy: proxyUrl ? parseProxyUrl(proxyUrl, values["proxy-bypass"]) : undefined,
        locale: values.locale,
        timezoneId: values.timezone,
        mcpHandler: values.mcp ? createMcpNodeHandler({ mode: "standalone" }) : undefined,
      });
      break;
    }

    case "relay": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string" },
          mcp: { type: "boolean", default: false },
        },
      });
      const { serveRelay } = await import("../../skills/dev-browser/src/relay.js");
      await serveRelay({
        port: values.port ? Number(values.port) : undefined,
        mcpHandler: values.mcp ? createMcpNodeHandler({ mode: "extension" }) : undefined,
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
      if (values.http) {
        const port = Number(values.http);
        // Stateful streamable HTTP: each MCP connection gets its own
        // transport and dev-browser session (unless --session pins one).
        const handler = createMcpNodeHandler({
          mode: values.mode as BrowserMode | undefined,
          session: values.session,
        });
        const httpServer = createHttpServer((req, res) => {
          void handler(req, res);
        });
        httpServer.listen(port, "127.0.0.1", () => {
          console.error(`dev-browser MCP listening on http://127.0.0.1:${port}/`);
        });
      } else {
        const state = createState({
          mode: values.mode as BrowserMode | undefined,
          session: values.session,
        });
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
