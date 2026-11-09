/**
 * Fetch a URL and print its content.
 *
 *   npx tsx scripts/fetch.ts <url> [--format=markdown|html|text|json]
 *     [--engine=browser|http|auto] [--timeout=30000]
 *     [--mode=standalone|extension] [--fresh] [--headed] [--browser=chrome]
 *     [--proxy=http://user:pass@host:port] [--screenshot=path.png] [--wacz=path.wacz]
 *
 * Content goes to stdout (--format=json prints the whole result). A status
 * line goes to stderr. Exit codes: 0 loaded, 1 navigation failed, 2 a bot
 * challenge or block page is still showing (content is printed anyway).
 *
 * Engines: "browser" (default) loads the page in dev-browser; "http" makes one
 * request with Chrome's TLS fingerprint and no browser, much faster for pages
 * that don't need JavaScript; "auto" tries HTTP first and falls back to the
 * browser when the result is blocked, failed, or an unrendered app shell.
 *
 * Browser modes: standalone (default) uses the headless server and starts it
 * if needed. --fresh runs a private browser with a throwaway profile instead
 * (--headed shows its window, --browser picks chromium or chrome, --proxy
 * routes it). Extension mode uses your Chrome, signed-in sessions included.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authHeaders, devBrowserDir, loadOrCreateToken } from "../src/auth.js";
import { connect, type DevBrowserClient } from "../src/client.js";
import { fetchPage, needsBrowser, type FetchPageResult } from "../src/fetch.js";
import { httpFetch } from "../src/http-fetch.js";
import { serve, type DevBrowserServer } from "../src/index.js";
import { parseProxyUrl } from "../src/types.js";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = { standalone: 9222, extension: 9224 } as const;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!url) {
  fail(
    "Usage: npx tsx scripts/fetch.ts <url> [--format=markdown|html|text|json] [--engine=browser|http|auto] " +
      "[--timeout=ms] [--mode=standalone|extension] [--fresh] [--headed] [--browser=chrome] [--proxy=url] " +
      "[--screenshot=path] [--wacz=path]"
  );
}
try {
  new URL(url);
} catch {
  fail(`Invalid URL: ${url}`);
}
const mode = (flag("mode") ?? "standalone") as keyof typeof PORTS;
if (!(mode in PORTS)) fail(`Unknown mode: ${mode}`);
const output = flag("format") ?? "markdown";
if (!["markdown", "html", "text", "json"].includes(output)) fail(`Unknown format: ${output}`);
const engine = flag("engine") ?? "browser";
if (!["browser", "http", "auto"].includes(engine)) fail(`Unknown engine: ${engine}`);
const timeout = Number(flag("timeout") ?? 30000);
const proxyUrl = flag("proxy");
const headed = has("headed");
const fresh = has("fresh") || headed || flag("browser") !== undefined;
const browserName = (flag("browser") ?? "chromium") as "chromium" | "chrome" | "msedge";
const format = output === "json" ? "markdown" : (output as "markdown" | "html" | "text");

if (proxyUrl && engine !== "http" && !fresh) {
  fail(
    "--proxy applies to --engine=http or a --fresh browser. A shared server takes its proxy at start: dev-browser serve --proxy."
  );
}
if (fresh && mode === "extension")
  fail("--fresh, --headed, and --browser start a standalone browser; drop --mode=extension.");

/** Any HTTP answer, even 401, means the server is up. */
async function serverUp(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(1000),
    });
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

/** A free localhost TCP port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function browserFetch(): Promise<FetchPageResult> {
  let server: DevBrowserServer | undefined;
  let profileDir: string | undefined;
  let client: DevBrowserClient;
  if (fresh) {
    profileDir = mkdtempSync(join(tmpdir(), "dev-browser-fetch-"));
    const port = await freePort();
    server = await serve({
      port,
      cdpPort: await freePort(),
      headless: !headed,
      browser: browserName,
      profileDir,
      proxy: proxyUrl ? parseProxyUrl(proxyUrl) : undefined,
    });
    client = await connect(`http://127.0.0.1:${port}`, {
      ephemeral: true,
      token: loadOrCreateToken(),
    });
  } else {
    if (mode === "standalone") await ensureStandaloneServer();
    else if (!(await serverUp(PORTS.extension))) {
      fail("The extension relay isn't running on port 9224. Start it, or use --mode=standalone.");
    }
    client = await connect({ mode, ephemeral: true });
  }
  try {
    return await fetchPage(client, url!, {
      timeout,
      format,
      screenshotPath: flag("screenshot"),
      waczPath: flag("wacz"),
    });
  } finally {
    await client.disconnect();
    await server?.stop();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  }
}

const wantsCapture = flag("screenshot") !== undefined || flag("wacz") !== undefined;
if (engine === "http" && wantsCapture)
  fail("--screenshot and --wacz need a browser; use --engine=browser or auto.");

let result: FetchPageResult;
if (engine === "browser") {
  result = await browserFetch();
} else {
  result = await httpFetch(url, { timeout, proxyUrl, format });
  if (engine === "auto" && (needsBrowser(result) || wantsCapture)) {
    const why = result.challenge
      ? "blocked"
      : result.error
        ? `${result.error.kind} error`
        : wantsCapture
          ? "capture requested"
          : "too little text";
    console.error(`HTTP fetch not usable (${why}); loading in the browser...`);
    result = await browserFetch();
  }
}

const status = result.status ? `HTTP ${result.status}` : "HTTP status unknown";
if (result.error && !result.content) {
  console.error(
    `Failed: ${result.error.kind} error loading ${url}: ${result.error.message.split("\n")[0]}`
  );
} else {
  console.error(
    `Fetched ${result.finalUrl} via ${result.engine} (${status}, ${result.textLength} chars of text)`
  );
}
if (result.challenge) {
  const hint =
    result.engine === "http"
      ? " --engine=browser may get through."
      : mode === "standalone"
        ? " --mode=extension may get through."
        : "";
  console.error(
    `Blocked: ${result.challenge.vendor} challenge (${result.challenge.reason}).${hint}`
  );
}
if (result.screenshotPath) console.error(`Screenshot: ${result.screenshotPath}`);
if (result.waczPath) console.error(`Archive: ${result.waczPath}`);

if (output === "json") console.log(JSON.stringify(result, null, 2));
else if (output === "markdown" && result.content && /html/i.test(result.contentType ?? "html")) {
  console.log(`# ${result.title}\n\nSource: ${result.finalUrl}\n\n${result.content}`);
} else console.log(result.content);

process.exitCode = result.error && !result.content ? 1 : result.challenge ? 2 : 0;
