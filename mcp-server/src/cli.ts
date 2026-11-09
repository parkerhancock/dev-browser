/**
 * dev-browser CLI — one binary for all modes:
 *
 *   dev-browser serve    [--port 9222] [--cdp-port 9223] [--host 127.0.0.1] [--headed] [--profile NAME] [--browser chromium|chrome|msedge] [--profile-dir PATH] [--mcp]
 *                        [--proxy URL] [--proxy-bypass HOSTS] [--locale de-DE] [--timezone Europe/Berlin]
 *   dev-browser relay    [--port 9224] [--mcp]
 *   dev-browser mcp      [--http PORT] [--mode standalone|extension] [--session ID]
 *   dev-browser browsers
 *   dev-browser start    [relay|serve|mcp ...] [--port N] [--headed]   (default: relay)
 *   dev-browser stop     [relay|serve|mcp ...]                         (default: all)
 *   dev-browser restart  [relay|serve|mcp ...] [--port N] [--headed]   (default: relay)
 *   dev-browser status   [relay|serve|mcp ...] [--json]                (default: all)
 *
 * --mcp mounts the MCP streamable-HTTP endpoint at /mcp on the same port
 * (behind the server's token auth), so one process serves both the library
 * HTTP API and MCP — the Docker/remote-service deployment shape.
 *
 * start/stop/restart/status run the servers in the background (see daemon.ts).
 */

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer as createHttpServer } from "node:http";
import { buildServer, createState, type BrowserMode } from "./server.js";
import { checkMcpRequest, createMcpNodeHandler } from "./http.js";
import {
  defaultPort,
  SERVICE_NAMES,
  start,
  status,
  stop,
  type ServiceName,
  type ServiceOptions,
} from "./daemon.js";

function usage(): never {
  console.error(
    [
      "Usage: dev-browser <command> [options]",
      "",
      "Commands:",
      "  serve      Start the standalone Chromium server (:9222)",
      "             --port N, --cdp-port N (default 9223), --host ADDR (0.0.0.0 for containers), --headed,",
      "             --profile NAME, --browser chromium|chrome|msedge,",
      "             --profile-dir PATH, --mcp (mount MCP at /mcp),",
      "             --proxy URL (http://user:pass@host:port or socks5://...; or DEV_BROWSER_PROXY),",
      "             --proxy-bypass HOSTS, --locale de-DE, --timezone Europe/Berlin",
      "  relay      Start the Chrome-extension relay (:9224)",
      "             --port N, --mcp (mount MCP at /mcp)",
      "  mcp        Start the MCP server (stdio by default)",
      "             --http PORT (streamable HTTP on 127.0.0.1, token required), --mode standalone|extension, --session ID",
      "  browsers   Show which dev-browser servers are reachable",
      "",
      "Background servers (relay :9224, serve :9222, mcp :9225; logs and pids in ~/.dev-browser):",
      "  start      Start servers in the background if they aren't running (default: relay)",
      "             --port N (one server only), --headed (serve)",
      "  stop       Stop servers that start launched (default: all)",
      "  restart    Stop, then start (default: relay)",
      "  status     Show each server's state (default: all), --json",
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
          "cdp-port": { type: "string" },
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
        cdpPort: values["cdp-port"] ? Number(values["cdp-port"]) : undefined,
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
        const { loadOrCreateToken } = await import("../../skills/dev-browser/src/auth.js");
        const token = loadOrCreateToken();
        const httpServer = createHttpServer((req, res) => {
          const refusal = checkMcpRequest(req, token);
          if (refusal) {
            res.writeHead(refusal.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: refusal.message }));
            return;
          }
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

    case "start":
    case "stop":
    case "restart":
    case "status":
      await background(command, rest);
      break;

    default:
      usage();
  }
}

/** start/stop/restart/status over the background servers. */
async function background(
  command: "start" | "stop" | "restart" | "status",
  rest: string[]
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      headed: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const unknown = positionals.filter((p) => !SERVICE_NAMES.includes(p as ServiceName));
  if (unknown.length > 0) {
    console.error(`Unknown server: ${unknown.join(", ")}. Use relay, serve, or mcp.`);
    process.exit(2);
  }
  const fallback: ServiceName[] =
    command === "start" || command === "restart" ? ["relay"] : SERVICE_NAMES;
  const names = positionals.length > 0 ? (positionals as ServiceName[]) : fallback;
  if (values.port && names.length !== 1) {
    console.error("--port applies to one server at a time");
    process.exit(2);
  }
  const options: ServiceOptions = {
    port: values.port ? Number(values.port) : undefined,
    headed: values.headed,
  };

  if (command === "status") {
    const states = await Promise.all(names.map((name) => status(name, options)));
    if (values.json) {
      console.log(JSON.stringify(states, null, 2));
      return;
    }
    for (const s of states) {
      const how = !s.running
        ? "not running"
        : s.managed
          ? `running (pid ${s.pid})`
          : "running (started elsewhere)";
      console.log(`${s.name.padEnd(6)} :${s.port}  ${how}  ${s.description}`);
    }
    return;
  }

  let failed = false;
  for (const name of names) {
    const port = options.port ?? defaultPort(name);
    if (command === "stop" || command === "restart") {
      const result = await stop(name, options);
      if (command === "stop" || result !== "not running") {
        const note =
          result === "not managed"
            ? " (it wasn't started by dev-browser start; stop it where it runs)"
            : "";
        console.log(`${name} :${port}  ${result}${note}`);
      }
      if (result === "not managed") {
        failed = true;
        continue;
      }
    }
    if (command === "start" || command === "restart") {
      try {
        const s = await start(name, options);
        console.log(
          `${name} :${port}  ${s.started ? `started (pid ${s.pid})` : "already running"}  log: ${s.log}`
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        failed = true;
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
