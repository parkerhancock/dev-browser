import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createWaczFromHar } from "../wacz";
import type { HarLog } from "../client";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PartialEntry = Record<string, any>;

// Helper to create a mock HAR with deep merging
function createMockHar(entries: PartialEntry[] = []): HarLog {
  const createDefaultEntry = () => ({
    startedDateTime: "2026-01-15T12:00:00.000Z",
    time: 100,
    request: {
      method: "GET",
      url: "https://example.com/",
      httpVersion: "HTTP/1.1",
      headers: [{ name: "User-Agent", value: "Test" }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [{ name: "Content-Type", value: "text/html" }],
      cookies: [],
      content: {
        size: 100,
        mimeType: "text/html",
        text: "<html><body>Test</body></html>",
      },
      headersSize: -1,
      bodySize: 100,
    },
    timings: { send: 1, wait: 50, receive: 49 },
  });

  type HarEntry = HarLog["log"]["entries"][0];

  // Deep merge function for HAR entries - merges partial into base
  function mergeEntry(base: ReturnType<typeof createDefaultEntry>, partial: PartialEntry): HarEntry {
    const merged = { ...base };

    if (partial.startedDateTime) merged.startedDateTime = partial.startedDateTime;
    if (partial.time !== undefined) merged.time = partial.time;
    if (partial.timings) merged.timings = { ...merged.timings, ...partial.timings };

    if (partial.request) {
      merged.request = {
        ...merged.request,
        ...partial.request,
        headers: partial.request.headers ?? merged.request.headers,
        queryString: partial.request.queryString ?? merged.request.queryString,
        cookies: partial.request.cookies ?? merged.request.cookies,
      };
    }

    if (partial.response) {
      merged.response = {
        ...merged.response,
        ...partial.response,
        headers: partial.response.headers ?? merged.response.headers,
        cookies: partial.response.cookies ?? merged.response.cookies,
        content: partial.response.content
          ? { ...merged.response.content, ...partial.response.content }
          : merged.response.content,
      };
    }

    return merged as unknown as HarEntry;
  }

  return {
    log: {
      version: "1.2",
      creator: { name: "test", version: "1.0" },
      entries: entries.length > 0
        ? entries.map((e) => mergeEntry(createDefaultEntry(), e))
        : [createDefaultEntry() as unknown as HarEntry],
    },
  };
}

let tempDir: string;
let waczPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wacz-test-"));
  waczPath = join(tempDir, "test.wacz");
});

afterEach(() => {
  if (existsSync(waczPath)) {
    unlinkSync(waczPath);
  }
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true });
  }
});

describe("WACZ Creation", () => {
  test("creates valid WACZ file", async () => {
    const har = createMockHar();

    await createWaczFromHar(har, waczPath);

    expect(existsSync(waczPath)).toBe(true);
  });

  test("WACZ contains required files", async () => {
    const har = createMockHar();

    await createWaczFromHar(har, waczPath);

    // List ZIP contents
    const contents = execSync(`unzip -l "${waczPath}"`, { encoding: "utf-8" });

    expect(contents).toContain("datapackage.json");
    expect(contents).toContain("archive/data.warc");
    expect(contents).toContain("indexes/index.cdx");
    expect(contents).toContain("pages/pages.jsonl");
  });

  test("datapackage.json has correct structure", async () => {
    const har = createMockHar();

    await createWaczFromHar(har, waczPath, {
      title: "Test Archive",
      description: "Test description",
    });

    const datapackage = JSON.parse(
      execSync(`unzip -p "${waczPath}" datapackage.json`, { encoding: "utf-8" })
    );

    expect(datapackage.profile).toBe("data-package");
    expect(datapackage.wacz_version).toBe("1.1.1");
    expect(datapackage.title).toBe("Test Archive");
    expect(datapackage.description).toBe("Test description");
    expect(datapackage.software).toBe("dev-browser/0.0.1");
    expect(datapackage.resources).toHaveLength(3);
    expect(datapackage.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("resources have hashes", async () => {
    const har = createMockHar();

    await createWaczFromHar(har, waczPath);

    const datapackage = JSON.parse(
      execSync(`unzip -p "${waczPath}" datapackage.json`, { encoding: "utf-8" })
    );

    for (const resource of datapackage.resources) {
      expect(resource.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(resource.bytes).toBeGreaterThan(0);
      expect(resource.path).toBeTruthy();
    }
  });

  test("WARC contains request and response records", async () => {
    const har = createMockHar();

    await createWaczFromHar(har, waczPath);

    const warc = execSync(`unzip -p "${waczPath}" archive/data.warc`, { encoding: "utf-8" });

    // Should have both request and response
    expect(warc).toContain("WARC-Type: request");
    expect(warc).toContain("WARC-Type: response");
    expect(warc).toContain("WARC-Target-URI: https://example.com/");
    expect(warc).toContain("WARC/1.1");
  });

  test("WARC contains request headers", async () => {
    const har = createMockHar([
      {
        request: {
          method: "GET",
          url: "https://example.com/test",
          httpVersion: "HTTP/1.1",
          headers: [
            { name: "User-Agent", value: "TestAgent/1.0" },
            { name: "Accept", value: "text/html" },
          ],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
      },
    ]);

    await createWaczFromHar(har, waczPath);

    const warc = execSync(`unzip -p "${waczPath}" archive/data.warc`, { encoding: "utf-8" });

    expect(warc).toContain("User-Agent: TestAgent/1.0");
    expect(warc).toContain("Accept: text/html");
  });

  test("WARC contains response body", async () => {
    const har = createMockHar([
      {
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/1.1",
          headers: [{ name: "Content-Type", value: "text/html" }],
          cookies: [],
          content: {
            size: 50,
            mimeType: "text/html",
            text: "<html><body>Custom Content Here</body></html>",
          },
          headersSize: -1,
          bodySize: 50,
        },
      },
    ]);

    await createWaczFromHar(har, waczPath);

    const warc = execSync(`unzip -p "${waczPath}" archive/data.warc`, { encoding: "utf-8" });

    expect(warc).toContain("Custom Content Here");
  });

  test("pages.jsonl contains HTML pages", async () => {
    const har = createMockHar([
      {
        request: { url: "https://example.com/page1" },
        response: { content: { mimeType: "text/html" } },
        startedDateTime: "2026-01-15T12:00:00.000Z",
      },
      {
        request: { url: "https://example.com/page2" },
        response: { content: { mimeType: "text/html" } },
        startedDateTime: "2026-01-15T12:01:00.000Z",
      },
      {
        request: { url: "https://example.com/style.css" },
        response: { content: { mimeType: "text/css" } },
        startedDateTime: "2026-01-15T12:02:00.000Z",
      },
    ]);

    await createWaczFromHar(har, waczPath);

    const pages = execSync(`unzip -p "${waczPath}" pages/pages.jsonl`, { encoding: "utf-8" });
    const lines = pages.trim().split("\n").map((l) => JSON.parse(l));

    // Should only include HTML pages, not CSS
    expect(lines.length).toBe(2);
    expect(lines[0].url).toBe("https://example.com/page1");
    expect(lines[1].url).toBe("https://example.com/page2");
  });

  test("CDX index has entries", async () => {
    const har = createMockHar([
      { request: { url: "https://example.com/page1" } },
      { request: { url: "https://example.com/page2" } },
    ]);

    await createWaczFromHar(har, waczPath);

    const cdx = execSync(`unzip -p "${waczPath}" indexes/index.cdx`, { encoding: "utf-8" });
    const lines = cdx.trim().split("\n");

    expect(lines.length).toBe(2);

    const entry = JSON.parse(lines[0]!);
    expect(entry.url).toContain("example.com");
    expect(entry.filename).toBe("data.warc");
  });

  test("handles empty HAR", async () => {
    const har: HarLog = {
      log: {
        version: "1.2",
        creator: { name: "test", version: "1.0" },
        entries: [],
      },
    };

    await createWaczFromHar(har, waczPath);

    expect(existsSync(waczPath)).toBe(true);

    const datapackage = JSON.parse(
      execSync(`unzip -p "${waczPath}" datapackage.json`, { encoding: "utf-8" })
    );
    expect(datapackage.resources).toHaveLength(3);
  });

  test("handles POST requests with body", async () => {
    const har = createMockHar([
      {
        request: {
          method: "POST",
          url: "https://example.com/api",
          httpVersion: "HTTP/1.1",
          headers: [{ name: "Content-Type", value: "application/json" }],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: 20,
          postData: {
            mimeType: "application/json",
            text: '{"key":"value"}',
          },
        },
      },
    ]);

    await createWaczFromHar(har, waczPath);

    const warc = execSync(`unzip -p "${waczPath}" archive/data.warc`, { encoding: "utf-8" });

    expect(warc).toContain("POST /api HTTP/1.1");
    expect(warc).toContain('{"key":"value"}');
  });

  test("handles query strings in URL", async () => {
    const har = createMockHar([
      {
        request: {
          url: "https://example.com/search?q=test&page=1",
          queryString: [
            { name: "q", value: "test" },
            { name: "page", value: "1" },
          ],
        },
      },
    ]);

    await createWaczFromHar(har, waczPath);

    const warc = execSync(`unzip -p "${waczPath}" archive/data.warc`, { encoding: "utf-8" });

    expect(warc).toContain("GET /search?q=test&page=1");
    expect(warc).toContain("WARC-Target-URI: https://example.com/search?q=test&page=1");
  });
});
