import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { endianness } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("approval is idempotent and survives a relay restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-browser-pairing-unit-"));
  const pairing = createProfilePairing(dir);
  const id = pairing.approve(credential);
  expect(id).toMatch(/^[0-9a-f]{64}$/u);
  const restarted = createProfilePairing(dir);
  expect(restarted.approve(credential)).toBe(id);
  expect(restarted.approve("b".repeat(64))).toBeUndefined();
  expect(restarted.verify(credential)).toBe(true);
});

test("a different profile cannot displace the approved socket and Stop invalidates the binding", async () => {
  const state = mkdtempSync(join(tmpdir(), "dev-browser-paired-relay-"));
  vi.stubEnv("DEV_BROWSER_DIR", state);
  writeFileSync(join(state, "token"), token, { mode: 0o600 });
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
    sshAccessEnabled: boolean;
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
    const payload = JSON.stringify({ credential });
    const endpoint = base + "/pairing/local";
    const post = (headers?: Record<string, string>) => fetch(endpoint, { method: "POST", headers, body: payload });
    expect((await post({ Origin: origin })).status).toBe(401);
    expect((await post({ ...headers, Origin: origin })).status).toBe(403);
    expect((await fetch(endpoint + "?token=" + token, { method: "POST", body: payload })).status).toBe(401);

    const hostFile = fileURLToPath(new URL("../../../../mcp-server/bin/chrome-native.mjs", import.meta.url));
    async function approveWithHost(sender: string) {
      const child = spawn(process.execPath, [hostFile, origin + "/", state, sender], {
        env: { ...process.env, DEV_BROWSER_RELAY_PORT: String(port) },
      });
      const result: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => result.push(chunk));
      const body = Buffer.from(payload);
      const header = Buffer.alloc(4);
      if (endianness() === "LE") header.writeUInt32LE(body.length);
      else header.writeUInt32BE(body.length);
      child.stdin.end(Buffer.concat([header, body]));
      expect((await once(child, "close"))[0]).toBe(0);
      return JSON.parse(Buffer.concat(result).subarray(4).toString());
    }
    expect(await approveWithHost("chrome-extension://another")).toEqual({ error: "Dev Browser extension required" });
    expect(await approveWithHost(origin)).toEqual({ approved: true });
    const profileId = createProfilePairing(state).profileId;
    expect(await approveWithHost(origin)).toEqual({ approved: true });

    const approved = await connect();
    async function setSsh(ws: WebSocket, enabled: boolean) {
      const acknowledged = once(ws, "message");
      ws.send(JSON.stringify({ method: "setSshAccess", enabled }));
      expect(JSON.parse(String((await acknowledged)[0]))).toEqual({ method: "sshAccess", enabled });
    }
    expect((await health()).sshAccessEnabled).toBe(false);
    await setSsh(approved, true);
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
    let holdRead: ((id: number) => void) | undefined;
    approved.on("message", (request) => {
      const { id, method } = JSON.parse(String(request));
      if (method === "getAvailableTargets") {
        readDispatched = true;
        if (holdRead) holdRead(id);
        else approved.send(JSON.stringify({ id, result: { targets: [] } }));
      } else if (method === "sweepGroups") {
        approved.send(JSON.stringify({ id, result: { closed: 0 } }));
      }
    });
    expect((await bound()).status).toBe(200);
    expect(readDispatched).toBe(true);

    // Revoke while all-targets is awaiting the extension, after the relay's initial check.
    const dispatched = new Promise<number>((resolve) => { holdRead = resolve; });
    const inFlight = bound();
    const id = await dispatched;
    await setSsh(approved, false);
    holdRead = undefined;
    approved.send(JSON.stringify({ id, result: { targets: [] } }));
    expect((await inFlight).status).toBe(409);
    const local = await health();
    expect(local.extensionConnected).toBe(true);
    expect(local.sshAccessEnabled).toBe(false);
    expect((await bound()).status).toBe(409);
    expect((await fetch(base + "/all-targets", { headers })).status).toBe(200);
    await setSsh(approved, true);
    expect((await health()).extensionConnectionId).not.toBe(first.extensionConnectionId);
    expect((await bound()).status).toBe(409);

    const disconnected = once(approved, "close");
    approved.close();
    await disconnected;
    expect((await bound()).status).toBe(409);
    expect((await health()).extensionConnected).toBe(false);
    const reconnected = await connect();
    await setSsh(reconnected, true);
    expect((await bound()).status).toBe(409);
    expect((await health()).extensionConnectionId).not.toBe(first.extensionConnectionId);
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.stop();
    vi.unstubAllEnvs();
  }
});

test("an operator on the relay host approves a profile announced without a local helper", async () => {
  const state = mkdtempSync(join(tmpdir(), "dev-browser-host-approval-"));
  vi.stubEnv("DEV_BROWSER_DIR", state);
  writeFileSync(join(state, "token"), token, { mode: 0o600 });
  const port = randomPort();
  const relay = await serveRelay({ port, token });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "X-DevBrowser-Token": token, "Content-Type": "application/json" };
  const id = createHash("sha256").update(credential).digest("hex");
  const approve = (fingerprint: string, extra: Record<string, string> = {}) =>
    fetch(base + "/pairing/approve", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ fingerprint }),
    });
  const sockets: WebSocket[] = [];
  try {
    const unpaired = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
    sockets.push(unpaired);
    await once(unpaired, "open");
    unpaired.send(JSON.stringify({ method: "requestPairing", fingerprint: id }));
    unpaired.send(JSON.stringify({ method: "requestPairing", fingerprint: "not hex" }));

    const pending = async () => (await (await fetch(base + "/pairing/pending", { headers })).json()) as {
      profileId: string | null;
      pending: string[];
    };
    await vi.waitFor(async () => expect((await pending()).pending).toEqual([id]));
    expect((await fetch(base + "/pairing/pending", { headers: { ...headers, Origin: origin } })).status).toBe(403);
    expect((await approve(id.slice(0, 8), { Origin: origin })).status).toBe(403);
    expect((await approve(id.slice(0, 7))).status).toBe(409);
    expect((await approve("0".repeat(8))).status).toBe(409);

    const closed = once(unpaired, "close");
    const approved = await approve(id.slice(0, 12));
    expect(approved.status).toBe(201);
    expect(await approved.json()).toEqual({ profileId: id });
    expect((await closed)[0]).toBe(1008);
    expect(await pending()).toEqual({ profileId: id, pending: [] });
    expect(createProfilePairing(state).profileId).toBe(id);
    expect((await approve(id)).status).toBe(409);

    const paired = new WebSocket(`ws://127.0.0.1:${port}/extension/paired`, { origin });
    sockets.push(paired);
    await once(paired, "open");
    const acknowledged = once(paired, "message");
    paired.send(JSON.stringify({ credential }));
    expect(String((await acknowledged)[0])).toBe('{"method":"paired"}');
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.stop();
    vi.unstubAllEnvs();
  }
});
