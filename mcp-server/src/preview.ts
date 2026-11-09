/**
 * Dev servers for the preview_* tools. Configurations come from the project's
 * .claude/launch.json, the same file the built-in preview tools read:
 *
 *   { "version": "0.0.1", "configurations": [
 *     { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 } ] }
 *
 * A configuration with "url" and no command attaches to a server that's
 * already running. Each server's stdout and stderr are kept for preview_logs,
 * and every server stops when this process exits.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join, resolve } from "node:path";

export interface LaunchConfiguration {
  name: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  port?: number;
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PreviewServer {
  id: string;
  name: string;
  url: string;
  command?: string;
  pid?: number;
  status: "starting" | "running" | "exited";
  exitCode?: number | null;
  startedAt: string;
}

interface Running extends PreviewServer {
  child?: ChildProcess;
  logs: string[];
}

const MAX_LOG_LINES = 5000;
const START_TIMEOUT_MS = 60000;

export function readLaunchConfigurations(projectDir: string): LaunchConfiguration[] {
  const path = join(projectDir, ".claude", "launch.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No ${path}. Create it with a "configurations" list (see the preview_start description).`
    );
  }
  const parsed = JSON.parse(raw) as { configurations?: LaunchConfiguration[] };
  return parsed.configurations ?? [];
}

/** Resolves once something accepts TCP connections on the port. */
function waitForPort(port: number, isDead: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePort, reject) => {
    const attempt = () => {
      if (isDead()) return reject(new Error("The server exited before it opened its port"));
      const socket = tcpConnect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolvePort();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline)
          reject(new Error(`Nothing listened on port ${port} within ${timeoutMs / 1000}s`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

export class PreviewManager {
  private servers = new Map<string, Running>();
  private nextId = 1;

  constructor(private projectDir: string = process.cwd()) {
    process.once("exit", () => this.killAll());
  }

  /** Start (or reuse) the named configuration and return its server. */
  async start(name: string): Promise<PreviewServer & { reused: boolean }> {
    for (const server of this.servers.values()) {
      if (server.name === name && server.status !== "exited")
        return { ...this.view(server), reused: true };
    }
    const config = readLaunchConfigurations(this.projectDir).find((c) => c.name === name);
    if (!config) throw new Error(`No configuration named "${name}" in .claude/launch.json`);
    if (!config.url && config.port === undefined)
      throw new Error(`Configuration "${name}" needs a port or url`);
    const url = config.url ?? `http://localhost:${config.port}`;
    const server: Running = {
      id: `preview-${this.nextId++}`,
      name,
      url,
      status: "starting",
      startedAt: new Date().toISOString(),
      logs: [],
    };
    this.servers.set(server.id, server);

    if (!config.runtimeExecutable) {
      // Attach to a server that's already running
      server.status = "running";
      return { ...this.view(server), reused: false };
    }

    const args = config.runtimeArgs ?? [];
    server.command = [config.runtimeExecutable, ...args].join(" ");
    const child = spawn(config.runtimeExecutable, args, {
      cwd: config.cwd ? resolve(this.projectDir, config.cwd) : this.projectDir,
      env: { ...process.env, ...(config.port ? { PORT: String(config.port) } : {}), ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // its own process group, so stop() takes child processes too
    });
    server.child = child;
    server.pid = child.pid;
    const record = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        server.logs.push(stream === "stderr" ? `[stderr] ${line}` : line);
      }
      if (server.logs.length > MAX_LOG_LINES)
        server.logs.splice(0, server.logs.length - MAX_LOG_LINES);
    };
    child.stdout?.on("data", record("stdout"));
    child.stderr?.on("data", record("stderr"));
    child.on("exit", (code) => {
      server.status = "exited";
      server.exitCode = code;
    });
    child.on("error", (err) => {
      server.logs.push(`[error] ${err.message}`);
      server.status = "exited";
    });

    if (config.port !== undefined) {
      try {
        await waitForPort(config.port, () => server.status === "exited", START_TIMEOUT_MS);
      } catch (err) {
        const tail = server.logs.slice(-20).join("\n");
        await this.stop(server.id).catch(() => {});
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}.${tail ? `\nLast output:\n${tail}` : ""}`
        );
      }
    }
    if (server.status === "starting") server.status = "running";
    return { ...this.view(server), reused: false };
  }

  list(): PreviewServer[] {
    return [...this.servers.values()].map((s) => this.view(s));
  }

  logs(
    id: string,
    options: { level?: "all" | "error"; search?: string; lines?: number } = {}
  ): string[] {
    const server = this.get(id);
    let lines = server.logs;
    if (options.level === "error")
      lines = lines.filter((l) => /error|exception|failed|fatal/i.test(l));
    if (options.search) lines = lines.filter((l) => l.includes(options.search!));
    return lines.slice(-(options.lines ?? 50));
  }

  async stop(id: string): Promise<void> {
    const server = this.get(id);
    this.servers.delete(id);
    const child = server.child;
    if (!child || server.status === "exited" || child.pid === undefined) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    this.signal(child.pid, "SIGTERM");
    const timer = setTimeout(() => this.signal(child.pid!, "SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }

  private killAll(): void {
    for (const server of this.servers.values()) {
      if (server.child?.pid !== undefined && server.status !== "exited")
        this.signal(server.child.pid, "SIGTERM");
    }
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal); // the whole process group
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone
      }
    }
  }

  private get(id: string): Running {
    const server = this.servers.get(id);
    if (!server) throw new Error(`No preview server "${id}". preview_list shows the running ones.`);
    return server;
  }

  private view(server: Running): PreviewServer {
    const { child: _child, logs: _logs, ...rest } = server;
    return rest;
  }
}
