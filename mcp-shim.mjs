#!/usr/bin/env node
/**
 * dev-browser's MCP entry point in the plugin: a stdio MCP server that
 * forwards every message to the local dev-browser MCP host
 * (`dev-browser mcp --http`, default http://127.0.0.1:9225/mcp).
 *
 * It uses only Node's standard library, so it starts in well under a second
 * with nothing installed: hosts give an MCP server 10 s (Codex) or 30 s
 * (Claude Code) to start, far less than installing dev-browser takes.
 *
 * - Sends the shared token (~/.dev-browser/token) and the agent's session ID
 *   (CLAUDE_SESSION_ID or CLAUDE_CODE_SESSION_ID) so pages persist per session.
 * - Starts the host itself (`dev-browser start mcp`) when the runtime is
 *   installed but the host isn't running. The handshake never waits for that:
 *   it's answered from mcp-shim-tools.json, and the first tool call waits for
 *   the host instead (tool calls aren't under the startup limit).
 * - Without the runtime, still answers the handshake, lists the tools from
 *   mcp-shim-tools.json, and answers every tool call with the setup command.
 * - Re-initializes transparently when the host restarts.
 *
 * Environment: DEV_BROWSER_MCP_URL (or DEV_BROWSER_MCP_PORT), DEV_BROWSER_DIR,
 * DEV_BROWSER_TOKEN, DEV_BROWSER_APP (runtime root, default
 * ~/.dev-browser/app/current).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.DEV_BROWSER_DIR || join(homedir(), ".dev-browser");
const APP = process.env.DEV_BROWSER_APP || join(DIR, "app", "current");
const CLI = join(APP, "mcp-server", "bin", "dev-browser.mjs");
const URL_ =
  process.env.DEV_BROWSER_MCP_URL ||
  `http://127.0.0.1:${process.env.DEV_BROWSER_MCP_PORT || 9225}/mcp`;
const SESSION = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || "";
const SETUP_HINT =
  `dev-browser isn't set up on this machine yet. In Claude Code run /dev-browser:setup; ` +
  `anywhere else run: node "${join(PLUGIN_ROOT, "scripts", "setup.mjs")}"`;

const log = (...args) => console.error("[dev-browser shim]", ...args);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function readToken() {
  if (process.env.DEV_BROWSER_TOKEN) return process.env.DEV_BROWSER_TOKEN.trim();
  try {
    return readFileSync(join(DIR, "token"), "utf8").trim();
  } catch {
    return "";
  }
}

function readSnapshot() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "mcp-shim-tools.json"), "utf8"));
  } catch {
    return { server: { name: "dev-browser", version: "0.0.0" }, tools: [] };
  }
}

// ---- Connection to the host ----

/** The client's initialize request, replayed whenever the host needs a new session. */
let initializeRequest;
let mcpSessionId;
let protocolVersion;
/** "host" while forwarding, "local" while answering from the snapshot. */
let mode;
/** Why local mode is in effect, shown in tool results. */
let localReason = SETUP_HINT;
let connecting;
/** A background `dev-browser start mcp`, while one runs. */
let hostStarting;
const HOST_START_TIMEOUT_MS = 45000;

class HostUnavailable extends Error {}

function headers(extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-DevBrowser-Token": readToken(),
    ...(SESSION ? { "X-DevBrowser-Session": SESSION } : {}),
    ...(mcpSessionId ? { "Mcp-Session-Id": mcpSessionId } : {}),
    ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    ...extra,
  };
}

/** POST one message; resolve with the JSON-RPC messages the host sent back. */
async function post(message, { timeoutMs = 600000 } = {}) {
  let res;
  try {
    res = await fetch(URL_, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HostUnavailable(
      `dev-browser's MCP host isn't reachable at ${URL_} (${err.cause?.code || err.message})`
    );
  }
  if (res.status === 202) return { status: 202, messages: [] };
  if (res.status === 401) {
    throw new HostUnavailable(
      `dev-browser's MCP host refused the token in ${join(DIR, "token")}. Run setup again.`
    );
  }
  const type = res.headers.get("content-type") || "";
  const messages = [];
  if (type.includes("text/event-stream")) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) messages.push(JSON.parse(data));
      }
    }
  } else {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  }
  return { status: res.status, messages, sessionId: res.headers.get("mcp-session-id") };
}

/** Start the host with the installed runtime, if there is one (one start at a time). */
function startHost() {
  if (!existsSync(CLI)) return Promise.resolve(false);
  hostStarting ??= runHostStart().finally(() => {
    hostStarting = undefined;
  });
  return hostStarting;
}

function runHostStart() {
  log(`starting the MCP host with ${CLI}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "start", "mcp"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, HOST_START_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Open an MCP session on the host with the client's initialize request. */
async function initializeHost() {
  mcpSessionId = undefined;
  protocolVersion = undefined;
  const reply = await post(initializeRequest, { timeoutMs: 5000 });
  if (reply.status >= 400 || !reply.sessionId) {
    throw new HostUnavailable(
      `dev-browser's MCP host answered initialize with HTTP ${reply.status}`
    );
  }
  mcpSessionId = reply.sessionId;
  const result = reply.messages.find((m) => m.id === initializeRequest.id)?.result;
  protocolVersion = result?.protocolVersion;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { timeoutMs: 5000 });
  return reply.messages;
}

/** Connect to the host, starting it if the runtime is installed. */
async function connect() {
  if (hostStarting) await hostStarting;
  try {
    return await initializeHost();
  } catch (err) {
    if (!(err instanceof HostUnavailable)) throw err;
    if (!(await startHost())) {
      localReason = existsSync(CLI)
        ? `${err.message}. Start it with: node "${CLI}" start mcp`
        : SETUP_HINT;
      throw err;
    }
    return await initializeHost();
  }
}

/** Ensure a host session exists (one attempt at a time). */
function ensureHost() {
  connecting ??= connect().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

// ---- Local answers (no host) ----

function answerLocally(message) {
  const snapshot = readSnapshot();
  if (message.id === undefined) return; // notifications need no answer
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: snapshot.server,
          instructions: localReason,
        },
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: message.id, result: { tools: snapshot.tools } });
      return;
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: localReason }], isError: true },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `${message.method} needs the dev-browser runtime. ${localReason}`,
        },
      });
  }
}

// ---- Message handling ----

async function forward(message, retried = false) {
  try {
    const reply = await post(message);
    if (reply.status === 404 && !retried) {
      // The host restarted and forgot this session: open a new one and retry
      await ensureHost();
      return forward(message, true);
    }
    for (const out of reply.messages) send(out);
    if (reply.status >= 400 && reply.messages.length === 0 && message.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `dev-browser's MCP host answered HTTP ${reply.status}` },
      });
    }
  } catch (err) {
    if (!(err instanceof HostUnavailable)) throw err;
    if (!retried) {
      // The host went away: reconnect (restarting it if possible) and retry once
      try {
        await ensureHost();
        mode = "host";
        return forward(message, true);
      } catch {
        // Fall through to a local answer
      }
    }
    mode = "local";
    answerLocally(message);
  }
}

async function handle(message) {
  if (message.method === "initialize") {
    initializeRequest = message;
    try {
      // Only a host that's already up answers the handshake; nothing here may wait on a start
      const messages = await initializeHost();
      mode = "host";
      for (const out of messages) send(out);
    } catch (err) {
      if (!(err instanceof HostUnavailable)) throw err;
      log(err.message);
      mode = "local";
      if (existsSync(CLI)) {
        localReason = `dev-browser's MCP host didn't start. Start it with: node "${CLI}" start mcp`;
        void startHost(); // in the background; the first tool call waits for it
      }
      answerLocally(message);
    }
    return;
  }
  if (mode === "local") {
    // After setup the host may be up: try once per tool call before answering locally
    if (message.method === "tools/call" && initializeRequest) {
      try {
        await ensureHost();
        mode = "host";
        return forward(message, true);
      } catch {
        // Still unavailable
      }
    }
    answerLocally(message);
    return;
  }
  await forward(message);
}

const pending = new Set();
const lines = createInterface({ input: process.stdin });
let initializing = Promise.resolve();
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // Everything waits for initialize to finish; after that, requests run concurrently
  const run =
    message.method === "initialize"
      ? (initializing = handle(message))
      : initializing.then(() => handle(message));
  const task = run.catch((err) => {
    log(err.stack || err.message);
    if (message.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: String(err.message) },
      });
  });
  pending.add(task);
  task.finally(() => pending.delete(task));
});
lines.on("close", async () => {
  await Promise.allSettled(pending);
  if (mode === "host" && mcpSessionId) {
    // End the host session; ignore failures, the host times it out anyway
    await fetch(URL_, {
      method: "DELETE",
      headers: headers(),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
  process.exit(0);
});
