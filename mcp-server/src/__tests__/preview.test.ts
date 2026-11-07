import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PreviewManager } from "../preview.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function project(configurations: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-browser-preview-"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "launch.json"), JSON.stringify({ version: "0.0.1", configurations }));
  return dir;
}

const SERVER = `const http = require("http");
console.log("listening on " + process.env.PORT);
console.error("an error line");
http.createServer((q, r) => r.end("hi")).listen(process.env.PORT);`;

describe("PreviewManager", () => {
  test("starts a server, keeps its logs, reuses it, and stops it", async () => {
    const port = await freePort();
    const manager = new PreviewManager(
      project([{ name: "web", runtimeExecutable: process.execPath, runtimeArgs: ["-e", SERVER], port }])
    );
    const server = await manager.start("web");
    expect(server).toMatchObject({ status: "running", url: `http://localhost:${port}`, reused: false });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("hi");
    expect((await manager.start("web")).reused).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    expect(manager.logs(server.id)).toEqual([`listening on ${port}`, "[stderr] an error line"]);
    expect(manager.logs(server.id, { level: "error" })).toEqual(["[stderr] an error line"]);

    await manager.stop(server.id);
    expect(manager.list()).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  test("reports a server that exits before opening its port, with its output", async () => {
    const manager = new PreviewManager(
      project([
        {
          name: "broken",
          runtimeExecutable: process.execPath,
          runtimeArgs: ["-e", 'console.error("missing module"); process.exit(1)'],
          port: await freePort(),
        },
      ])
    );
    await expect(manager.start("broken")).rejects.toThrow(/exited before it opened its port[\s\S]*missing module/);
  });

  test("attaches to a url without starting anything", async () => {
    const manager = new PreviewManager(project([{ name: "remote", url: "http://localhost:4321" }]));
    expect(await manager.start("remote")).toMatchObject({ status: "running", url: "http://localhost:4321" });
  });

  test("names the missing file or configuration", async () => {
    await expect(new PreviewManager(mkdtempSync(join(tmpdir(), "none-"))).start("web")).rejects.toThrow(/launch\.json/);
    await expect(new PreviewManager(project([])).start("web")).rejects.toThrow(/No configuration named "web"/);
  });
});
