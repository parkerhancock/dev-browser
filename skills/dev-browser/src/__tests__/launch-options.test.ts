/**
 * Standalone launch options: proxy (with credentials), locale, time zone,
 * and the error for a profile another browser already holds.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-launch-test-"));

import { serve, type DevBrowserServer } from "../index.js";
import { connect, type DevBrowserClient } from "../client.js";
import { loadToken } from "../auth.js";
import { parseProxyUrl } from "../types.js";

const port = 24000 + Math.floor(Math.random() * 4000);

describe("parseProxyUrl", () => {
  test("splits credentials out of the URL", () => {
    expect(parseProxyUrl("http://ada:p%40ss@proxy.example:8080", ".internal")).toEqual({
      server: "http://proxy.example:8080",
      username: "ada",
      password: "p@ss",
      bypass: ".internal",
    });
    expect(parseProxyUrl("proxy.example:3128")).toEqual({ server: "http://proxy.example:3128" });
  });
});

describe("standalone launch options", () => {
  let proxy: Server;
  const seen: string[] = [];
  let server: DevBrowserServer;
  let client: DevBrowserClient;
  const profileDir = mkdtempSync(join(tmpdir(), "dev-browser-launch-profile-"));

  beforeAll(async () => {
    // A forward proxy that requires credentials and answers every request itself
    proxy = createServer((req, res) => {
      const auth = req.headers["proxy-authorization"];
      if (auth !== `Basic ${Buffer.from("ada:secret").toString("base64")}`) {
        res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
        res.end();
        return;
      }
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>via proxy</title>");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    server = await serve({
      port,
      cdpPort: port + 4000,
      headless: true,
      profileDir,
      proxy: { server: `http://127.0.0.1:${proxyPort}`, username: "ada", password: "secret" },
      locale: "de-DE",
      timezoneId: "Asia/Tokyo",
    });
    client = await connect(`http://127.0.0.1:${port}`, { session: "launch", token: loadToken()! });
  });

  afterAll(async () => {
    await client?.disconnect();
    await server?.stop();
    proxy?.close();
  });

  test("sends traffic through an authenticating proxy", async () => {
    const page = await client.page("p");
    await page.goto("http://site.example/path");
    expect(await page.title()).toBe("via proxy");
    expect(seen).toContain("http://site.example/path");
  });

  test("applies locale and time zone", async () => {
    const page = await client.page("p");
    const env = await page.evaluate<string[]>(
      "[navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone]"
    );
    expect(env).toEqual(["de-DE", "Asia/Tokyo"]);
  });

  test("a second server on the same profile gets a clear error", async () => {
    await expect(
      serve({ port: port + 1, cdpPort: port + 4001, headless: true, profileDir })
    ).rejects.toThrow(/already in use/);
  });
});
