/**
 * Fetch a URL and print its content.
 *
 *   npx tsx scripts/fetch.ts <url> [--format=markdown|html|text|json]
 *     [--timeout=30000] [--mode=standalone|extension]
 *     [--screenshot=path.png] [--wacz=path.wacz]
 *
 * Content goes to stdout (--format=json prints the whole result). A status
 * line goes to stderr. Exit codes: 0 loaded, 1 navigation failed, 2 a bot
 * challenge or block page is still showing (content is printed anyway).
 *
 * Standalone mode (default) uses a headless browser and starts the server if
 * it isn't running. Extension mode uses your Chrome, signed-in sessions
 * included, and needs the extension connected.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authHeaders, devBrowserDir } from "../src/auth.js";
import { connect } from "../src/client.js";
import { fetchPage } from "../src/fetch.js";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = { standalone: 9222, extension: 9224 } as const;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!url) fail("Usage: npx tsx scripts/fetch.ts <url> [--format=markdown|html|text|json] [--timeout=ms] [--mode=standalone|extension] [--screenshot=path] [--wacz=path]");
try {
  new URL(url);
} catch {
  fail(`Invalid URL: ${url}`);
}
const mode = (flag("mode") ?? "standalone") as keyof typeof PORTS;
if (!(mode in PORTS)) fail(`Unknown mode: ${mode}`);
const output = flag("format") ?? "markdown";
if (!["markdown", "html", "text", "json"].includes(output)) fail(`Unknown format: ${output}`);
const timeout = Number(flag("timeout") ?? 30000);

/** Any HTTP answer, even 401, means the server is up. */
async function serverUp(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { headers: authHeaders(), signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureStandaloneServer(): Promise<void> {
  if (await serverUp(PORTS.standalone)) return;
  const logDir = join(devBrowserDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, "fetch-server.log"), "a");
  console.error("Starting the standalone server...");
  spawn("npx", ["tsx", "scripts/start-server.ts"], {
    cwd: skillDir,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, HEADLESS: "true" },
  }).unref();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await serverUp(PORTS.standalone)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`The standalone server didn't start within 60s. See ${join(logDir, "fetch-server.log")}`);
}

if (mode === "standalone") await ensureStandaloneServer();
else if (!(await serverUp(PORTS.extension))) {
  fail("The extension relay isn't running on port 9224. Start it, or use --mode=standalone.");
}

const client = await connect({ mode, ephemeral: true });
try {
  const result = await fetchPage(client, url, {
    timeout,
    format: output === "json" ? "markdown" : (output as "markdown" | "html" | "text"),
    screenshotPath: flag("screenshot"),
    waczPath: flag("wacz"),
  });

  const status = result.status ? `HTTP ${result.status}` : "HTTP status unknown";
  if (result.error && !result.content) {
    console.error(`Failed: ${result.error.kind} error loading ${url}: ${result.error.message.split("\n")[0]}`);
  } else {
    console.error(`Fetched ${result.finalUrl} (${status}, ${result.textLength} chars of text)`);
  }
  if (result.challenge) {
    console.error(
      `Blocked: ${result.challenge.vendor} challenge (${result.challenge.reason}).` +
        (mode === "standalone" ? " --mode=extension may get through." : "")
    );
  }
  if (result.screenshotPath) console.error(`Screenshot: ${result.screenshotPath}`);
  if (result.waczPath) console.error(`Archive: ${result.waczPath}`);

  if (output === "json") console.log(JSON.stringify(result, null, 2));
  else if (output === "markdown" && result.content) {
    console.log(`# ${result.title}\n\nSource: ${result.finalUrl}\n\n${result.content}`);
  } else console.log(result.content);

  process.exitCode = result.error && !result.content ? 1 : result.challenge ? 2 : 0;
} finally {
  await client.disconnect();
}
