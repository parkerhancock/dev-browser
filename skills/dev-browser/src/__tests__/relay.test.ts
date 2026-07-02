/**
 * Integration tests for the CDP Relay Server.
 *
 * Tests the relay's HTTP API and WebSocket protocol using a mock extension.
 * No real browser needed — we simulate CDP events that the extension would send.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { serveRelay, type RelayServer } from "../relay.js";
import { connect } from "../client.js";
import { getAgentSession } from "../types.js";
import type { Context } from "hono";
import { MockExtension, randomPort, fetchJson } from "./mock-extension.js";

// Isolate persistence (pages.json) from the user's real ~/.dev-browser so
// running tests never prunes real persisted pages. Resolved lazily by
// persistence.ts, so setting it before the relay starts is sufficient.
process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-relay-test-"));

// ============================================================================
// Tests
// ============================================================================

describe("Relay Server", () => {
  let relay: RelayServer;
  let port: number;
  let ext: MockExtension;

  beforeAll(async () => {
    port = randomPort();
    relay = await serveRelay({ port, host: "127.0.0.1" });
    // Connect extension once for all tests (tests use unique session names for isolation)
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));
  });

  afterAll(async () => {
    await ext.disconnect();
    await relay.stop();
  });

  // --------------------------------------------------------------------------
  // Server Info
  // --------------------------------------------------------------------------

  describe("server info", () => {
    test("GET / returns server info with extension connected", async () => {
      const { body } = await fetchJson(port, "/");
      expect(body.mode).toBe("extension");
      expect(body.extensionConnected).toBe(true);
      expect(body.wsEndpoint).toContain("ws://");
    });
  });

  // --------------------------------------------------------------------------
  // Page Lifecycle
  // --------------------------------------------------------------------------

  describe("page lifecycle", () => {
    test("POST /pages creates a page and returns target info", async () => {
      const { status, body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-page" }),
        session: "test-session",
      });

      expect(status).toBe(200);
      expect(body.name).toBe("test-page");
      expect(body.targetId).toBeTruthy();
      expect(body.wsEndpoint).toContain("ws://");
    });

    test("POST /pages returns existing page on second call", async () => {
      // Create page
      const first = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "reuse-page" }),
        session: "reuse-session",
      });

      // Same name, same session should return same page
      const second = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "reuse-page" }),
        session: "reuse-session",
      });

      expect(first.body.targetId).toBe(second.body.targetId);
    });

    test("GET /pages lists session pages", async () => {
      await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list-page-1" }),
        session: "list-session",
      });
      await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list-page-2" }),
        session: "list-session",
      });

      const { body } = await fetchJson(port, "/pages", { session: "list-session" });
      const pages = body.pages as string[];
      expect(pages).toContain("list-page-1");
      expect(pages).toContain("list-page-2");
    });

    test("DELETE /pages/:name removes a page", async () => {
      await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "del-page" }),
        session: "del-session",
      });

      const { status } = await fetchJson(port, `/pages/del-page`, {
        method: "DELETE",
        session: "del-session",
      });
      expect(status).toBe(200);

      // Page should no longer be listed
      const { body } = await fetchJson(port, "/pages", { session: "del-session" });
      expect((body.pages as string[]).includes("del-page")).toBe(false);
    });

    test("DELETE /pages/:name returns 404 for unknown page", async () => {
      const { status } = await fetchJson(port, `/pages/nonexistent`, {
        method: "DELETE",
        session: "no-session",
      });
      expect(status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe("validation", () => {
    test("POST /pages rejects name with colon", async () => {
      const { status, body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad:name" }),
        session: "valid-session",
      });
      expect(status).toBe(400);
      expect(body.error).toContain("colon");
    });

    test("POST /pages rejects session with colon", async () => {
      const { status, body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "valid-name" }),
        session: "bad:session",
      });
      expect(status).toBe(400);
      expect(body.error).toContain("colon");
    });

    test("POST /pages rejects missing name", async () => {
      const { status } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Tab Limits
  // --------------------------------------------------------------------------

  describe("tab limits", () => {
    test("warns when approaching tab limit", async () => {
      const session = "limit-warn-session";
      // Create 3 tabs (warning threshold)
      for (let i = 0; i < 3; i++) {
        await fetchJson(port, "/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `warn-page-${i}` }),
          session,
        });
      }

      // 4th tab should include warning
      const { body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "warn-page-3" }),
        session,
      });
      expect(body.warning).toBeTruthy();
      expect((body.warning as string)).toContain("Warning");
    });

    test("rejects when tab limit exceeded", async () => {
      const session = "limit-reject-session";
      // Create 5 tabs (the limit)
      for (let i = 0; i < 5; i++) {
        const { status } = await fetchJson(port, "/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `reject-page-${i}` }),
          session,
        });
        expect(status).toBe(200);
      }

      // 6th tab should be rejected
      const { status, body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "reject-page-5" }),
        session,
      });
      expect(status).toBe(429);
      expect(body.error).toContain("limit");
    });
  });

  // --------------------------------------------------------------------------
  // Session Isolation
  // --------------------------------------------------------------------------

  describe("session isolation", () => {
    test("different sessions have separate page namespaces", async () => {
      // Create same-named page in two sessions
      const res1 = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "shared-name" }),
        session: "iso-session-a",
      });

      const res2 = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "shared-name" }),
        session: "iso-session-b",
      });

      // Different targets
      expect(res1.body.targetId).not.toBe(res2.body.targetId);

      // Each session only sees its own page
      const listA = await fetchJson(port, "/pages", { session: "iso-session-a" });
      const listB = await fetchJson(port, "/pages", { session: "iso-session-b" });
      expect((listA.body.pages as string[])).toEqual(["shared-name"]);
      expect((listB.body.pages as string[])).toEqual(["shared-name"]);
    });

    test("deleting from one session doesn't affect another", async () => {
      await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cross-del" }),
        session: "iso-del-a",
      });
      await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cross-del" }),
        session: "iso-del-b",
      });

      // Delete from session A
      await fetchJson(port, `/pages/cross-del`, {
        method: "DELETE",
        session: "iso-del-a",
      });

      // Session B still has it
      const listB = await fetchJson(port, "/pages", { session: "iso-del-b" });
      expect((listB.body.pages as string[])).toContain("cross-del");
    });
  });

  // --------------------------------------------------------------------------
  // Session Deletion
  // --------------------------------------------------------------------------

  describe("session deletion", () => {
    test("DELETE /sessions/:id closes all pages in session", async () => {
      const session = "batch-del-session";
      for (let i = 0; i < 3; i++) {
        await fetchJson(port, "/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `batch-${i}` }),
          session,
        });
      }

      const { body } = await fetchJson(port, `/sessions/${session}`, {
        method: "DELETE",
      });
      expect(body.closed).toBe(3);
      expect((body.pages as string[]).length).toBe(3);

      // No pages left
      const list = await fetchJson(port, "/pages", { session });
      expect((list.body.pages as string[]).length).toBe(0);
    });

    test("DELETE /sessions/:id for empty session returns 0", async () => {
      const { body } = await fetchJson(port, `/sessions/nonexistent-session`, {
        method: "DELETE",
      });
      expect(body.closed).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Extension Connection
  // --------------------------------------------------------------------------

  describe("extension connection", () => {
    test("POST /pages returns 503 when extension disconnects", async () => {
      await ext.disconnect();
      // Wait for relay to detect disconnect
      await new Promise((r) => setTimeout(r, 100));

      const { status } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "orphan" }),
        session: "orphan-session",
      });
      expect(status).toBe(503);

      // Reconnect for remaining tests
      ext = new MockExtension(port);
      await ext.connect();
      await new Promise((r) => setTimeout(r, 600));
    });
  });

  // --------------------------------------------------------------------------
  // HAR Recording
  // --------------------------------------------------------------------------

  describe("HAR recording", () => {
    /** Create a page for a session so /har/start has a target. Returns its targetId. */
    async function createPage(name: string, session: string): Promise<string> {
      const { status, body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        session,
      });
      expect(status).toBe(200);
      return body.targetId as string;
    }

    /**
     * Simulate a completed network exchange for a page's CDP session by
     * sending the Network.* events the extension would forward. Uses a
     * non-text mimeType so no response body fetch is triggered.
     */
    function sendNetworkExchange(
      targetId: string,
      requestId: string,
      url: string
    ): void {
      const sessionId = `pw-session-${targetId}`;
      const send = (method: string, params: Record<string, unknown>) => {
        ext.ws.send(
          JSON.stringify({
            method: "forwardCDPEvent",
            params: { method, params, sessionId },
          })
        );
      };
      const now = Date.now() / 1000;
      send("Network.requestWillBeSent", {
        requestId,
        timestamp: now,
        wallTime: now,
        request: { method: "GET", url, headers: {} },
      });
      send("Network.responseReceived", {
        requestId,
        response: {
          status: 200,
          statusText: "OK",
          headers: {},
          mimeType: "application/octet-stream",
          encodedDataLength: 3,
        },
      });
      send("Network.loadingFinished", {
        requestId,
        timestamp: now + 0.1,
        encodedDataLength: 3,
      });
    }

    /** Poll /har/entries until the recorder has buffered `count` entries */
    async function waitForEntryCount(
      pageName: string,
      session: string,
      count: number
    ): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < 2000) {
        const { body } = await fetchJson(port, `/har/entries?page=${pageName}`, {
          session,
        });
        if (((body.total as number) ?? 0) >= count) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for ${count} HAR entries`);
    }

    test("POST /har/start twice on the same page returns 409", async () => {
      const session = "har-409-session";
      await createPage("har-409-page", session);

      const first = await fetchJson(port, "/har/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: "har-409-page" }),
        session,
      });
      expect(first.status).toBe(200);

      const second = await fetchJson(port, "/har/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: "har-409-page" }),
        session,
      });
      expect(second.status).toBe(409);
    });

    test("GET /har/status reports recording state with entry count", async () => {
      const session = "har-status-session";
      await createPage("har-status-page", session);

      const before = await fetchJson(port, "/har/status?page=har-status-page", { session });
      expect(before.body.recording).toBe(false);
      expect(before.body.entries).toBeUndefined();

      await fetchJson(port, "/har/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: "har-status-page" }),
        session,
      });

      const during = await fetchJson(port, "/har/status?page=har-status-page", { session });
      expect(during.body.recording).toBe(true);
      expect(during.body.entries).toBe(0);
    });

    test("GET /har/status resolves session from query param when header absent", async () => {
      const session = "har-query-session";
      await createPage("har-query-page", session);
      await fetchJson(port, "/har/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: "har-query-page" }),
        session,
      });

      // No session header — query param must select the right session
      const viaQuery = await fetchJson(
        port,
        `/har/status?page=har-query-page&session=${session}`
      );
      expect(viaQuery.body.recording).toBe(true);

      // Without header or query param it falls back to "default" (not recording)
      const noSession = await fetchJson(port, "/har/status?page=har-query-page");
      expect(noSession.body.recording).toBe(false);
    });

    test("fresh client sees, no-ops start, and drains a recorder started by a previous client", async () => {
      const session = "har-cross-session";

      // First client: page() auto-starts a server-side HAR recorder
      const client1 = await connect(`http://127.0.0.1:${port}`, {
        mode: "extension",
        session,
      });
      await client1.page("cross-page");
      expect(await client1.isRecordingHar("cross-page")).toBe(true);
      await client1.disconnect();

      // Second client (fresh connect, same session): server is source of truth
      const client2 = await connect(`http://127.0.0.1:${port}`, {
        mode: "extension",
        session,
      });
      expect(await client2.isRecordingHar("cross-page")).toBe(true);

      // Starting again is a no-op, not an error
      await expect(client2.startHarRecording("cross-page")).resolves.toBeUndefined();

      // Stopping drains the recorder started by client1
      const har = await client2.stopHarRecording("cross-page");
      expect(har.log.entries).toEqual([]);
      expect(await client2.isRecordingHar("cross-page")).toBe(false);

      // Stopping again surfaces the server's 404 message
      await expect(client2.stopHarRecording("cross-page")).rejects.toThrow(
        /No HAR recording active/
      );
      await client2.disconnect();
    });

    test("GET /har/entries returns 400 without page param", async () => {
      const { status, body } = await fetchJson(port, "/har/entries", {
        session: "har-entries-400-session",
      });
      expect(status).toBe(400);
      expect(body.error).toBe("page query param required");
    });

    test("GET /har/entries returns 404 when not recording", async () => {
      const session = "har-entries-404-session";
      await createPage("har-entries-404-page", session);

      const { status, body } = await fetchJson(
        port,
        "/har/entries?page=har-entries-404-page",
        { session }
      );
      expect(status).toBe(404);
      expect(body.error).toBe('No HAR recording active for "har-entries-404-page"');
    });

    test("GET /har/entries peeks at entries without stopping the recorder", async () => {
      const session = "har-entries-peek-session";
      const targetId = await createPage("har-entries-peek-page", session);

      await fetchJson(port, "/har/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: "har-entries-peek-page" }),
        session,
      });

      sendNetworkExchange(targetId, "req-1", "https://example.com/a");
      sendNetworkExchange(targetId, "req-2", "https://example.com/b");
      await waitForEntryCount("har-entries-peek-page", session, 2);

      // Full peek
      const full = await fetchJson(port, "/har/entries?page=har-entries-peek-page", {
        session,
      });
      expect(full.status).toBe(200);
      expect(full.body.recording).toBe(true);
      expect(full.body.total).toBe(2);
      const entries = full.body.entries as Array<{ request: { url: string } }>;
      expect(entries.map((e) => e.request.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b",
      ]);

      // since slices correctly
      const sliced = await fetchJson(
        port,
        "/har/entries?page=har-entries-peek-page&since=1",
        { session }
      );
      expect(sliced.body.total).toBe(2);
      const slicedEntries = sliced.body.entries as Array<{ request: { url: string } }>;
      expect(slicedEntries).toHaveLength(1);
      expect(slicedEntries[0]!.request.url).toBe("https://example.com/b");

      // Recorder is untouched: status still recording, stop still drains
      const status = await fetchJson(
        port,
        "/har/status?page=har-entries-peek-page",
        { session }
      );
      expect(status.body.recording).toBe(true);
      expect(status.body.entries).toBe(2);

      const stopped = await fetchJson(port, "/har/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: "har-entries-peek-page" }),
        session,
      });
      expect(stopped.status).toBe(200);
      expect((stopped.body.log as { entries: unknown[] }).entries).toHaveLength(2);
    });

    test("client.getHarEntries peeks live in extension mode with since polling", async () => {
      const session = "har-entries-client-session";
      const targetId = await createPage("har-entries-client-page", session);

      const client = await connect(`http://127.0.0.1:${port}`, {
        mode: "extension",
        session,
      });
      // page() auto-starts the server-side recorder for the existing page
      await client.page("har-entries-client-page");

      sendNetworkExchange(targetId, "client-req-1", "https://example.com/first");
      await waitForEntryCount("har-entries-client-page", session, 1);

      const first = await client.getHarEntries("har-entries-client-page");
      expect(first.total).toBe(1);
      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]!.request.url).toBe("https://example.com/first");

      // Incremental poll: pass previous total as since
      sendNetworkExchange(targetId, "client-req-2", "https://example.com/second");
      await waitForEntryCount("har-entries-client-page", session, 2);

      const next = await client.getHarEntries("har-entries-client-page", {
        since: first.total,
      });
      expect(next.total).toBe(2);
      expect(next.entries).toHaveLength(1);
      expect(next.entries[0]!.request.url).toBe("https://example.com/second");

      // Recorder still active after peeking
      expect(await client.isRecordingHar("har-entries-client-page")).toBe(true);

      // 404 path surfaces the server's message
      await expect(client.getHarEntries("no-such-page")).rejects.toThrow(
        'No HAR recording active for "no-such-page"'
      );

      await client.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  describe("stats", () => {
    test("GET /stats returns server statistics", async () => {
      // Create a page first
      await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "stats-page" }),
        session: "stats-session",
      });

      const { body } = await fetchJson(port, "/stats");
      expect(typeof body.namedPages).toBe("number");
      expect(typeof body.connectedTargets).toBe("number");
      expect(typeof body.sessions).toBe("number");
      expect(body.extensionConnected).toBe(true);
      expect(body.tabLimit).toBe(5);
    });
  });
});

// ============================================================================
// Cross-origin navigation tests (separate describe for isolated relay instance)
// ============================================================================

describe("Relay Server - Cross-origin Navigation", () => {
  let relay: RelayServer;
  let port: number;
  let ext: MockExtension;

  beforeAll(async () => {
    port = randomPort();
    relay = await serveRelay({ port, host: "127.0.0.1" });
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));
  });

  afterAll(async () => {
    await ext.disconnect();
    await relay.stop();
  });

  test("cross-origin navigation updates session mapping without losing page", async () => {
    // Create a page
    const { body } = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nav-page" }),
      session: "nav-session",
    });
    const targetId = body.targetId as string;

    // Find the CDP session for this target from stats
    const stats1 = await fetchJson(port, "/stats");
    expect((stats1.body.connectedTargets as number)).toBeGreaterThan(0);

    // Simulate cross-origin navigation: detach old session, then reattach with new session
    // The extension sends detach for the old CDP session
    const oldSessionId = `pw-session-${targetId}`;
    ext.sendDetachedFromTarget(oldSessionId);

    // Small delay (simulates Chrome's cross-origin navigation)
    await new Promise((r) => setTimeout(r, 50));

    // Extension sends attach with new CDP session but SAME targetId
    const newSessionId = `pw-session-new-${targetId}`;
    ext.sendAttachedToTarget(targetId, newSessionId, "https://other-domain.com");

    // Wait for relay to process
    await new Promise((r) => setTimeout(r, 100));

    // Page should still be accessible
    const { body: pageBody } = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nav-page" }),
      session: "nav-session",
    });
    expect(pageBody.targetId).toBe(targetId);
  });

  test("detach without reattach cleans up after grace period", async () => {
    // Create a page
    const { body } = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "orphan-page" }),
      session: "orphan-session",
    });
    const targetId = body.targetId as string;
    const cdpSessionId = `pw-session-${targetId}`;

    // Detach without reattach (tab was closed)
    ext.sendDetachedFromTarget(cdpSessionId);

    // Page should still exist during grace period
    await new Promise((r) => setTimeout(r, 100));
    const listDuring = await fetchJson(port, "/pages", { session: "orphan-session" });
    // During the 500ms grace period the page name is still in the session
    expect((listDuring.body.pages as string[])).toContain("orphan-page");

    // Wait for the 500ms grace period to expire + buffer
    await new Promise((r) => setTimeout(r, 600));

    // Page should be cleaned up now
    const listAfter = await fetchJson(port, "/pages", { session: "orphan-session" });
    expect((listAfter.body.pages as string[])).not.toContain("orphan-page");
  });
});

// ============================================================================
// Event-driven target waiting test (separate relay for timing control)
// ============================================================================

describe("Relay Server - Event-driven Target Waiting", () => {
  let relay: RelayServer;
  let port: number;
  let ext: MockExtension;

  beforeAll(async () => {
    port = randomPort();
    relay = await serveRelay({ port, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await relay.stop();
  });

  beforeEach(async () => {
    ext = new MockExtension(port);
  });

  afterEach(async () => {
    await ext.disconnect();
    await new Promise((r) => setTimeout(r, 100));
  });

  test("page creation succeeds when attachedToTarget arrives with delay", async () => {
    // Override extension to delay the attachedToTarget event
    ext.onCommand((msg) => {
      if (msg.method !== "forwardCDPCommand") return undefined;
      const cdpMethod = (msg.params as { method: string }).method;
      if (cdpMethod !== "Target.createTarget") return undefined;

      const targetId = "delayed-target";
      const tabId = 999;

      // Respond immediately with the targetId
      setTimeout(() => {
        ext.ws.send(JSON.stringify({ id: msg.id, result: { targetId, tabId } }));

        // Delay the attachedToTarget event by 500ms (well within the 5s timeout)
        setTimeout(() => {
          ext.sendAttachedToTarget(targetId, "pw-delayed-session", "about:blank");
        }, 500);
      }, 0);

      // Tell mock extension we're sending the response manually
      return "__manual__";
    });

    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));

    const start = Date.now();
    const { status, body } = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "delayed-page" }),
      session: "delayed-session",
    });
    const elapsed = Date.now() - start;

    expect(status).toBe(200);
    expect(body.targetId).toBe("delayed-target");
    // Should have waited ~500ms for the event, not the old fixed 200ms
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});

// ============================================================================
// getAgentSession unit tests
// ============================================================================

describe("getAgentSession", () => {
  function mockContext(header?: string, query?: string): Context {
    return {
      req: {
        header: (name: string) =>
          name === "X-DevBrowser-Session" ? header : undefined,
        query: (name: string) => (name === "session" ? query : undefined),
      },
    } as unknown as Context;
  }

  test("prefers the header when present", () => {
    expect(getAgentSession(mockContext("header-session", "query-session"))).toBe(
      "header-session"
    );
  });

  test("falls back to the session query param when header is absent", () => {
    expect(getAgentSession(mockContext(undefined, "query-session"))).toBe(
      "query-session"
    );
  });

  test("defaults to \"default\" when neither is present", () => {
    expect(getAgentSession(mockContext())).toBe("default");
  });
});
