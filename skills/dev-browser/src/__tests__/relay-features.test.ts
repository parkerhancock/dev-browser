/**
 * Integration tests for the parity features added to the relay:
 * auth (§4), /health, /batch, console capture, dialog auto-dismiss,
 * and policy enforcement at the /cdp choke point.
 *
 * Uses its own relay instances and an isolated DEV_BROWSER_DIR so the
 * generated token/persistence never touch the user's real ~/.dev-browser.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { connect } from "../client.js";
import { serveRelay, type RelayServer } from "../relay.js";
import { loadToken, TOKEN_HEADER } from "../auth.js";
import type { RelayPolicy } from "../policy.js";
import { MockExtension, randomPort, fetchJson, waitFor } from "./mock-extension.js";

process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-features-test-"));

async function createPage(
  port: number,
  session: string,
  name: string
): Promise<void> {
  const { status } = await fetchJson(port, "/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    session,
  });
  expect(status).toBe(200);
}

describe("Relay auth (§4)", () => {
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

  test("token file is created on relay start", () => {
    expect(loadToken()).toBeTruthy();
  });

  test("requests without a token are rejected", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pages`);
    expect(res.status).toBe(401);
  });

  test("requests with a wrong token are rejected", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pages`, {
      headers: { [TOKEN_HEADER]: "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("requests with the token succeed (header and query param)", async () => {
    const token = loadToken()!;
    const viaHeader = await fetch(`http://127.0.0.1:${port}/pages`, {
      headers: { [TOKEN_HEADER]: token },
    });
    expect(viaHeader.status).toBe(200);

    const viaQuery = await fetch(
      `http://127.0.0.1:${port}/pages?token=${encodeURIComponent(token)}`
    );
    expect(viaQuery.status).toBe(200);
  });

  test("/extension upgrade with a web Origin is rejected even with the token", async () => {
    const token = loadToken()!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: "https://evil.example", [TOKEN_HEADER]: token },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("rejected"));
      ws.on("unexpected-response", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });

  test("/extension upgrade with chrome-extension Origin and no token is accepted", async () => {
    // This replaces the current extension connection, so run it last in this block
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: "chrome-extension://abcdefghijklmnop" },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("rejected"));
      ws.on("unexpected-response", () => resolve("rejected"));
    });
    expect(outcome).toBe("open");
    ws.close();
    // Reconnect the mock extension for any later use of this relay
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));
  });
});

describe("Relay features (health, batch, console, dialogs)", () => {
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

  test("GET /health reports mode, extension status, and uptime", async () => {
    const { status, body } = await fetchJson(port, "/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("extension");
    expect(body.extensionConnected).toBe(true);
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.permissionMode).toBe("permissive");
  });

  test("POST /batch executes ops sequentially and stops on error", async () => {
    await createPage(port, "batch-session", "batch-page");

    ext.clearCommandHandlers();
    ext.onCommand((msg) => {
      if (msg.method !== "forwardCDPCommand") return undefined;
      const cdpMethod = (msg.params as { method: string }).method;
      if (cdpMethod === "Fail.me") {
        ext.ws.send(JSON.stringify({ id: msg.id, error: "boom" }));
        return "__manual__";
      }
      return undefined;
    });

    const { status, body } = await fetchJson(port, "/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: "batch-page",
        ops: [
          { method: "Browser.getVersion" },
          { method: "Runtime.evaluate", params: { expression: "1+1" } },
          { method: "Fail.me" },
          { method: "Runtime.evaluate", params: { expression: "2+2" } },
        ],
      }),
      session: "batch-session",
    });

    expect(status).toBe(200);
    const results = body.results as Array<{ result?: unknown; error?: string }>;
    expect(results).toHaveLength(3); // stopped after the failing op
    expect(results[0]!.error).toBeUndefined();
    expect(results[1]!.error).toBeUndefined();
    expect(results[2]!.error).toContain("boom");
    expect(body.completed).toBe(2);
    ext.clearCommandHandlers();
  });

  test("console capture: enable, buffer events, read with pattern", async () => {
    await createPage(port, "console-session", "console-page");

    // Find the CDP sessionId the relay assigned to this page
    const { body: stats } = await fetchJson(port, "/stats");
    expect(stats.namedPages).toBeGreaterThan(0);

    const enable = await fetchJson(port, "/console/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: "console-page" }),
      session: "console-session",
    });
    expect(enable.status).toBe(200);

    // The mock created this page via Target.createTarget -> session id pattern
    const forwarded = ext.forwardedCdpCommands();
    const runtimeEnable = forwarded.find((c) => c.method === "Runtime.enable");
    expect(runtimeEnable).toBeTruthy();
    const cdpSessionId = runtimeEnable!.sessionId!;

    // Emit console events like the extension would
    ext.ws.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          sessionId: cdpSessionId,
          method: "Runtime.consoleAPICalled",
          params: {
            type: "error",
            args: [{ type: "string", value: "kaboom happened" }],
            timestamp: Date.now(),
          },
        },
      })
    );
    ext.ws.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          sessionId: cdpSessionId,
          method: "Log.entryAdded",
          params: {
            entry: {
              source: "network",
              level: "warning",
              text: "mixed content",
              timestamp: Date.now(),
            },
          },
        },
      })
    );

    await waitFor(() => true, 100); // give the WS messages a tick to arrive
    await new Promise((r) => setTimeout(r, 200));

    const all = await fetchJson(port, "/console?page=console-page", {
      session: "console-session",
    });
    expect(all.status).toBe(200);
    const messages = all.body.messages as Array<{ level: string; text: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0]!.text).toBe("kaboom happened");
    expect(messages[1]!.text).toBe("mixed content");

    const filtered = await fetchJson(
      port,
      `/console?page=console-page&pattern=${encodeURIComponent("kaboom")}`,
      { session: "console-session" }
    );
    expect((filtered.body.messages as unknown[]).length).toBe(1);
  });

  test("JS dialogs are auto-dismissed", async () => {
    await createPage(port, "dialog-session", "dialog-page");

    const forwarded = ext.forwardedCdpCommands();
    const before = forwarded.filter(
      (c) => c.method === "Page.handleJavaScriptDialog"
    ).length;

    // Use any live session id from a previous createTarget
    const anySession = forwarded.find((c) => c.sessionId)?.sessionId ?? "pw-session-target-1";

    ext.ws.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          sessionId: anySession,
          method: "Page.javascriptDialogOpening",
          params: { message: "are you sure?", type: "confirm" },
        },
      })
    );

    await waitFor(
      () =>
        ext
          .forwardedCdpCommands()
          .filter((c) => c.method === "Page.handleJavaScriptDialog").length >
        before,
      3000
    );

    const handled = ext
      .forwardedCdpCommands()
      .filter((c) => c.method === "Page.handleJavaScriptDialog")
      .at(-1)!;
    expect(handled.params?.accept).toBe(false); // default policy: dismiss
  });
});

describe("Relay policy enforcement", () => {
  let relay: RelayServer;
  let port: number;
  let ext: MockExtension;

  const policy: RelayPolicy = {
    defaultMode: "strict",
    allowedDomains: ["example.com"],
  };

  beforeAll(async () => {
    port = randomPort();
    relay = await serveRelay({ port, host: "127.0.0.1", policy });
    ext = new MockExtension(port);
    await ext.connect();
    await new Promise((r) => setTimeout(r, 600));
    await createPage(port, "policy-session", "policy-page");
  });

  afterAll(async () => {
    await ext.disconnect();
    await relay.stop();
  });

  async function cdp(
    method: string,
    params?: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return fetchJson(port, "/cdp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: "policy-page", method, params }),
      session: "policy-session",
    });
  }

  test("navigation to an allowlisted domain is allowed", async () => {
    const { status } = await cdp("Page.navigate", { url: "https://example.com/x" });
    expect(status).toBe(200);
  });

  test("navigation outside the allowlist is blocked with 403", async () => {
    const { status, body } = await cdp("Page.navigate", { url: "https://evil.net/" });
    expect(status).toBe(403);
    expect(JSON.stringify(body)).toContain("not on the allowlist");
  });

  test("non-allowlisted CDP methods are blocked in strict mode", async () => {
    const { status } = await cdp("HeapProfiler.enable");
    expect(status).toBe(403);
  });

  test("safe CDP methods still work in strict mode", async () => {
    const { status } = await cdp("Runtime.evaluate", { expression: "1" });
    expect(status).toBe(200);
  });

  test("/batch enforces the same policy per op", async () => {
    const { status, body } = await fetchJson(port, "/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: "policy-page",
        ops: [
          { method: "Runtime.evaluate", params: { expression: "1" } },
          { method: "Page.navigate", params: { url: "https://evil.net/" } },
          { method: "Runtime.evaluate", params: { expression: "2" } },
        ],
      }),
      session: "policy-session",
    });
    expect(status).toBe(200);
    const results = body.results as Array<{ error?: string }>;
    expect(results).toHaveLength(2);
    expect(results[1]!.error).toContain("Blocked by policy");
    expect(body.completed).toBe(1);
  });
});

describe("Extension pages", () => {
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

  test("enable focus emulation so background tabs receive input", async () => {
    const client = await connect(`http://127.0.0.1:${port}`, {
      mode: "extension",
      session: "focus-session",
    });
    await client.page("background", { record: false });
    const command = ext
      .forwardedCdpCommands()
      .find((c) => c.method === "Emulation.setFocusEmulationEnabled");
    expect(command?.params).toEqual({ enabled: true });
    await client.disconnect();
  });
});
