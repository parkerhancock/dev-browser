/**
 * Integration tests for the CDP Relay Server.
 *
 * Tests the relay's HTTP API and WebSocket protocol using a mock extension.
 * No real browser needed — we simulate CDP events that the extension would send.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { serveRelay, type RelayServer } from "../relay.js";
import WebSocket from "ws";

// ============================================================================
// Test Helpers
// ============================================================================

/** Pick a random port to avoid conflicts between parallel test runs */
function randomPort(): number {
  return 19000 + Math.floor(Math.random() * 10000);
}

/** Wait for a condition with timeout */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 2000,
  pollMs = 20
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Helper to fetch JSON from the relay */
async function fetchJson(
  port: number,
  path: string,
  options?: RequestInit & { session?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options?.session) {
    headers["X-DevBrowser-Session"] = options.session;
  }
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Mock extension that connects to the relay via WebSocket.
 * Automatically responds to Target.createTarget and Target.closeTarget commands.
 */
class MockExtension {
  ws!: WebSocket;
  private port: number;
  private nextTargetId = 1;
  private nextTabId = 100;
  received: Array<{ id: number; method: string; params?: unknown }> = [];
  private onCommandHandlers: Array<
    (msg: { id: number; method: string; params?: Record<string, unknown> }) => unknown | undefined
  > = [];

  constructor(port: number) {
    this.port = port;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/extension`);
    await new Promise<void>((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });

    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined) {
        this.received.push(msg);
        this.handleCommand(msg);
      }
    });
  }

  /**
   * Register a custom command handler.
   * - Return `undefined` to fall through to the default handler.
   * - Return `"__manual__"` to indicate you're sending the response yourself.
   * - Return any other value to auto-send it as the response.
   */
  onCommand(
    handler: (msg: { id: number; method: string; params?: Record<string, unknown> }) => unknown | undefined
  ): void {
    this.onCommandHandlers.push(handler);
  }

  private handleCommand(msg: { id: number; method: string; params?: Record<string, unknown> }): void {
    // Check custom handlers first
    for (const handler of this.onCommandHandlers) {
      const result = handler(msg);
      if (result === "__manual__") return; // Handler is sending the response itself
      if (result !== undefined) {
        this.ws.send(JSON.stringify({ id: msg.id, result }));
        return;
      }
    }

    // Default handlers
    if (msg.method === "forwardCDPCommand") {
      const cdpMethod = (msg.params as { method: string }).method;
      const cdpParams = (msg.params as { params?: Record<string, unknown> }).params;

      if (cdpMethod === "Target.createTarget") {
        const targetId = `target-${this.nextTargetId++}`;
        const tabId = this.nextTabId++;

        // Respond to the command
        this.ws.send(JSON.stringify({ id: msg.id, result: { targetId, tabId } }));

        // Send Target.attachedToTarget event (like the real extension does)
        this.sendAttachedToTarget(targetId, `pw-session-${targetId}`);
        return;
      }

      if (cdpMethod === "Target.closeTarget") {
        const targetId = (cdpParams as { targetId: string })?.targetId;
        // Respond to the command
        this.ws.send(JSON.stringify({ id: msg.id, result: { success: true } }));
        // Send detach event
        // (In the real extension, this happens via chrome.debugger.onDetach)
        // We don't auto-send detach here because tests may want to control this
        return;
      }
    }

    if (msg.method === "getAvailableTargets") {
      this.ws.send(JSON.stringify({ id: msg.id, result: { targets: [] } }));
      return;
    }

    if (msg.method === "attachToTab") {
      const tabId = (msg.params as { tabId: number }).tabId;
      const targetId = `target-recovered-${tabId}`;
      const sessionId = `pw-session-${targetId}`;

      this.ws.send(
        JSON.stringify({
          id: msg.id,
          result: {
            sessionId,
            targetInfo: {
              targetId,
              type: "page",
              title: "Recovered",
              url: "https://example.com",
              attached: true,
            },
          },
        })
      );
      return;
    }

    if (msg.method === "closeTab") {
      this.ws.send(JSON.stringify({ id: msg.id, result: { success: true } }));
      return;
    }

    // Default: return empty result
    this.ws.send(JSON.stringify({ id: msg.id, result: {} }));
  }

  /** Send a Target.attachedToTarget event to the relay */
  sendAttachedToTarget(
    targetId: string,
    sessionId: string,
    url = "about:blank"
  ): void {
    this.ws.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: {
              targetId,
              type: "page",
              title: "",
              url,
              attached: true,
            },
          },
        },
      })
    );
  }

  /** Send a Target.detachedFromTarget event to the relay */
  sendDetachedFromTarget(sessionId: string): void {
    this.ws.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId },
        },
      })
    );
  }

  /** Send a Target.targetInfoChanged event to the relay */
  sendTargetInfoChanged(targetId: string, url: string, title = ""): void {
    this.ws.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.targetInfoChanged",
          params: {
            targetInfo: {
              targetId,
              type: "page",
              title,
              url,
              attached: true,
            },
          },
        },
      })
    );
  }

  async disconnect(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      await new Promise<void>((resolve) => this.ws.on("close", resolve));
    }
  }
}

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
  });

  afterAll(async () => {
    await relay.stop();
  });

  beforeEach(async () => {
    ext = new MockExtension(port);
    await ext.connect();
    // Let the extension connection stabilize and recovery complete
    await new Promise((r) => setTimeout(r, 600));
  });

  afterEach(async () => {
    await ext.disconnect();
    // Wait for relay to clean up state after extension disconnect
    await new Promise((r) => setTimeout(r, 100));
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

      const { status, body } = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "orphan" }),
        session: "orphan-session",
      });
      expect(status).toBe(503);

      // Reconnect for afterEach cleanup
      ext = new MockExtension(port);
      await ext.connect();
      await new Promise((r) => setTimeout(r, 600));
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
  });

  afterAll(async () => {
    await relay.stop();
  });

  beforeEach(async () => {
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));
  });

  afterEach(async () => {
    await ext.disconnect();
    await new Promise((r) => setTimeout(r, 100));
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
