/**
 * Background servers started and stopped for real, on private ports with a
 * private DEV_BROWSER_DIR, so a developer's own relay on 9224 is untouched.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-daemon-test-"));

import { logFile, pidFile, portAnswers, start, status, stop } from "../daemon.js";

const run = promisify(execFile);
const base = 30000 + Math.floor(Math.random() * 3000);
const ports = { relay: base, mcp: base + 10, serve: base + 20, blocker: base + 30, cli: base + 40 };

afterAll(async () => {
  for (const [name, port] of [
    ["relay", ports.relay],
    ["mcp", ports.mcp],
    ["serve", ports.serve],
  ] as const) {
    await stop(name, { port }).catch(() => {});
  }
});

describe("background servers", () => {
  test("start is idempotent, status reports it, stop ends it", async () => {
    const first = await start("relay", { port: ports.relay });
    expect(first).toMatchObject({ started: true, running: true, managed: true });
    expect(existsSync(pidFile("relay"))).toBe(true);

    const second = await start("relay", { port: ports.relay });
    expect(second).toMatchObject({ started: false, running: true, pid: first.pid });

    expect(await status("relay", { port: ports.relay })).toMatchObject({
      running: true,
      managed: true,
    });
    expect(await stop("relay", { port: ports.relay })).toBe("stopped");
    expect(await portAnswers(ports.relay)).toBe(false);
    expect(existsSync(pidFile("relay"))).toBe(false);
    expect(await stop("relay", { port: ports.relay })).toBe("not running");
  }, 60000);

  test("the MCP host starts and answers HTTP", async () => {
    await start("mcp", { port: ports.mcp });
    const res = await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBeGreaterThanOrEqual(400); // answering, though not an initialize request
    expect(await stop("mcp", { port: ports.mcp })).toBe("stopped");
  }, 60000);

  test("serve starts a browser server, and stop takes the browser with it", async () => {
    const s = await start("serve", { port: ports.serve });
    expect(s.started).toBe(true);
    // The profile lives in DEV_BROWSER_DIR, not the directory start ran from
    expect(existsSync(join(process.env.DEV_BROWSER_DIR!, "browser-data"))).toBe(true);
    expect(await stop("serve", { port: ports.serve })).toBe("stopped");
    expect(await portAnswers(ports.serve)).toBe(false);
    expect(await portAnswers(ports.serve + 1)).toBe(false); // its CDP port closed too
  }, 120000);

  test("a server started elsewhere is reported but left alone", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(ports.blocker, "127.0.0.1", r));
    try {
      expect(await status("relay", { port: ports.blocker })).toMatchObject({
        running: true,
        managed: false,
      });
      expect(await stop("relay", { port: ports.blocker })).toBe("not managed");
      expect(await start("relay", { port: ports.blocker })).toMatchObject({ started: false });
      expect(await portAnswers(ports.blocker)).toBe(true);
    } finally {
      blocker.close();
    }
  });

  test("a stale pid file doesn't count as running", async () => {
    writeFileSync(pidFile("mcp"), "999999\n");
    expect(await status("mcp", { port: ports.mcp })).toMatchObject({
      running: false,
      managed: false,
    });
    expect(await stop("mcp", { port: ports.mcp })).toBe("not running");
    expect(existsSync(pidFile("mcp"))).toBe(false);
  });

  test("a server that doesn't come up in time is stopped and reported", async () => {
    const port = ports.mcp + 1;
    await expect(start("mcp", { port, timeoutMs: 1 })).rejects.toThrow(/didn't start on port \d+/);
    expect(existsSync(pidFile("mcp"))).toBe(false);
    expect(await portAnswers(port)).toBe(false);
    expect(existsSync(logFile("mcp"))).toBe(true);
  }, 30000);
});

describe("CLI", () => {
  const cli = (...args: string[]) =>
    run(process.execPath, [join(process.cwd(), "bin", "dev-browser.mjs"), ...args], {
      env: process.env,
      timeout: 60000,
    });

  test("start, status, and stop from the command line", async () => {
    const started = await cli("start", "relay", "--port", String(ports.cli));
    expect(started.stdout).toMatch(/relay :\d+ {2}started \(pid \d+\)/);
    const again = await cli("start", "relay", "--port", String(ports.cli));
    expect(again.stdout).toMatch(/already running/);
    const json = JSON.parse(
      (await cli("status", "relay", "--port", String(ports.cli), "--json")).stdout
    );
    expect(json[0]).toMatchObject({ name: "relay", running: true, managed: true });
    const stopped = await cli("stop", "relay", "--port", String(ports.cli));
    expect(stopped.stdout).toMatch(/stopped/);
  }, 90000);

  test("rejects unknown server names and --port with several servers", async () => {
    await expect(cli("start", "browser")).rejects.toMatchObject({ code: 2 });
    await expect(cli("start", "relay", "mcp", "--port", "1234")).rejects.toMatchObject({ code: 2 });
  });
});
