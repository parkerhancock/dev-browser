#!/usr/bin/env node
/**
 * Set up dev-browser on this machine, from the plugin (or a checkout).
 *
 *   node scripts/setup.mjs [--service | --no-service] [--link <checkout>] [--force]
 *   node scripts/setup.mjs --update
 *   node scripts/setup.mjs --uninstall [--purge]
 *
 * Installs the runtime (the library and the MCP server) into
 * ~/.dev-browser/app/<version>, points ~/.dev-browser/app/current at it,
 * installs its npm dependencies and patchright's Chromium, writes
 * ~/.dev-browser/bin/dev-browser, and records the install in
 * ~/.dev-browser/app/install.json. With --link, `current` points at a checkout
 * instead, so edits take effect after `dev-browser restart`.
 *
 * --service registers a login item (launchd on macOS, a systemd user unit on
 * Linux) that runs `dev-browser start mcp relay` at login. Without --service
 * or --no-service, setup asks when run in a terminal.
 *
 * --update is what the plugin's SessionStart hook runs after a plugin update:
 * no questions, linked installs untouched, running servers restarted on the
 * new version.
 *
 * --uninstall stops dev-browser's servers, removes the login item, and deletes
 * ~/.dev-browser/app and ~/.dev-browser/bin. The token, browser profiles, and
 * recordings stay unless --purge is given.
 *
 * Uses only Node's standard library, since nothing else is installed yet.
 * DEV_BROWSER_DIR moves ~/.dev-browser. DEV_BROWSER_SETUP_DRY=1 skips npm,
 * the browser download, starting servers, and launchctl/systemctl (tests).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SERVICE_LABEL = "com.dev-browser.services";
const RUNTIME_DIRS = ["skills/dev-browser", "mcp-server"];
const SKIPPED = new Set(["node_modules", "tmp", "profiles", ".output", ".wxt", "__pycache__"]);

export function paths(env = process.env) {
  const dir = env.DEV_BROWSER_DIR || join(homedir(), ".dev-browser");
  return {
    dir,
    app: join(dir, "app"),
    current: join(dir, "app", "current"),
    record: join(dir, "app", "install.json"),
    bin: join(dir, "bin"),
    wrapper: join(dir, "bin", "dev-browser"),
    log: join(dir, "setup.log"),
    lock: join(dir, "setup.lock"),
  };
}

const dry = () => process.env.DEV_BROWSER_SETUP_DRY === "1";

// ---- Version and install record ----

/** The package version from a plugin manifest, or the MCP server's package.json. */
export function readVersion(root) {
  for (const file of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "mcp-server/package.json",
  ]) {
    try {
      const version = JSON.parse(readFileSync(join(root, file), "utf8")).version;
      if (version) return String(version);
    } catch {
      // Try the next one
    }
  }
  throw new Error(
    `Couldn't find a version in ${root} (looked for plugin manifests and mcp-server/package.json)`
  );
}

export function readRecord(env = process.env) {
  try {
    return JSON.parse(readFileSync(paths(env).record, "utf8"));
  } catch {
    return undefined;
  }
}

// ---- Files ----

/** Copy the runtime parts of a plugin or checkout, leaving out dependencies and local state. */
export function copyRuntime(source, dest) {
  for (const dir of RUNTIME_DIRS) {
    if (!existsSync(join(source, dir)))
      throw new Error(`${source} has no ${dir}; is it a dev-browser plugin?`);
    cpSync(join(source, dir), join(dest, dir), {
      recursive: true,
      filter: (path) => {
        const name = basename(path);
        return !SKIPPED.has(name) && !name.startsWith(".browser-data");
      },
    });
  }
}

/** Point `current` at a target, replacing any previous link in one step. */
export function pointCurrent(target, current) {
  mkdirSync(dirname(current), { recursive: true });
  const temp = `${current}.${process.pid}.tmp`;
  try {
    unlinkSync(temp);
  } catch {
    // Not there
  }
  symlinkSync(target, temp, "dir");
  renameSync(temp, current);
}

/** A launcher on a stable path, using the node on PATH or, failing that, this one. */
export function wrapperScript(current) {
  return [
    "#!/bin/sh",
    "# Written by dev-browser setup",
    `NODE="$(command -v node || echo '${process.execPath}')"`,
    `exec "$NODE" '${join(current, "mcp-server", "bin", "dev-browser.mjs")}' "$@"`,
    "",
  ].join("\n");
}

function lockHash(dir) {
  return createHash("sha256")
    .update(readFileSync(join(dir, "package-lock.json")))
    .digest("hex");
}

/**
 * Whether a package needs `npm ci`: no node_modules, or a lockfile that
 * changed since the last install. A linked checkout's existing node_modules
 * without a stamp is trusted (a developer installed it).
 */
export function needsInstall(dir) {
  const stamp = join(dir, "node_modules", ".dev-browser-setup");
  if (!existsSync(join(dir, "node_modules"))) return true;
  if (!existsSync(stamp)) {
    writeFileSync(stamp, lockHash(dir));
    return false;
  }
  return readFileSync(stamp, "utf8").trim() !== lockHash(dir);
}

function markInstalled(dir) {
  writeFileSync(join(dir, "node_modules", ".dev-browser-setup"), lockHash(dir));
}

/** Remove older copied versions, keeping the current one and the one before it. */
function pruneVersions(app, keep) {
  const versions = readdirSync(app, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !keep.includes(e.name))
    .map((e) => ({ name: e.name, time: statSync(join(app, e.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const old of versions.slice(1))
    rmSync(join(app, old.name), { recursive: true, force: true });
}

// ---- Commands ----

let logPath;
const say = (line) => {
  console.log(line);
  if (logPath) appendFileSync(logPath, `${line}\n`);
};

function tool(name) {
  const beside = join(dirname(process.execPath), name);
  return existsSync(beside) ? beside : name;
}

/** Run a command, sending its output to the setup log; throw with the log's tail on failure. */
function run(command, args, cwd) {
  if (dry()) {
    say(`  (dry run) ${basename(command)} ${args.join(" ")} in ${cwd}`);
    return;
  }
  appendFileSync(logPath, `\n$ ${command} ${args.join(" ")}  (in ${cwd})\n`);
  const out = openSync(logPath, "a");
  try {
    const result = spawnSync(command, args, { cwd, stdio: ["ignore", out, out], env: process.env });
    if (result.status !== 0) {
      const tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-20).join("\n");
      throw new Error(
        `${basename(command)} ${args.join(" ")} failed in ${cwd}.\n${tail}\nFull log: ${logPath}`
      );
    }
  } finally {
    closeSync(out);
  }
}

/** Run the installed CLI, returning its stdout (empty in a dry run). */
function cli(current, args) {
  const bin = join(current, "mcp-server", "bin", "dev-browser.mjs");
  if (dry() || !existsSync(bin)) return "";
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  return result.stdout ?? "";
}

// ---- Login service ----

export function launchAgentPlist({ node, cliPath, dir, defaultDir }) {
  const env =
    dir === defaultDir
      ? ""
      : `  <key>EnvironmentVariables</key>\n  <dict><key>DEV_BROWSER_DIR</key><string>${dir}</string></dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cliPath}</string>
    <string>start</string>
    <string>mcp</string>
    <string>relay</string>
  </array>
${env}  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(dir, "service.log")}</string>
  <key>StandardErrorPath</key><string>${join(dir, "service.log")}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, cliPath, dir, defaultDir }) {
  return `[Unit]
Description=dev-browser MCP host and extension relay

[Service]
Type=oneshot
RemainAfterExit=yes
${dir === defaultDir ? "" : `Environment=DEV_BROWSER_DIR=${dir}\n`}ExecStart=${node} ${cliPath} start mcp relay
ExecStop=${node} ${cliPath} stop mcp relay

[Install]
WantedBy=default.target
`;
}

function serviceFile(env = process.env) {
  if (process.platform === "darwin") {
    return join(
      env.DEV_BROWSER_LAUNCHAGENTS_DIR || join(homedir(), "Library", "LaunchAgents"),
      `${SERVICE_LABEL}.plist`
    );
  }
  if (process.platform === "linux") {
    return join(
      env.DEV_BROWSER_SYSTEMD_DIR || join(homedir(), ".config", "systemd", "user"),
      "dev-browser.service"
    );
  }
  return undefined;
}

function installService(p) {
  const file = serviceFile();
  if (!file) {
    say(
      `A login item isn't supported on ${process.platform}; run \`${p.wrapper} start mcp relay\` yourself.`
    );
    return false;
  }
  const spec = {
    node: process.execPath,
    cliPath: join(p.current, "mcp-server", "bin", "dev-browser.mjs"),
    dir: p.dir,
    defaultDir: join(homedir(), ".dev-browser"),
  };
  mkdirSync(dirname(file), { recursive: true });
  if (process.platform === "darwin") {
    writeFileSync(file, launchAgentPlist(spec));
    if (!dry()) {
      const domain = `gui/${process.getuid()}`;
      spawnSync("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], { stdio: "ignore" });
      const result = spawnSync("launchctl", ["bootstrap", domain, file], { encoding: "utf8" });
      if (result.status !== 0)
        throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
    }
  } else {
    writeFileSync(file, systemdUnit(spec));
    if (!dry()) {
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      const result = spawnSync("systemctl", ["--user", "enable", "--now", "dev-browser.service"], {
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(`systemctl enable failed: ${result.stderr.trim()}`);
    }
  }
  say(`Login item installed: ${file}`);
  return true;
}

function removeService() {
  const file = serviceFile();
  if (!file || !existsSync(file)) return false;
  if (!dry()) {
    if (process.platform === "darwin") {
      spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${SERVICE_LABEL}`], {
        stdio: "ignore",
      });
    } else {
      spawnSync("systemctl", ["--user", "disable", "--now", "dev-browser.service"], {
        stdio: "ignore",
      });
    }
  }
  unlinkSync(file);
  if (process.platform === "linux" && !dry())
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  say(`Login item removed: ${file}`);
  return true;
}

// ---- Steps ----

function parseArgs(argv) {
  const options = {
    service: undefined,
    link: undefined,
    update: false,
    uninstall: false,
    purge: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--service") options.service = true;
    else if (arg === "--no-service") options.service = false;
    else if (arg === "--update") options.update = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--purge") options.purge = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--link" || arg.startsWith("--link=")) {
      const value = arg === "--link" ? argv[++i] : arg.slice("--link=".length);
      if (!value || value.startsWith("--")) throw new Error("--link needs a checkout path");
      options.link = value;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.purge && !options.uninstall) throw new Error("--purge goes with --uninstall");
  return options;
}

async function askService() {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Start dev-browser automatically when you log in? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function install(options, p) {
  const previous = readRecord();
  if (options.update && previous?.mode === "link") {
    say(`dev-browser is linked to ${previous.source}; --update leaves linked installs alone.`);
    return;
  }
  const link = options.link;
  const source = link ? realpathSync(resolve(link)) : PLUGIN_ROOT;
  const version = readVersion(source);
  const target = link ? source : join(p.app, version);

  say(`Setting up dev-browser ${version} ${link ? `linked to ${source}` : `in ${target}`}`);
  if (!link) {
    const complete = existsSync(join(target, ".complete"));
    if (!complete || options.force) {
      rmSync(target, { recursive: true, force: true });
      copyRuntime(source, target);
      say("  Copied the runtime");
    }
  }

  for (const dir of RUNTIME_DIRS) {
    const pkg = join(target, dir);
    if (dry() || needsInstall(pkg)) {
      say(`  Installing dependencies in ${dir} (a minute or so)...`);
      run(tool("npm"), ["ci", "--no-audit", "--no-fund"], pkg);
      if (!dry()) markInstalled(pkg);
    }
  }
  say("  Installing the browser (patchright Chromium)...");
  run(tool("npx"), ["patchright", "install", "chromium"], join(target, "skills/dev-browser"));
  if (!link) writeFileSync(join(target, ".complete"), `${version}\n`);

  pointCurrent(target, p.current);
  mkdirSync(p.bin, { recursive: true });
  writeFileSync(p.wrapper, wrapperScript(p.current));
  chmodSync(p.wrapper, 0o755);
  writeFileSync(
    p.record,
    `${JSON.stringify({ version, mode: link ? "link" : "copy", source, target, installedAt: new Date().toISOString() }, null, 2)}\n`
  );
  if (!link)
    pruneVersions(p.app, [version, ...(previous?.mode === "copy" ? [previous.version] : [])]);
  say(`  Runtime ready: ${p.current} -> ${target}`);
  say(`  CLI: ${p.wrapper}`);

  if (options.update) {
    // Servers keep running the old code until restarted
    let states = [];
    try {
      states = JSON.parse(cli(p.current, ["status", "--json"]) || "[]");
    } catch {
      states = [];
    }
    for (const s of states.filter((s) => s.running && s.managed && s.name !== "serve")) {
      cli(p.current, ["restart", s.name]);
      say(`  Restarted the ${s.description} on the new version`);
    }
    return;
  }

  const service = options.service ?? (await askService());
  if (service) {
    installService(p);
  } else if (options.service === undefined) {
    say(
      `  No login item. Start the servers with \`${p.wrapper} start mcp relay\`, or rerun setup with --service.`
    );
  }
  if (!service) cli(p.current, ["start", "mcp"]);

  say("");
  say("dev-browser is set up. The MCP tools work now; the browser starts on first use.");
  say(
    "For extension mode (your own Chrome), install the extension from https://github.com/parkerhancock/dev-browser/releases"
  );
}

async function uninstall(options, p) {
  const current = existsSync(p.current) ? p.current : undefined;
  if (current) say(cli(current, ["stop"]).trim() || "Stopped dev-browser's servers");
  removeService();
  for (const path of [p.app, p.bin]) {
    // A linked `current` is a symlink: rmSync removes the link, never the checkout
    if (existsSync(path) || isLink(path)) rmSync(path, { recursive: true, force: true });
  }
  if (options.purge) {
    logPath = undefined; // the log lives in the folder being removed
    rmSync(p.dir, { recursive: true, force: true });
    say(`Removed ${p.dir}`);
  } else {
    say(
      `Removed ${p.app} and ${p.bin}. Kept ${p.dir} (token, browser profiles, recordings); --purge removes it too.`
    );
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("*/")[0]
        .replace(/^#!.*\n\/\*\*\n?/, "")
        .replace(/^ \* ?/gm, "")
    );
    return 0;
  }
  const p = paths();
  mkdirSync(p.dir, { recursive: true });
  logPath = p.log;
  appendFileSync(logPath, `\n==== setup ${argv.join(" ")} at ${new Date().toISOString()}\n`);

  // One setup at a time (the update hook and a user's setup could overlap)
  try {
    closeSync(openSync(p.lock, "wx"));
  } catch {
    const stale = Date.now() - statSync(p.lock).mtimeMs > 30 * 60 * 1000;
    if (!stale) {
      if (options.update) return 0;
      throw new Error(
        `Another dev-browser setup is running (${p.lock}). Wait for it, or delete the file if it's stale.`
      );
    }
  }
  try {
    if (options.uninstall) await uninstall(options, p);
    else await install(options, p);
    return 0;
  } finally {
    try {
      unlinkSync(p.lock);
    } catch {
      // Gone already (--purge)
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`dev-browser setup failed: ${err.message}`);
      process.exit(1);
    }
  );
}
