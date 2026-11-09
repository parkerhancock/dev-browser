/**
 * Integration tests for the remote-ready standalone server: token auth on
 * every request, the authenticated /cdp WebSocket proxy (Chromium's raw
 * debug endpoint is never dialed by the client), and server-side download
 * tracking with byte retrieval — the pieces a Docker/remote deployment needs.
 *
 * Launches a real headless Chromium once for the whole file.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-remote-test-"));

import { serve, type DevBrowserServer } from "../index.js";
import { connect, type DevBrowserClient } from "../client.js";
import { loadToken, TOKEN_HEADER } from "../auth.js";
import { fetchPage } from "../fetch.js";

const port = 19000 + Math.floor(Math.random() * 5000);
const cdpPort = port + 5000;

describe("Remote-ready standalone server", () => {
  let server: DevBrowserServer;
  let client: DevBrowserClient | null = null;

  beforeAll(async () => {
    server = await serve({
      port,
      cdpPort,
      host: "127.0.0.1",
      headless: true,
      profileDir: mkdtempSync(join(tmpdir(), "dev-browser-remote-profile-")),
    });
  });

  afterAll(async () => {
    if (client) await client.disconnect();
    await server.stop();
  });

  test("rejects requests without the token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(401);
  });

  test("accepts the token and advertises the /cdp proxy", async () => {
    const token = loadToken()!;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { [TOKEN_HEADER]: token },
    });
    expect(res.status).toBe(200);
    const info = (await res.json()) as { wsEndpoint: string; wsPath?: string };
    expect(info.wsPath).toBe("/cdp");
    // The advertised endpoint is the proxy on our own port, not Chromium's
    expect(info.wsEndpoint).toContain(`:${port}/cdp`);
    expect(info.wsEndpoint).not.toContain(String(cdpPort));
  });

  test("drives a page through the authenticated CDP proxy", async () => {
    client = await connect(`http://127.0.0.1:${port}`, {
      session: "remote-test",
      token: loadToken()!,
    });
    const page = await client.page("proxied");
    await page.goto("data:text/html,<h1>proxied</h1>");
    expect(await page.locator("h1").textContent()).toBe("proxied");
  });

  test("headless pages don't announce HeadlessChrome", async () => {
    const page = await client!.page("proxied");
    const userAgent = await page.evaluate<string>("navigator.userAgent");
    expect(userAgent).not.toContain("Headless");
    expect(userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
  });

  test("headless pages look like a normal browser", async () => {
    const page = await client!.page("proxied");
    const env = await page.evaluate<{
      webdriver: boolean;
      brands: string[];
      width: number;
      height: number;
    }>(`({
      webdriver: navigator.webdriver,
      brands: (navigator.userAgentData?.brands ?? []).map((b) => b.brand),
      width: innerWidth,
      height: innerHeight,
    })`);
    expect(env.webdriver).toBe(false);
    expect(env.brands.join(" ")).not.toContain("Headless");
    expect([env.width, env.height]).toEqual([1440, 900]);
  });

  test("console capture includes messages logged before the first read", async () => {
    const page = await client!.page("console");
    await page.goto("data:text/html,<script>console.log('early message')</script>");
    const { messages } = await client!.getConsoleMessages("console");
    expect(messages.map((m) => m.text)).toContain("early message");
  });

  test("opening another page leaves earlier pages visible", async () => {
    const first = await client!.page("proxied");
    await client!.page("console");
    expect(await first.evaluate<string>("document.visibilityState")).toBe("visible");
  });

  test("scripts still leave a page with unsaved changes, and alerts don't block", async () => {
    const page = await client!.page("unsaved");
    await page.goto(
      "data:text/html,<textarea id=t></textarea><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; })</script>"
    );
    await page.click("#t");
    await page.keyboard.type("draft");
    await page.goto("data:text/html,<h1>next</h1>");
    expect(await page.locator("h1").textContent()).toBe("next");
    // An alert with no listener anywhere is answered, at the latest by the server's fallback
    await page.evaluate("setTimeout(() => alert('hi'), 0)");
    await page.evaluate("1");
    await client!.close("unsaved");
  });

  test("tracks downloads server-side and serves the bytes", async () => {
    const page = await client!.page("proxied");
    await page.goto(
      'data:text/html,<a id="dl" href="data:text/plain,hello-remote" download="hi.txt">dl</a>'
    );
    const before = Date.now();
    await page.click("#dl");

    const record = await client!.waitForDownload({ since: before - 1000 });
    expect(record.state).toBe("completed");
    expect(record.suggestedFilename).toBe("hi.txt");

    // Fetch the bytes over HTTP — the remote-client path (record.path is a
    // path on the server's machine).
    const dest = join(process.env.DEV_BROWSER_DIR!, "saved.txt");
    await client!.saveDownload(record.id, dest);
    expect(readFileSync(dest, "utf8")).toBe("hello-remote");

    // Downloads are session-scoped in standalone mode
    const token = loadToken()!;
    const other = await fetch(`http://127.0.0.1:${port}/downloads`, {
      headers: { [TOKEN_HEADER]: token, "X-DevBrowser-Session": "someone-else" },
    });
    expect(((await other.json()) as { downloads: unknown[] }).downloads).toEqual([]);
  });

  describe("fetchPage", () => {
    let site: Server;
    let origin = "";
    beforeAll(async () => {
      site = createServer((req, res) => {
        if (req.url === "/blocked") {
          res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
          res.end("<title>Just a moment...</title><p>Checking your browser</p>");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          "<title>Article</title><nav>menu</nav><article><h1>Heading</h1><p>" +
            "Body text. ".repeat(40) +
            '<a href="/next">next</a></p></article>'
        );
      });
      await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
      const address = site.address() as { port: number };
      origin = `http://127.0.0.1:${address.port}`;
    });
    afterAll(() => {
      site.close();
    });

    test("returns the main content as Markdown with absolute links", async () => {
      const result = await fetchPage(client!, `${origin}/article`);
      expect(result).toMatchObject({ status: 200, title: "Article", challenge: null });
      expect(result.content).toContain("# Heading");
      expect(result.content).toContain(`[next](${origin}/next)`);
      expect(result.content).not.toContain("menu");
    });

    test("reports a challenge that doesn't clear", async () => {
      const result = await fetchPage(client!, `${origin}/blocked`, { challengeWait: 500 });
      expect(result.status).toBe(403);
      expect(result.challenge).toMatchObject({ vendor: "cloudflare" });
    });

    test("reports a DNS failure without throwing", async () => {
      const result = await fetchPage(client!, "https://nope.invalid/");
      expect(result.error?.kind).toBe("dns");
      expect(result.content).toBe("");
    });
  });
});
