/**
 * Regression tests for named-page survival in extension mode.
 *
 * Covers the bug in issues/extension-mode-named-page-rebinds-to-blank.md:
 * named pages must survive extension reconnects (recovery rebinds to the
 * live tab by tabId, preserving pinned), must not be closed by idle
 * cleanup, and POST /pages must rebind to a surviving tab instead of
 * spawning a fresh about:blank tab.
 *
 * Uses an isolated DEV_BROWSER_DIR so persistence (pages.json) does not
 * touch the user's real ~/.dev-browser state.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveRelay, type RelayServer } from "../relay.js";
import { MockExtension, randomPort, fetchJson } from "./mock-extension.js";

// Isolate persistence for this whole file (persistence paths resolve lazily).
process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-recovery-test-"));

/** Poll an async condition until it holds or the timeout expires. */
async function waitForAsync(
  fn: () => Promise<boolean>,
  timeoutMs = 3000,
  pollMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForAsync timed out after ${timeoutMs}ms`);
}

/** Target.closeTarget targetIds forwarded to the mock extension */
function closedTargetIds(ext: MockExtension): string[] {
  return ext
    .forwardedCdpCommands()
    .filter((c) => c.method === "Target.closeTarget")
    .map((c) => (c.params as { targetId: string }).targetId);
}

/** Number of Target.createTarget commands forwarded to the mock extension */
function createTargetCount(ext: MockExtension): number {
  return ext.forwardedCdpCommands().filter((c) => c.method === "Target.createTarget")
    .length;
}

// ============================================================================
// Restart recovery: extension disconnect/reconnect rebinds to the live tab
// ============================================================================

describe("Relay Server - Reconnect Recovery", () => {
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

  test("named+pinned page recovers bound to the live tab after reconnect, even when its URL drifted", async () => {
    const session = "recover-session";

    // Create a named, pinned page. Mock extension assigns tabId 100 to the
    // first created target.
    const created = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "recover-page", pinned: true }),
      session,
    });
    expect(created.status).toBe(200);
    expect(created.body.pinned).toBe(true);
    const targetId = created.body.targetId as string;

    // Simulate navigation: extension synthesizes Target.targetInfoChanged.
    // The relay must track the current URL (in memory and in persistence).
    ext.sendTargetInfoChanged(targetId, "https://app.example/dashboard");
    await waitForAsync(async () => {
      const reused = await fetchJson(port, "/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "recover-page" }),
        session,
      });
      return reused.body.url === "https://app.example/dashboard";
    });

    // Extension disconnects (relay restart / extension reload equivalent:
    // all in-memory CDP state is cleared, persistence survives).
    await ext.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Extension reconnects. The tab is still alive with the SAME tabId, but
    // its URL has drifted since the last persisted update (SPA redirect) —
    // recovery must match by tabId, not exact URL.
    ext = new MockExtension(port);
    ext.onCommand((msg) => {
      if (msg.method === "getAvailableTargets") {
        return {
          targets: [
            {
              tabId: 100,
              targetId: "tab-100",
              url: "https://app.example/dashboard?tab=2",
              title: "Dashboard",
            },
          ],
        };
      }
      if (msg.method === "attachToTab") {
        return {
          sessionId: "pw-recovered-1",
          targetInfo: {
            targetId: "target-1-recovered",
            type: "page",
            title: "Dashboard",
            url: "https://app.example/dashboard?tab=2",
            attached: true,
          },
        };
      }
      return undefined;
    });
    await ext.connect();

    // Recovery runs ~500ms after connect; wait until the name reappears.
    await waitForAsync(async () => {
      const { body } = await fetchJson(port, "/pages", { session });
      return (body.pages as string[]).includes("recover-page");
    });

    // Re-opening the page by name must return the recovered live tab —
    // not a fresh about:blank target — with pinned preserved.
    const reopened = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "recover-page" }),
      session,
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.targetId).toBe("target-1-recovered");
    expect(reopened.body.url).toBe("https://app.example/dashboard?tab=2");
    expect(reopened.body.pinned).toBe(true);

    // No new blank tab was created during recovery or reopen.
    expect(createTargetCount(ext)).toBe(0);
  });
});

// ============================================================================
// Idle cleanup: named pages are never blanked, pinned tabs never closed
// ============================================================================

describe("Relay Server - Idle Cleanup", () => {
  let relay: RelayServer;
  let port: number;
  let ext: MockExtension;

  beforeAll(async () => {
    process.env.DEV_BROWSER_IDLE_TIMEOUT_MS = "400";
    port = randomPort();
    relay = await serveRelay({ port, host: "127.0.0.1" });
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));
  });

  afterAll(async () => {
    delete process.env.DEV_BROWSER_IDLE_TIMEOUT_MS;
    await ext.disconnect();
    await relay.stop();
  });

  test("idle cleanup closes anonymous targets but never named pages", async () => {
    const session = "idle-session";

    const created = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "idle-named" }),
      session,
    });
    expect(created.status).toBe(200);
    const namedTargetId = created.body.targetId as string;

    // An anonymous target (attached but never named) — this is what the
    // idle timer exists to reap.
    ext.sendAttachedToTarget("anon-target", "pw-anon-session", "https://anon.example/");

    // Wait well past the idle timeout (400ms) plus a sweep interval.
    await new Promise((r) => setTimeout(r, 1400));

    // The named page is still listed and still bound to the same target.
    const { body: listBody } = await fetchJson(port, "/pages", { session });
    expect(listBody.pages as string[]).toContain("idle-named");

    const reused = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "idle-named" }),
      session,
    });
    expect(reused.body.targetId).toBe(namedTargetId);

    // Exactly one tab was ever created for this page — no silent re-create.
    expect(createTargetCount(ext)).toBe(1);

    // The anonymous target was closed; the named page's tab was not.
    const closed = closedTargetIds(ext);
    expect(closed).toContain("anon-target");
    expect(closed).not.toContain(namedTargetId);
  });

  test("pinned page's tab is never closed by idle cleanup", async () => {
    const session = "idle-pin-session";

    const created = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "idle-pinned", pinned: true }),
      session,
    });
    expect(created.status).toBe(200);
    const pinnedTargetId = created.body.targetId as string;

    await new Promise((r) => setTimeout(r, 1400));

    const { body: listBody } = await fetchJson(port, "/pages", { session });
    expect(listBody.pages as string[]).toContain("idle-pinned");
    expect(closedTargetIds(ext)).not.toContain(pinnedTargetId);
  });
});

// ============================================================================
// Rebind, don't orphan: POST /pages reuses a surviving tab
// ============================================================================

describe("Relay Server - Rebind Instead of Orphan", () => {
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

  test("POST /pages rebinds to the surviving tab after the CDP session dies", async () => {
    const session = "rebind-session";

    // Create a named page (mock assigns targetId "target-1", tabId 100).
    const created = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "rebind-page" }),
      session,
    });
    expect(created.status).toBe(200);
    const targetId = created.body.targetId as string;
    expect(createTargetCount(ext)).toBe(1);

    // The CDP session dies without the tab closing (e.g. debugger detach).
    // After the 500ms grace period the relay drops the name binding.
    ext.sendDetachedFromTarget(`pw-session-${targetId}`);
    await new Promise((r) => setTimeout(r, 800));

    const { body: listBody } = await fetchJson(port, "/pages", { session });
    expect(listBody.pages as string[]).not.toContain("rebind-page");

    // The Chrome tab itself is still alive and reported by the extension.
    ext.onCommand((msg) => {
      if (msg.method === "getAvailableTargets") {
        return {
          targets: [{ tabId: 100, targetId: "tab-100", url: "about:blank", title: "" }],
        };
      }
      if (msg.method === "attachToTab") {
        return {
          sessionId: "pw-rebind-1",
          targetInfo: {
            targetId,
            type: "page",
            title: "",
            url: "about:blank",
            attached: true,
          },
        };
      }
      return undefined;
    });

    // Re-opening the name must rebind to the surviving tab, not create a
    // fresh blank target.
    const reopened = await fetchJson(port, "/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "rebind-page" }),
      session,
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.targetId).toBe(targetId);
    expect(createTargetCount(ext)).toBe(1); // still just the original create

    const { body: listAfter } = await fetchJson(port, "/pages", { session });
    expect(listAfter.pages as string[]).toContain("rebind-page");
  });
});
