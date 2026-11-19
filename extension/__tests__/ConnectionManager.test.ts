import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  ConnectionManager,
  allowSshAccess,
  hasSshApproval,
  relayHostApprovalFingerprint,
} from "../services/ConnectionManager";

/** A relay that pairs one fingerprint once an operator approves it. */
class FakeRelay {
  approved?: string;
  requests: unknown[] = [];
  sockets: FakeSocket[] = [];
}

const relay = new FakeRelay();

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    relay.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }
  send(data: string): void {
    const message = JSON.parse(data);
    if (this.url.endsWith("/paired") && "credential" in message) {
      const id = createHash("sha256").update(message.credential).digest("hex");
      if (id === relay.approved) this.onmessage?.({ data: '{"method":"paired"}' });
      else this.close(1008);
    } else relay.requests.push(message);
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

describe("relay-host approval", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    relay.approved = undefined;
    relay.requests = [];
    relay.sockets = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    // No native messaging host is installed on this computer.
    vi.spyOn(chrome.runtime, "sendNativeMessage").mockRejectedValue(new Error("host not found"));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("announces the fingerprint, then pairs once the relay host approves it", async () => {
    expect(await allowSshAccess()).toBe("relay-host");
    expect(await hasSshApproval()).toBe(false);
    const fingerprint = await relayHostApprovalFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);

    const manager = new ConnectionManager({
      logger: { log() {}, debug() {}, error() {} } as never,
      onMessage: async () => undefined,
      onDisconnect() {},
    });
    manager.startMaintaining();
    await vi.waitFor(() => expect(manager.isConnected()).toBe(true));
    expect(relay.sockets.map((s) => s.url)).toEqual([
      "ws://localhost:9224/extension/paired",
      "ws://localhost:9224/extension",
    ]);
    expect(relay.requests).toContainEqual({ method: "requestPairing", fingerprint });

    // The operator approves; the relay closes the unpaired socket.
    relay.approved = fingerprint;
    relay.sockets.at(-1)!.close(1008);
    manager.setSshAccess(true);
    await vi.waitFor(() => expect(relay.sockets.at(-1)!.url).toBe("ws://localhost:9224/extension/paired"), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(manager.isConnected()).toBe(true));
    expect(await hasSshApproval()).toBe(true);
    expect(await relayHostApprovalFingerprint()).toBeUndefined();
    expect(relay.requests).toContainEqual({ method: "setSshAccess", enabled: true });
    manager.disconnect();
  });
});
