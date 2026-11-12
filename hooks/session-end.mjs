#!/usr/bin/env node
/**
 * SessionEnd hook: end this agent's dev-browser session on the extension
 * relay. Its tabs close and its tab group goes with them; pinned tabs stay
 * open, out of the group, for the person using them. Reads the session id
 * the same way the MCP shim does (CLAUDE_SESSION_ID, then the hook input's
 * session_id), prints nothing, and ignores every error, including no relay.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  let input = {};
  try {
    if (!process.stdin.isTTY) input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    // No or malformed hook input: fall back to the environment
  }
  const session =
    process.env.CLAUDE_SESSION_ID || input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
  const dir = process.env.DEV_BROWSER_DIR || join(homedir(), ".dev-browser");
  const port = process.env.DEV_BROWSER_RELAY_PORT || 9224;
  let token = process.env.DEV_BROWSER_TOKEN?.trim();
  if (!token) {
    try {
      token = readFileSync(join(dir, "token"), "utf8").trim();
    } catch {
      token = undefined;
    }
  }

  if (session && token) {
    await fetch(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(session)}?releasePinned=1`,
      {
        method: "DELETE",
        headers: { "X-DevBrowser-Token": token },
        signal: AbortSignal.timeout(5000),
      }
    );
  }
} catch {
  // A hook must never get in the way of the session
}
