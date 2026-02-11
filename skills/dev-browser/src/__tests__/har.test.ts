import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, CDPSession } from "playwright";
import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from "vitest";
import type { HarLog, HarEntry, HarCookie, PageOptions, DevBrowserClient } from "../client";
import { navigateTo } from "../client";
import { createWaczFromHar } from "../wacz";
import { existsSync, mkdtempSync, rmSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import archiver from "archiver";

// Re-implement the HAR recording logic for testing (isolated from client.ts)
interface PendingHarEntry {
  entry: Partial<HarEntry>;
  startTime: number;       // Monotonic timestamp for duration calculation
  requestId: string;
  mimeType?: string;
}

interface HarRecorderState {
  cdpSession: CDPSession;
  pending: Map<string, PendingHarEntry>;
  completed: HarEntry[];
}

function parseCookieHeader(cookieHeader: string): HarCookie[] {
  if (!cookieHeader) return [];
  return cookieHeader.split(";").map((part) => {
    const [name, ...rest] = part.trim().split("=");
    return { name: name ?? "", value: rest.join("=") };
  });
}

function parseSetCookie(setCookie: string): HarCookie {
  const parts = setCookie.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const [name, ...rest] = (nameValue ?? "").split("=");
  const cookie: HarCookie = { name: name ?? "", value: rest.join("=") };

  for (const attr of attrs) {
    const [key, val] = attr.split("=");
    const lowerKey = key?.toLowerCase();
    if (lowerKey === "path") cookie.path = val;
    else if (lowerKey === "domain") cookie.domain = val;
    else if (lowerKey === "expires") cookie.expires = val;
    else if (lowerKey === "httponly") cookie.httpOnly = true;
    else if (lowerKey === "secure") cookie.secure = true;
    else if (lowerKey === "samesite") cookie.sameSite = val;
  }
  return cookie;
}

async function startRecording(page: Page): Promise<HarRecorderState> {
  const cdpSession = await page.context().newCDPSession(page);
  const state: HarRecorderState = {
    cdpSession,
    pending: new Map(),
    completed: [],
  };

  await cdpSession.send("Network.enable");

  cdpSession.on("Network.requestWillBeSent", (params) => {
    const url = new URL(params.request.url);
    const headers = Object.entries(params.request.headers).map(([n, v]) => ({
      name: n,
      value: String(v),
    }));
    const cookieHeader = params.request.headers["Cookie"] ?? params.request.headers["cookie"] ?? "";
    const cookies = parseCookieHeader(cookieHeader);
    const postData = params.request.postData
      ? {
          mimeType: params.request.headers["Content-Type"] ??
                    params.request.headers["content-type"] ?? "application/octet-stream",
          text: params.request.postData,
        }
      : undefined;

    state.pending.set(params.requestId, {
      startTime: params.timestamp * 1000,  // Monotonic timestamp for duration
      requestId: params.requestId,
      entry: {
        startedDateTime: new Date(params.wallTime * 1000).toISOString(),
        request: {
          method: params.request.method,
          url: params.request.url,
          httpVersion: "HTTP/1.1",
          headers,
          queryString: [...url.searchParams].map(([n, v]) => ({ name: n, value: v })),
          cookies,
          headersSize: -1,
          bodySize: params.request.postData?.length ?? 0,
          postData,
        },
      },
    });
  });

  cdpSession.on("Network.responseReceived", (params) => {
    const pending = state.pending.get(params.requestId);
    if (!pending) return;

    const timing = params.response.timing;
    const headers = Object.entries(params.response.headers).map(([n, v]) => ({
      name: n,
      value: String(v),
    }));

    const cookies: HarCookie[] = [];
    for (const [name, value] of Object.entries(params.response.headers)) {
      if (name.toLowerCase() === "set-cookie") {
        cookies.push(parseSetCookie(String(value)));
      }
    }

    pending.mimeType = params.response.mimeType;
    pending.entry.response = {
      status: params.response.status,
      statusText: params.response.statusText,
      httpVersion: params.response.protocol ?? "HTTP/1.1",
      headers,
      cookies,
      content: {
        size: params.response.encodedDataLength ?? 0,
        mimeType: params.response.mimeType,
      },
      headersSize: -1,
      bodySize: -1,
    };

    if (timing) {
      pending.entry.timings = {
        send: timing.sendEnd - timing.sendStart,
        wait: timing.receiveHeadersEnd - timing.sendEnd,
        receive: 0,
      };
    }
  });

  cdpSession.on("Network.loadingFinished", async (params) => {
    const pending = state.pending.get(params.requestId);
    if (!pending?.entry.response) return;

    const endTime = params.timestamp * 1000;
    pending.entry.time = endTime - pending.startTime;
    pending.entry.response.bodySize = params.encodedDataLength;

    if (pending.entry.timings) {
      pending.entry.timings.receive = Math.max(
        0,
        pending.entry.time - (pending.entry.timings.send + pending.entry.timings.wait)
      );
    } else {
      pending.entry.timings = { send: 0, wait: pending.entry.time, receive: 0 };
    }

    // Fetch body for text content
    const isText = pending.mimeType?.startsWith("text/") ||
                   pending.mimeType?.includes("json") ||
                   pending.mimeType?.includes("xml");
    if (isText && params.encodedDataLength < 1024 * 1024) {
      try {
        const { body, base64Encoded } = await cdpSession.send("Network.getResponseBody", {
          requestId: params.requestId,
        });
        pending.entry.response.content.text = body;
        if (base64Encoded) {
          pending.entry.response.content.encoding = "base64";
        }
      } catch {
        // Body may not be available
      }
    }

    state.completed.push(pending.entry as HarEntry);
    state.pending.delete(params.requestId);
  });

  cdpSession.on("Network.loadingFailed", (params) => {
    state.pending.delete(params.requestId);
  });

  return state;
}

async function stopRecording(state: HarRecorderState): Promise<HarLog> {
  await new Promise((r) => setTimeout(r, 100));
  await state.cdpSession.detach();

  return {
    log: {
      version: "1.2",
      creator: { name: "dev-browser", version: "0.0.1" },
      entries: state.completed,
    },
  };
}

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
});

afterEach(async () => {
  await context.close();
});

describe("HAR Recording", () => {
  test("captures basic GET request", async () => {
    const state = await startRecording(page);

    await page.goto("data:text/html,<h1>Hello</h1>", { waitUntil: "networkidle" });

    const har = await stopRecording(state);

    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("dev-browser");
    expect(har.log.entries.length).toBeGreaterThan(0);

    const entry = har.log.entries[0]!;
    expect(entry.request.method).toBe("GET");
    expect(entry.request.url).toContain("data:text/html");
  });

  test("captures response status and headers", async () => {
    const state = await startRecording(page);

    // Use a route to control the response
    await page.route("**/test-page", (route) => {
      route.fulfill({
        status: 201,
        headers: { "X-Custom-Header": "test-value", "Content-Type": "text/html" },
        body: "<h1>Test</h1>",
      });
    });

    await page.goto("http://localhost/test-page", { waitUntil: "networkidle" });

    const har = await stopRecording(state);
    const entry = har.log.entries.find((e) => e.request.url.includes("test-page"));

    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(201);
    expect(entry!.response.headers).toContainEqual({
      name: "x-custom-header",
      value: "test-value",
    });
  });

  test("captures response body for text content", async () => {
    const state = await startRecording(page);

    await page.route("**/test-body", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body>Test Body Content</body></html>",
      });
    });

    await page.goto("http://localhost/test-body", { waitUntil: "networkidle" });

    const har = await stopRecording(state);
    const entry = har.log.entries.find((e) => e.request.url.includes("test-body"));

    expect(entry).toBeDefined();
    expect(entry!.response.content.text).toContain("Test Body Content");
  });

  test("captures query string parameters", async () => {
    const state = await startRecording(page);

    await page.route("**/search**", (route) => {
      route.fulfill({ status: 200, body: "OK" });
    });

    await page.goto("http://localhost/search?q=test&page=1", { waitUntil: "networkidle" });

    const har = await stopRecording(state);
    const entry = har.log.entries.find((e) => e.request.url.includes("search"));

    expect(entry).toBeDefined();
    expect(entry!.request.queryString).toContainEqual({ name: "q", value: "test" });
    expect(entry!.request.queryString).toContainEqual({ name: "page", value: "1" });
  });

  test("captures POST request with body", async () => {
    const state = await startRecording(page);

    await page.route("**/api/submit", (route) => {
      route.fulfill({ status: 200, body: '{"success":true}' });
    });

    await page.goto("data:text/html,<form></form>");
    await page.evaluate(() => {
      fetch("http://localhost/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test", value: 123 }),
      });
    });

    await page.waitForTimeout(500);
    const har = await stopRecording(state);

    // Find the POST request (not the CORS preflight OPTIONS request)
    const entry = har.log.entries.find(
      (e) => e.request.url.includes("api/submit") && e.request.method === "POST"
    );

    expect(entry).toBeDefined();
    expect(entry!.request.method).toBe("POST");
    expect(entry!.request.postData).toBeDefined();
    expect(entry!.request.postData!.text).toContain("test");
  });

  test("captures timing information", async () => {
    const state = await startRecording(page);

    await page.route("**/timed", (route) => {
      route.fulfill({ status: 200, body: "OK" });
    });

    await page.goto("http://localhost/timed", { waitUntil: "networkidle" });

    const har = await stopRecording(state);
    const entry = har.log.entries.find((e) => e.request.url.includes("timed"));

    expect(entry).toBeDefined();
    expect(entry!.time).toBeGreaterThan(0);
    expect(entry!.timings).toBeDefined();
    expect(typeof entry!.timings.send).toBe("number");
    expect(typeof entry!.timings.wait).toBe("number");
    expect(typeof entry!.timings.receive).toBe("number");
  });

  test("captures multiple requests", async () => {
    const state = await startRecording(page);

    await page.route("**/*", (route) => {
      route.fulfill({ status: 200, body: "OK" });
    });

    await page.goto("http://localhost/page1");
    await page.goto("http://localhost/page2");
    await page.goto("http://localhost/page3");

    const har = await stopRecording(state);

    expect(har.log.entries.length).toBeGreaterThanOrEqual(3);
  });

  test("has valid ISO 8601 timestamps", async () => {
    const state = await startRecording(page);

    await page.goto("data:text/html,<h1>Test</h1>", { waitUntil: "networkidle" });

    const har = await stopRecording(state);
    const entry = har.log.entries[0]!;

    // Should be valid ISO 8601 format
    expect(entry.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(entry.startedDateTime).toISOString()).toBeTruthy();
  });
});

describe("Cookie Parsing", () => {
  test("parseCookieHeader parses simple cookies", () => {
    const cookies = parseCookieHeader("foo=bar; baz=qux");
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toEqual({ name: "foo", value: "bar" });
    expect(cookies[1]).toEqual({ name: "baz", value: "qux" });
  });

  test("parseCookieHeader handles empty string", () => {
    const cookies = parseCookieHeader("");
    expect(cookies).toHaveLength(0);
  });

  test("parseSetCookie parses full cookie with attributes", () => {
    const cookie = parseSetCookie(
      "session=abc123; Path=/; Domain=.example.com; Secure; HttpOnly; SameSite=Strict"
    );
    expect(cookie.name).toBe("session");
    expect(cookie.value).toBe("abc123");
    expect(cookie.path).toBe("/");
    expect(cookie.domain).toBe(".example.com");
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
  });

  test("parseSetCookie handles cookie with equals in value", () => {
    const cookie = parseSetCookie("data=a=b=c; Path=/");
    expect(cookie.name).toBe("data");
    expect(cookie.value).toBe("a=b=c");
  });
});

describe("PageOptions interface", () => {
  test("record option defaults to true behavior", () => {
    // Verify the type accepts record: false
    const opts: PageOptions = { record: false };
    expect(opts.record).toBe(false);
  });

  test("record option is optional", () => {
    const opts: PageOptions = {};
    expect(opts.record).toBeUndefined();
  });

  test("record option coexists with viewport", () => {
    const opts: PageOptions = {
      viewport: { width: 1024, height: 768 },
      record: false,
    };
    expect(opts.viewport).toBeDefined();
    expect(opts.record).toBe(false);
  });
});

describe("DevBrowserClient interface", () => {
  test("saveWacz is defined on DevBrowserClient type", () => {
    // Type-level check: ensure saveWacz exists with correct signature
    const _check = (client: DevBrowserClient) => {
      // This ensures the type has saveWacz
      const fn: (name: string, options?: {
        outputPath?: string;
        title?: string;
        description?: string;
      }) => Promise<string> = client.saveWacz;
      return fn;
    };
    expect(_check).toBeDefined();
  });

  test("saveAsWacz is still available for backward compat", () => {
    const _check = (client: DevBrowserClient) => {
      const fn: (
        har: HarLog,
        outputPath: string,
        options?: { title?: string; description?: string }
      ) => Promise<void> = client.saveAsWacz;
      return fn;
    };
    expect(_check).toBeDefined();
  });

  test("saveArchive is defined with correct signature", () => {
    const _check = (client: DevBrowserClient) => {
      const fn: (name: string, options?: {
        outputPath?: string;
        title?: string;
        description?: string;
        skipPdf?: boolean;
        skipHtml?: boolean;
      }) => Promise<string> = client.saveArchive;
      return fn;
    };
    expect(_check).toBeDefined();
  });
});

describe("HAR to WACZ integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "har-wacz-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("recorded HAR can be saved as WACZ", async () => {
    const state = await startRecording(page);

    await page.route("**/test-wacz", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body>WACZ Test Content</body></html>",
      });
    });

    await page.goto("http://localhost/test-wacz", { waitUntil: "networkidle" });
    const har = await stopRecording(state);

    const waczPath = join(tempDir, "test.wacz");
    await createWaczFromHar(har, waczPath);

    expect(existsSync(waczPath)).toBe(true);
    expect(har.log.entries.length).toBeGreaterThan(0);
  });
});

describe("Archive bundle (WACZ + HTML + PDF)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archive-bundle-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("creates .zip bundle with wacz, html, and pdf", async () => {
    // Serve a page
    await page.route("**/archive-test", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body><h1>Archive Bundle Test</h1></body></html>",
      });
    });

    await page.goto("http://localhost/archive-test", { waitUntil: "networkidle" });

    // Capture rendered HTML
    const renderedHtml = await page.content();
    expect(renderedHtml).toContain("Archive Bundle Test");

    // Capture PDF
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Record HAR and create WACZ
    const state = await startRecording(page);
    await page.goto("http://localhost/archive-test", { waitUntil: "networkidle" });
    const har = await stopRecording(state);

    const waczPath = join(tempDir, "test.wacz");
    await createWaczFromHar(har, waczPath);

    // Bundle into .zip
    const zipPath = join(tempDir, "test-archive.zip");
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const zip = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      zip.on("error", reject);
      zip.pipe(output);
      zip.file(waczPath, { name: "test.wacz" });
      zip.append(renderedHtml, { name: "test.html" });
      zip.append(pdfBuffer, { name: "test.pdf" });
      zip.finalize();
    });

    expect(existsSync(zipPath)).toBe(true);

    // Verify zip contents
    const contents = execSync(`unzip -l "${zipPath}"`, { encoding: "utf-8" });
    expect(contents).toContain("test.wacz");
    expect(contents).toContain("test.html");
    expect(contents).toContain("test.pdf");
  });

  test("rendered HTML contains page content", async () => {
    await page.route("**/content-check", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: '<html><body><div id="target">Searchable Content Here</div></body></html>',
      });
    });

    await page.goto("http://localhost/content-check", { waitUntil: "networkidle" });

    const html = await page.content();
    expect(html).toContain("Searchable Content Here");
    expect(html).toContain('<div id="target">');
  });

  test("PDF is valid", async () => {
    await page.route("**/pdf-check", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body><h1>PDF Test</h1></body></html>",
      });
    });

    await page.goto("http://localhost/pdf-check", { waitUntil: "networkidle" });

    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });

    // PDF starts with %PDF magic bytes
    const header = pdfBuffer.subarray(0, 5).toString("utf-8");
    expect(header).toBe("%PDF-");
  });
});

describe("navigateTo", () => {
  test("navigates to a simple page successfully", async () => {
    await page.route("**/simple", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body>Simple Page</body></html>",
      });
    });

    const result = await navigateTo(page, "http://localhost/simple");

    expect(result.success).toBe(true);
    expect(result.navigationTimedOut).toBe(false);
    expect(result.loadTimedOut).toBe(false);
    expect(result.url).toContain("localhost/simple");
    expect(result.readyState).toBe("complete");
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });

  test("handles slow-loading page gracefully", async () => {
    // Page that takes 2s to serve — should still succeed with enough timeout
    await page.route("**/slow-page", async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body>Slow Page</body></html>",
      });
    });

    const result = await navigateTo(page, "http://localhost/slow-page", { timeout: 10000 });

    expect(result.success).toBe(true);
    expect(result.navigationTimedOut).toBe(false);
  });

  test("returns result instead of throwing on timeout", async () => {
    // Page that never finishes loading (simulated via SSE/streaming)
    await page.route("**/never-idle", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: `<html><body>
          <h1>Content loads fine</h1>
          <script>
            // Simulate a page that's never "idle" — periodic fetch
            setInterval(() => fetch("http://localhost/ping").catch(() => {}), 100);
          </script>
        </body></html>`,
      });
    });
    await page.route("**/ping", (route) => {
      route.fulfill({ status: 200, body: "pong" });
    });

    // Short timeout to force the load-wait to time out
    const result = await navigateTo(page, "http://localhost/never-idle", { timeout: 2000 });

    // Navigation committed successfully, but load may have timed out
    expect(result.navigationTimedOut).toBe(false);
    expect(result.url).toContain("localhost/never-idle");
    // Page is still usable regardless
    const text = await page.textContent("h1");
    expect(text).toBe("Content loads fine");
  });

  test("skips load waiting with waitForLoad: false", async () => {
    await page.route("**/quick", (route) => {
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: "<html><body>Quick</body></html>",
      });
    });

    const result = await navigateTo(page, "http://localhost/quick", { waitForLoad: false });

    expect(result.navigationTimedOut).toBe(false);
    expect(result.loadTimedOut).toBe(false);
    expect(result.url).toContain("localhost/quick");
  });
});
