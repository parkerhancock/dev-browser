import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromeExtensionOrigin, chromeHostManifest, installChromeHost, paths, pointCurrent, readRecord,
} from "../setup.mjs";

const p = paths();
const resources = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = process.env.DEV_BROWSER_CHROME_HOST_MANIFEST || chromeHostManifest();
const metadata = JSON.parse(readFileSync(join(resources, "package-info.json"), "utf8"));
const saved = readRecord();
const host = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
const oldOrigin = host?.allowed_origins?.[0];

function extensionDirectory(selected) {
  const choices = [
    selected,
    saved?.extensionDirectory,
    saved?.mode === "link" && join(saved.source, "extension", ".output", "chrome-mv3"),
    join(p.dir, "chrome-extension"),
  ].filter(Boolean);
  for (const path of choices) {
    if (!existsSync(join(path, "manifest.json"))) continue;
    if (oldOrigin && chromeExtensionOrigin(path) !== oldOrigin) {
      if (path === selected) throw new Error("Select the same extension folder that Chrome is already using.");
      continue;
    }
    const extension = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    if (extension.name !== "dev-browser" || extension.key) {
      if (path === selected) throw new Error("The selected directory does not contain Dev Browser.");
      continue;
    }
    return { path, upgrade: true };
  }
  if (selected || oldOrigin || existsSync(join(p.dir, "extension-profile"))) {
    return { needsFolder: true };
  }
  return { path: join(p.dir, "chrome-extension"), upgrade: false };
}

function cli(target, action, services) {
  execFileSync(join(target, "node"), [join(target, "mcp-server", "bin", "dev-browser.mjs"), action, ...services],
    { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}

function restore(file, backup) {
  if (backup) writeFileSync(file, backup);
  else if (existsSync(file)) unlinkSync(file);
}

function install(extension) {
  mkdirSync(p.app, { recursive: true });
  const previousCurrent = existsSync(p.current) ? readlinkSync(p.current) : undefined;
  const rollbackFiles = [p.wrapper, join(p.bin, "com.dev_browser.chrome"), p.record, manifestPath]
    .map(file => [file, existsSync(file) ? readFileSync(file) : null]);
  const target = mkdtempSync(join(p.app, "desktop-" + metadata.version + "-"));
  const extensionFolder = extension.path;
  mkdirSync(dirname(extensionFolder), { recursive: true });
  const staging = mkdtempSync(join(dirname(extensionFolder), ".dev-browser-chrome-"));
  const candidateExtension = join(staging, "candidate");
  const oldExtension = join(staging, "previous");
  let extensionMoved = false;
  let installedExtension = false;
  let switchedRuntime = false;
  try {
    cpSync(join(resources, "runtime"), target, { recursive: true });
    cpSync(join(resources, "node"), join(target, "node"));
    cpSync(join(resources, "chrome-mv3"), candidateExtension, { recursive: true });
    if (extension.upgrade) {
      renameSync(extensionFolder, oldExtension);
      extensionMoved = true;
    }
    renameSync(candidateExtension, extensionFolder);
    installedExtension = true;

    pointCurrent(target, p.current);
    switchedRuntime = true;
    installChromeHost(p, extensionFolder, manifestPath, join(p.current, "node"));
    mkdirSync(p.bin, { recursive: true });
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(p.wrapper, "#!/bin/sh\nexec " + quote(join(p.current, "node")) + " " +
      quote(join(p.current, "mcp-server", "bin", "dev-browser.mjs")) + ' "$@"\n', { mode: 0o755 });
    writeFileSync(p.record, JSON.stringify({
      version: metadata.version, build: metadata.build, mode: "desktop", target,
      extensionDirectory: extensionFolder, installedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    cli(target, "restart", ["relay", "mcp"]);
    if (extensionMoved) {
      renameSync(oldExtension, join(target, "previous-chrome-extension"));
      extensionMoved = false;
    }
  } catch (error) {
    if (switchedRuntime) {
      try { cli(target, "stop", ["relay", "mcp"]); } catch { /* Keep restoring files. */ }
      if (previousCurrent) pointCurrent(previousCurrent, p.current);
      else unlinkSync(p.current);
      for (const [file, backup] of rollbackFiles) restore(file, backup);
    }
    if (installedExtension) renameSync(extensionFolder, candidateExtension);
    if (extensionMoved) renameSync(oldExtension, extensionFolder);
    if (switchedRuntime && previousCurrent) {
      try {
        execFileSync(process.execPath, [join(p.current, "mcp-server", "bin", "dev-browser.mjs"),
          "start", "relay", "mcp"], { timeout: 30_000 });
      } catch { /* The original install is back on disk. */ }
    }
    rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { ...extension, version: metadata.version };
}

const [action, selected] = process.argv.slice(2);
const extension = extensionDirectory(selected);
if (action === "plan" || extension.needsFolder) {
  console.log(JSON.stringify(extension));
} else if (action === "install") {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(p.dir, "desktop-install.lock"));
  try { console.log(JSON.stringify(install(extension))); }
  finally { rmdirSync(join(p.dir, "desktop-install.lock")); }
} else throw new Error("Unknown installer action");
