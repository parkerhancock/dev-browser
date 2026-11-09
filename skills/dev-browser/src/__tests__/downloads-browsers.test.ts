/**
 * Integration tests for the extension-side parity remainder:
 * downloads (P1 #8) and browser labeling (P1 #10b).
 *
 * Uses its own relay instance and an isolated DEV_BROWSER_DIR so the
 * generated token/persistence never touch the user's real ~/.dev-browser.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { serveRelay, type RelayServer, type DownloadRecord } from "../relay.js";
import { loadToken, TOKEN_HEADER } from "../auth.js";
import { MockExtension, randomPort, fetchJson } from "./mock-extension.js";

process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-downloads-test-"));

describe("Browser labeling (#10b) and downloads (#8)", () => {
  let relay: RelayServer;
  let port: number;
  let ext: MockExtension;

  beforeAll(async () => {
    port = randomPort();
    relay = await serveRelay({ port, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (ext) await ext.disconnect();
    await relay.stop();
  });

  test("/browsers is empty before an extension connects", async () => {
    const { status, body } = await fetchJson(port, "/browsers");
    expect(status).toBe(200);
    expect(body.browsers).toEqual([]);
  });

  test("extension connection without browserInfo reports unknown", async () => {
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 100));

    const { body } = await fetchJson(port, "/browsers");
    const browsers = body.browsers as Array<{ browser: string; connected: boolean }>;
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.browser).toBe("unknown");
    expect(browsers[0]!.connected).toBe(true);
  });

  test("browserInfo labels the connection in /browsers and /health", async () => {
    ext.sendBrowserInfo("msedge", "131.0.0.0", "Mozilla/5.0 test");
    await new Promise((r) => setTimeout(r, 100));

    const browsersRes = await fetchJson(port, "/browsers");
    const browsers = browsersRes.body.browsers as Array<{
      browser: string;
      version?: string;
      connected: boolean;
    }>;
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.browser).toBe("msedge");
    expect(browsers[0]!.version).toBe("131.0.0.0");

    const healthRes = await fetchJson(port, "/health");
    expect(healthRes.body.browser).toBe("msedge");
  });

  test("download events are tracked and listed with since filtering", async () => {
    const before = Date.now();
    ext.sendDownloadEvent({
      id: 7,
      url: "https://example.com/report.pdf",
      state: "inProgress",
      startTime: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));

    let { body } = await fetchJson(port, "/downloads");
    let list = body.downloads as DownloadRecord[];
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(7);
    expect(list[0]!.state).toBe("inProgress");

    // Completion updates the same record in place
    const filePath = join(process.env.DEV_BROWSER_DIR!, "report.pdf");
    writeFileSync(filePath, "PDF-BYTES");
    ext.sendDownloadEvent({
      id: 7,
      url: "https://example.com/report.pdf",
      filename: filePath,
      state: "completed",
      fileSize: 9,
      mime: "application/pdf",
    });
    await new Promise((r) => setTimeout(r, 100));

    ({ body } = await fetchJson(port, "/downloads"));
    list = body.downloads as DownloadRecord[];
    expect(list).toHaveLength(1);
    expect(list[0]!.state).toBe("completed");
    expect(list[0]!.path).toBe(filePath);
    expect(list[0]!.fileSize).toBe(9);
    expect(list[0]!.startedAt).toBeGreaterThanOrEqual(before - 1000);

    // since far in the future filters it out
    ({ body } = await fetchJson(port, `/downloads?since=${Date.now() + 60_000}`));
    expect(body.downloads).toEqual([]);
  });

  test("GET /download/:id serves the file bytes without deleting it", async () => {
    const token = loadToken()!;
    const res = await fetch(`http://127.0.0.1:${port}/download/7`, {
      headers: { [TOKEN_HEADER]: token },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PDF-BYTES");

    // Still servable — the relay never deletes the user's file
    const again = await fetch(`http://127.0.0.1:${port}/download/7`, {
      headers: { [TOKEN_HEADER]: token },
    });
    expect(again.status).toBe(200);
  });

  test("GET /download/:id refuses incomplete and unknown downloads", async () => {
    ext.sendDownloadEvent({
      id: 8,
      url: "https://example.com/big.zip",
      state: "inProgress",
    });
    await new Promise((r) => setTimeout(r, 100));

    const { status: inProgressStatus } = await fetchJson(port, "/download/8");
    expect(inProgressStatus).toBe(409);

    const { status: unknownStatus } = await fetchJson(port, "/download/999");
    expect(unknownStatus).toBe(404);
  });

  test("a replacing extension connection resets the browser label", async () => {
    const ext2 = new MockExtension(port);
    await ext2.connect();
    await new Promise((r) => setTimeout(r, 100));

    const { body } = await fetchJson(port, "/browsers");
    const browsers = body.browsers as Array<{ browser: string }>;
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.browser).toBe("unknown"); // label cleared until ext2 identifies

    ext2.sendBrowserInfo("chrome", "131.0.0.0");
    await new Promise((r) => setTimeout(r, 100));
    const after = await fetchJson(port, "/browsers");
    expect((after.body.browsers as Array<{ browser: string }>)[0]!.browser).toBe("chrome");

    // Download metadata survives the reconnect
    const dl = await fetchJson(port, "/downloads");
    expect((dl.body.downloads as DownloadRecord[]).length).toBeGreaterThan(0);

    ext = ext2; // afterAll cleans up the live connection
  });
});
