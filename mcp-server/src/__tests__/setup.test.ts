/**
 * scripts/setup.mjs, run as a child process in dry-run mode
 * (DEV_BROWSER_SETUP_DRY=1: no npm, no browser download, no launchctl or
 * systemctl, no servers) with a private DEV_BROWSER_DIR and LaunchAgents
 * folder. Link and uninstall tests use a fake checkout, never this repo.
 */

import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);
const REPO = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const SETUP = join(REPO, "scripts", "setup.mjs");
const VERSION = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8"))
  .version as string;

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "dev-browser-setup-test-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    DEV_BROWSER_DIR: join(base, "dot-dev-browser"),
    DEV_BROWSER_SETUP_DRY: "1",
    DEV_BROWSER_LAUNCHAGENTS_DIR: join(base, "LaunchAgents"),
    DEV_BROWSER_SYSTEMD_DIR: join(base, "systemd"),
  };
  const setup = (...args: string[]) =>
    run(process.execPath, [SETUP, ...args], { env, timeout: 60000 });
  return { base, env, dir: env.DEV_BROWSER_DIR, setup };
}

/** A minimal stand-in for a checkout: what setup reads and links. */
function fakeCheckout(base: string, version = "9.9.9"): string {
  const root = join(base, "checkout");
  for (const dir of ["skills/dev-browser", "mcp-server/bin", ".claude-plugin"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
  for (const pkg of ["skills/dev-browser", "mcp-server"]) {
    writeFileSync(join(root, pkg, "package-lock.json"), "{}");
    mkdirSync(join(root, pkg, "node_modules"));
  }
  writeFileSync(join(root, "mcp-server", "bin", "dev-browser.mjs"), "");
  return root;
}

describe("setup from the plugin (copy mode)", () => {
  test("copies the runtime, points current at it, and writes the CLI and record", async () => {
    const { dir, setup } = sandbox();
    const { stdout } = await setup("--no-service");
    expect(stdout).toContain(`Setting up dev-browser ${VERSION}`);

    const target = join(dir, "app", VERSION);
    expect(existsSync(join(target, "skills/dev-browser/package.json"))).toBe(true);
    expect(existsSync(join(target, "mcp-server/bin/dev-browser.mjs"))).toBe(true);
    expect(existsSync(join(target, "skills/dev-browser/node_modules"))).toBe(false); // dependencies aren't copied
    expect(existsSync(join(target, "skills/dev-browser/.browser-data"))).toBe(false); // nor browser profiles

    expect(readlinkSync(join(dir, "app", "current"))).toBe(target);
    const wrapper = join(dir, "bin", "dev-browser");
    accessSync(wrapper, constants.X_OK);
    expect(readFileSync(wrapper, "utf8")).toContain(
      join(dir, "app", "current", "mcp-server", "bin", "dev-browser.mjs")
    );

    const record = JSON.parse(readFileSync(join(dir, "app", "install.json"), "utf8"));
    expect(record).toMatchObject({ version: VERSION, mode: "copy", target });
  }, 60000);

  test("a second run is quick and copies nothing", async () => {
    const { dir, setup } = sandbox();
    await setup("--no-service");
    const marker = join(dir, "app", VERSION, "mcp-server", "package.json");
    const before = statSync(marker).mtimeMs;
    const startedAt = Date.now();
    await setup("--no-service");
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(statSync(marker).mtimeMs).toBe(before);
  }, 60000);

  test("--service writes a login item that starts the MCP host and relay", async () => {
    const { base, dir, setup } = sandbox();
    await setup("--service");
    if (process.platform === "darwin") {
      const plist = readFileSync(
        join(base, "LaunchAgents", "com.dev-browser.services.plist"),
        "utf8"
      );
      expect(plist).toContain("<string>start</string>");
      expect(plist).toContain("<string>mcp</string>");
      expect(plist).toContain("<string>relay</string>");
      expect(plist).toContain(join(dir, "app", "current", "mcp-server", "bin", "dev-browser.mjs"));
      expect(plist).toContain(`<key>DEV_BROWSER_DIR</key><string>${dir}</string>`); // a non-default dir is passed on
    } else {
      const unit = readFileSync(join(base, "systemd", "dev-browser.service"), "utf8");
      expect(unit).toContain("start mcp relay");
    }
  }, 60000);

  test("rejects unknown options", async () => {
    const { setup } = sandbox();
    await expect(setup("--bogus")).rejects.toMatchObject({ code: 1 });
    await expect(setup("--link")).rejects.toMatchObject({ code: 1 });
    await expect(setup("--purge")).rejects.toMatchObject({ code: 1 });
  });
});

describe("setup --link", () => {
  test("points current at the checkout and records a linked install that --update leaves alone", async () => {
    const { base, dir, setup } = sandbox();
    const checkout = fakeCheckout(base);
    await setup("--link", checkout, "--no-service");
    expect(readlinkSync(join(dir, "app", "current"))).toBe(realpathSync(checkout));
    expect(JSON.parse(readFileSync(join(dir, "app", "install.json"), "utf8"))).toMatchObject({
      version: "9.9.9",
      mode: "link",
    });
    const { stdout } = await setup("--update");
    expect(stdout).toContain("leaves linked installs alone");
    expect(readlinkSync(join(dir, "app", "current"))).toBe(realpathSync(checkout));
  }, 60000);
});

describe("setup --uninstall", () => {
  test("removes the runtime, CLI, and login item but keeps the checkout and the token", async () => {
    const { base, dir, setup } = sandbox();
    const checkout = fakeCheckout(base);
    await setup("--link", checkout, "--service");
    writeFileSync(join(dir, "token"), "secret\n");

    await setup("--uninstall");
    expect(existsSync(join(dir, "app"))).toBe(false);
    expect(existsSync(join(dir, "bin"))).toBe(false);
    expect(existsSync(join(base, "LaunchAgents", "com.dev-browser.services.plist"))).toBe(false);
    expect(existsSync(join(dir, "token"))).toBe(true);
    // The linked checkout is untouched: only the link was removed
    expect(existsSync(join(checkout, "mcp-server", "bin", "dev-browser.mjs"))).toBe(true);
  }, 60000);

  test("--purge removes ~/.dev-browser entirely", async () => {
    const { dir, setup } = sandbox();
    await setup("--no-service");
    await setup("--uninstall", "--purge");
    expect(existsSync(dir)).toBe(false);
  }, 60000);
});

describe("SessionStart hook", () => {
  test("updates a copied install whose version differs from the plugin's", async () => {
    const { dir, env, setup } = sandbox();
    await setup("--no-service");
    // Pretend an older version is installed
    const recordPath = join(dir, "app", "install.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...record, version: "0.0.1" }));

    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const hook = spawn(process.execPath, [join(REPO, "hooks", "session-start.mjs")], {
        env: { ...env, CLAUDE_PLUGIN_ROOT: REPO },
        stdio: "ignore",
      });
      hook.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))
      );
    });
    expect(Date.now() - startedAt).toBeLessThan(3000); // the hook returns at once

    // The background update rewrites the record with the plugin's version
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (JSON.parse(readFileSync(recordPath, "utf8")).version === VERSION) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(JSON.parse(readFileSync(recordPath, "utf8")).version).toBe(VERSION);
  }, 60000);

  test("does nothing for a linked install or when nothing is installed", async () => {
    const { base, dir, env, setup } = sandbox();
    const hook = () =>
      run(process.execPath, [join(REPO, "hooks", "session-start.mjs")], {
        env: { ...env, CLAUDE_PLUGIN_ROOT: REPO },
      });
    await hook();
    expect(existsSync(join(dir, "app"))).toBe(false);

    const checkout = fakeCheckout(base, "0.0.1");
    await setup("--link", checkout, "--no-service");
    await hook();
    await new Promise((r) => setTimeout(r, 1500));
    expect(lstatSync(join(dir, "app", "current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "app", "current"))).toBe(realpathSync(checkout));
  }, 60000);
});
