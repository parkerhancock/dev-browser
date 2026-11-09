/**
 * Background servers for `dev-browser start|stop|restart|status`.
 *
 * Each server runs this CLI's own subcommand detached, in its own process
 * group, with output in ~/.dev-browser/<name>.log and its pid in
 * ~/.dev-browser/<name>.pid (the same files the retired start.sh script used
 * for the relay, so `stop` also stops a relay that script started). A server
 * counts as running when something accepts connections on its port; one that
 * runs without a live pid file was started some other way and is left alone.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devBrowserDir } from "../../skills/dev-browser/src/auth.js";

export type ServiceName = "relay" | "serve" | "mcp";

export const SERVICE_NAMES: ServiceName[] = ["relay", "serve", "mcp"];

export const DEFAULT_PORTS: Record<ServiceName, number> = { relay: 9224, serve: 9222, mcp: 9225 };

const DESCRIPTIONS: Record<ServiceName, string> = {
  relay: "extension relay",
  serve: "standalone browser server",
  mcp: "MCP host",
};

export interface ServiceOptions {
  port?: number;
  /** serve only: show the browser window. */
  headed?: boolean;
  /** How long start waits for the port to answer (default 60 s; serve launches a browser). */
  timeoutMs?: number;
}

export interface ServiceStatus {
  name: ServiceName;
  description: string;
  port: number;
  running: boolean;
  /** Pid from the pid file, when that process is alive. */
  pid?: number;
  /** Started by `dev-browser start` (or start.sh), so `stop` can stop it. */
  managed: boolean;
  log: string;
}

const BIN = fileURLToPath(new URL("../bin/dev-browser.mjs", import.meta.url));

export const pidFile = (name: ServiceName): string => join(devBrowserDir(), `${name}.pid`);
export const logFile = (name: ServiceName): string => join(devBrowserDir(), `${name}.log`);

function commandArgs(name: ServiceName, port: number, options: ServiceOptions): string[] {
  switch (name) {
    case "relay":
      return ["relay", "--port", String(port)];
    case "serve":
      // CDP on the next port, so a second server on another port doesn't collide
      // on 9223, and one profile in ~/.dev-browser wherever start runs from
      return [
        "serve",
        "--port",
        String(port),
        "--cdp-port",
        String(port + 1),
        "--profile-dir",
        devBrowserDir(),
        ...(options.headed ? ["--headed"] : []),
      ];
    case "mcp":
      return ["mcp", "--http", String(port)];
  }
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
export function portAnswers(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ port, host: "127.0.0.1" });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(name: ServiceName): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile(name), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function removePidFile(name: ServiceName): void {
  try {
    unlinkSync(pidFile(name));
  } catch {
    // Already gone
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function status(
  name: ServiceName,
  options: ServiceOptions = {}
): Promise<ServiceStatus> {
  const port = options.port ?? DEFAULT_PORTS[name];
  const pid = readPid(name);
  const alive = pid !== undefined && isAlive(pid);
  return {
    name,
    description: DESCRIPTIONS[name],
    port,
    running: await portAnswers(port),
    ...(alive ? { pid } : {}),
    managed: alive,
    log: logFile(name),
  };
}

export async function start(
  name: ServiceName,
  options: ServiceOptions = {}
): Promise<ServiceStatus & { started: boolean }> {
  const port = options.port ?? DEFAULT_PORTS[name];
  const current = await status(name, options);
  if (current.running) return { ...current, started: false };
  if (!current.managed) removePidFile(name);

  mkdirSync(devBrowserDir(), { recursive: true });
  const log = openSync(logFile(name), "a");
  const child = spawn(process.execPath, [BIN, ...commandArgs(name, port, options)], {
    detached: true, // its own process group, so stop() takes its children (the browser) too
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`Couldn't start the ${DESCRIPTIONS[name]}`);
  writeFileSync(pidFile(name), `${child.pid}\n`);

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + (options.timeoutMs ?? 60000);
  while (Date.now() < deadline) {
    if (await portAnswers(port, 500)) return { ...(await status(name, options)), started: true };
    if (exited) break;
    await sleep(300);
  }
  await stop(name, options);
  const tail = existsSync(logFile(name))
    ? readFileSync(logFile(name), "utf8").trim().split("\n").slice(-15).join("\n")
    : "";
  throw new Error(
    `The ${DESCRIPTIONS[name]} didn't start on port ${port}${exited ? " (it exited)" : ""}.` +
      (tail ? `\nLast lines of ${logFile(name)}:\n${tail}` : "")
  );
}

export type StopResult = "stopped" | "not running" | "not managed";

/**
 * Stop a server this CLI (or start.sh) started. One running without a live
 * pid file is reported as "not managed" and left alone.
 */
export async function stop(name: ServiceName, options: ServiceOptions = {}): Promise<StopResult> {
  const port = options.port ?? DEFAULT_PORTS[name];
  const pid = readPid(name);
  if (pid === undefined || !isAlive(pid)) {
    removePidFile(name);
    return (await portAnswers(port)) ? "not managed" : "not running";
  }

  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig); // the whole process group
    } catch {
      try {
        process.kill(pid, sig); // not a group leader (a start.sh relay)
      } catch {
        // Already gone
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(pid)) signal("SIGKILL");
  removePidFile(name);

  // Wait for the port to close so an immediate start doesn't see the old server
  const portDeadline = Date.now() + 5000;
  while ((await portAnswers(port, 300)) && Date.now() < portDeadline) await sleep(100);
  return "stopped";
}
