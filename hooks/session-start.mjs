#!/usr/bin/env node
/**
 * SessionStart hook: keep an installed dev-browser runtime in step with the
 * plugin. When ~/.dev-browser/app/current exists and its VERSION differs from
 * the plugin's, run `scripts/setup.mjs --update` in the background and return
 * at once. It never does a first install (setup asks about the login service
 * then), prints nothing, and ignores every error.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const root =
    process.env.CLAUDE_PLUGIN_ROOT ||
    process.env.PLUGIN_ROOT ||
    dirname(dirname(fileURLToPath(import.meta.url)));
  const dir = process.env.DEV_BROWSER_DIR || join(homedir(), ".dev-browser");
  const app = process.env.DEV_BROWSER_APP || join(dir, "app", "current");
  const setup = join(root, "scripts", "setup.mjs");

  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const manifest = [
    join(root, ".claude-plugin", "plugin.json"),
    join(root, ".codex-plugin", "plugin.json"),
  ].find(existsSync);
  const pluginVersion = manifest ? readJson(manifest).version : undefined;
  const runtimeVersion = existsSync(join(app, "VERSION"))
    ? readFileSync(join(app, "VERSION"), "utf8").trim()
    : undefined;

  if (pluginVersion && runtimeVersion && pluginVersion !== runtimeVersion && existsSync(setup)) {
    const child = spawn(process.execPath, [setup, "--update"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }
} catch {
  // A hook must never get in the way of the session
}
