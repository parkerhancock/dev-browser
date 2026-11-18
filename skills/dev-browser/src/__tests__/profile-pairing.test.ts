import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import { serveRelay } from "../relay.js";
import { createProfilePairing } from "../relay/pairing.js";
import { randomPort } from "./mock-extension.js";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const token = "test-relay-token";
const credential = "a".repeat(64);

test("pairing code expiry and one-time enrollment survive a relay restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-browser-pairing-unit-"));
  const pairing = createProfilePairing(dir);
  vi.useFakeTimers();
  try {
    const expired = pairing.begin();
    vi.advanceTimersByTime(5 * 60_000);
    expect(pairing.redeem(expired, credential)).toBeUndefined();
    const code = pairing.begin();
    expect(pairing.redeem(code, credential)).toMatch(/^[0-9a-f]{64}$/u);
    expect(pairing.redeem(code, credential)).toBeUndefined();
    expect(createProfilePairing(dir).verify(credential)).toBe(true);
    expect(createProfilePairing(dir).verify("b".repeat(64))).toBe(false);
  } finally { vi.useRealTimers(); }
});

test("a different profile cannot displace the approved socket and Stop invalidates the binding", async () => {
  vi.stubEnv("DEV_BROWSER_DIR", mkdtempSync(join(tmpdir(), "dev-browser-paired-relay-")));
  const port = randomPort();
  const relay = await serveRelay({ port, token });
  const sockets: WebSocket[] = [];
  function open(path: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
    sockets.push(ws);
    return ws;
  }
  const base = `http://127.0.0.1:${port}`;
  const headers = { "X-DevBrowser-Token": token };
  const health = async () => (await (await fetch(base + "/health", { headers })).json()) as {
    extensionProfileId?: string;
    extensionConnectionId: string;
    extensionConnected: boolean;
  };
  async function connect() {
    const ws = open("/extension/paired");
    await once(ws, "open");
    const acknowledged = once(ws, "message");
    ws.send(JSON.stringify({ credential }));
    expect(String((await acknowledged)[0])).toBe('{"method":"paired"}');
    return ws;
  }

  try {
    const begin = await fetch(base + "/pairing/start", { method: "POST", headers });
    expect(begin.status).toBe(201);
    const { code } = await begin.json() as { code: string };
    const complete = (requestOrigin: string) => fetch(base + "/pairing/complete", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin },
      body: JSON.stringify({ code, credential }),
    });
    expect((await complete("https://example.test")).status).toBe(403);
    const approval = await complete(origin);
    expect(approval.status).toBe(201);
    const { profileId } = await approval.json() as { profileId: string };
    expect((await complete(origin)).status).toBe(403);

    const approved = await connect();
    const first = await health();
    expect(first.extensionProfileId).toBe(profileId);
    expect(first.extensionConnectionId).toBeTruthy();
    for (const path of ["/extension", "/extension/paired"]) {
      const other = open(path);
      const closed = once(other, "close");
      await once(other, "open");
      if (path.endsWith("paired")) other.send(JSON.stringify({ credential: "b".repeat(64) }));
      expect((await closed)[0]).toBe(1008);
      expect((await health()).extensionConnectionId).toBe(first.extensionConnectionId);
    }

    const bound = () => fetch(base + "/all-targets", {
      headers: { ...headers, "X-DevBrowser-Extension-Connection": first.extensionConnectionId },
    });
    let readDispatched = false;
    approved.on("message", (request) => {
      const { id, method } = JSON.parse(String(request));
      if (method === "getAvailableTargets") {
        readDispatched = true;
        approved.send(JSON.stringify({ id, result: { targets: [] } }));
      } else if (method === "sweepGroups") {
        approved.send(JSON.stringify({ id, result: { closed: 0 } }));
      }
    });
    expect((await bound()).status).toBe(200);
    expect(readDispatched).toBe(true);

    const disconnected = once(approved, "close");
    approved.close();
    await disconnected;
    expect((await bound()).status).toBe(409);
    expect((await health()).extensionConnected).toBe(false);
    await connect();
    expect((await bound()).status).toBe(409);
    expect((await health()).extensionConnectionId).not.toBe(first.extensionConnectionId);
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.stop();
    vi.unstubAllEnvs();
  }
});
