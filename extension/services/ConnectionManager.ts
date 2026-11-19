/**
 * ConnectionManager - Manages WebSocket connection to relay server.
 */

import type { Logger } from "../utils/logger";
import type { ExtensionCommandMessage, ExtensionResponseMessage } from "../utils/types";
import { detectBrowser } from "../utils/browser-info";

const RELAY_URL = "ws://localhost:9224/extension";
const PAIRING_STORAGE_KEY = "devBrowserProfileCredential";

const CANDIDATE_STORAGE_KEY = "devBrowserPendingProfileCredential";
const APPROVAL_STORAGE_KEY = "devBrowserSshApproved";
const RELAY_HOST_APPROVAL_KEY = "devBrowserRelayHostApproval";

export async function hasSshApproval(): Promise<boolean> {
  return (await chrome.storage.local.get(APPROVAL_STORAGE_KEY))[APPROVAL_STORAGE_KEY] === true;
}

/** SHA-256 of a profile credential: the profile ID the relay stores and the operator compares. */
export async function profileFingerprint(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The fingerprint awaiting approval on the relay host, if this profile chose that route. */
export async function relayHostApprovalFingerprint(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get([RELAY_HOST_APPROVAL_KEY, CANDIDATE_STORAGE_KEY]);
  const candidate = stored[CANDIDATE_STORAGE_KEY];
  return stored[RELAY_HOST_APPROVAL_KEY] === true && typeof candidate === "string"
    ? profileFingerprint(candidate)
    : undefined;
}

async function promoteCandidate(credential: string): Promise<void> {
  await chrome.storage.local.set({
    [PAIRING_STORAGE_KEY]: credential,
    [APPROVAL_STORAGE_KEY]: true,
  });
  await chrome.storage.local.remove([CANDIDATE_STORAGE_KEY, RELAY_HOST_APPROVAL_KEY]);
}

/**
 * Approve this profile through the local Dev Browser host. Without that host
 * (for example a relay reached through an SSH forward), the candidate waits
 * for an operator on the relay host to run `dev-browser pairing approve`.
 */
export async function allowSshAccess(): Promise<"approved" | "relay-host"> {
  const stored = await chrome.storage.local.get([PAIRING_STORAGE_KEY, CANDIDATE_STORAGE_KEY]);
  const credential: string = (stored[PAIRING_STORAGE_KEY] as string | undefined) ??
    (stored[CANDIDATE_STORAGE_KEY] as string | undefined) ?? Array.from(
    crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  await chrome.storage.local.set({ [CANDIDATE_STORAGE_KEY]: credential });
  let response: { approved?: boolean; error?: string };
  try {
    response = await chrome.runtime.sendNativeMessage("com.dev_browser.chrome", { credential });
  } catch {
    await chrome.storage.local.set({ [RELAY_HOST_APPROVAL_KEY]: true });
    return "relay-host";
  }
  if (response?.approved !== true) {
    throw new Error(response?.error ?? "SSH access could not be approved");
  }
  await promoteCandidate(credential);
  return "approved";
}

const RECONNECT_INTERVAL = 3000;

export interface ConnectionManagerDeps {
  logger: Logger;
  onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  onDisconnect: () => void;
  /** The relay host approved this profile; SSH access is now on. */
  onApproved?: () => void;
}

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private pendingSocket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldMaintain = false;
  private connecting = false;
  private sshEnabled = false;
  private sshAcknowledged = false;
  private sshTimer: ReturnType<typeof setTimeout> | undefined;
  private intentionalDisconnect = false;
  private logger: Logger;
  private onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  private onDisconnect: () => void;
  private onApproved?: () => void;

  constructor(deps: ConnectionManagerDeps) {
    this.logger = deps.logger;
    this.onMessage = deps.onMessage;
    this.onDisconnect = deps.onDisconnect;
    this.onApproved = deps.onApproved;
  }

  /**
   * Check if WebSocket is open (may be stale if server crashed).
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isSshConnected(): boolean {
    return this.isConnected() && this.sshEnabled && this.sshAcknowledged;
  }

  setSshAccess(enabled: boolean): void {
    this.sshEnabled = enabled;
    if (!this.ws || !this.isConnected()) return;
    if (enabled === this.sshAcknowledged && !this.sshTimer) return;
    this.send({ method: "setSshAccess", enabled });
    clearTimeout(this.sshTimer);
    // If revocation cannot be acknowledged, close the connection and reconnect locally.
    const socket = this.ws;
    this.sshTimer = setTimeout(() => socket.close(), 1500);
  }

  /**
   * Validate connection by checking if server is reachable.
   * More reliable than isConnected() as it detects server crashes.
   */
  async checkConnection(): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    // Verify server is actually reachable
    try {
      const response = await fetch("http://localhost:9224", {
        method: "HEAD",
        signal: AbortSignal.timeout(1000),
      });
      return this.isConnected() && (response.ok || response.status === 401);
    } catch {
      // Server unreachable - close stale socket but preserve tab state for recovery
      if (this.ws) {
        this.ws.close();
        this.ws = null;
        // Don't call onDisconnect - preserve debugger attachments for recovery
      }
      return false;
    }
  }

  /**
   * Send a message to the relay server.
   */
  send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        console.debug("Error sending message:", error);
      }
    }
  }

  /**
   * Start maintaining connection (auto-reconnect).
   * Idempotent: if already maintaining, this is a no-op.
   */
  startMaintaining(): void {
    this.shouldMaintain = true;
    // Already maintaining — don't create overlapping loops
    if (this.reconnectTimer || this.connecting) return;
    this.runReconnectCycle();
  }

  /**
   * Run one reconnect cycle: try to connect, then schedule the next attempt.
   * Only schedules the next cycle after the current attempt completes.
   */
  private runReconnectCycle(): void {
    if (!this.shouldMaintain || this.isConnected()) return;

    this.tryConnect()
      .catch(() => {})
      .finally(() => {
        // Schedule next attempt only if still needed and not already connected
        if (this.shouldMaintain && !this.isConnected()) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.runReconnectCycle();
          }, RECONNECT_INTERVAL);
        }
      });
  }

  /**
   * Stop connection maintenance.
   */
  stopMaintaining(): void {
    this.shouldMaintain = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Disconnect from relay and stop maintaining connection.
   * This is an intentional disconnect that will trigger onDisconnect callback.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopMaintaining();
    clearTimeout(this.sshTimer);
    this.sshTimer = undefined;
    this.sshAcknowledged = false;
    this.pendingSocket?.close();
    this.pendingSocket = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onDisconnect();
    this.intentionalDisconnect = false;
  }

  /**
   * Ensure connection is established, waiting if needed.
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;

    await this.tryConnect();

    if (!this.isConnected()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.tryConnect();
    }

    if (!this.isConnected()) {
      throw new Error("Could not connect to relay server");
    }
  }

  /**
   * Try to connect to relay server once.
   */
  private async tryConnect(): Promise<void> {
    if (this.isConnected() || this.connecting) return;

    this.connecting = true;
    try {
      const stored = await chrome.storage.local.get([
        PAIRING_STORAGE_KEY,
        CANDIDATE_STORAGE_KEY,
        RELAY_HOST_APPROVAL_KEY,
      ]);
      if (!this.shouldMaintain) return;
      let credential = stored[PAIRING_STORAGE_KEY] as string | undefined;
      const candidate = !credential && stored[RELAY_HOST_APPROVAL_KEY] === true
        ? (stored[CANDIDATE_STORAGE_KEY] as string | undefined)
        : undefined;
      let socket: WebSocket;
      if (candidate) {
        // Once the relay host approves the candidate, it pairs like a saved credential.
        try {
          socket = await this.open(RELAY_URL + "/paired", candidate);
          await promoteCandidate(candidate);
          credential = candidate;
          // The user asked for SSH access when approval began; finish turning it on.
          this.sshEnabled = true;
          this.onApproved?.();
        } catch {
          if (!this.shouldMaintain) return;
          socket = await this.open(RELAY_URL);
          socket.send(JSON.stringify({ method: "requestPairing", fingerprint: await profileFingerprint(candidate) }));
        }
      } else {
        socket = await this.open(credential ? RELAY_URL + "/paired" : RELAY_URL, credential);
      }

      if (!this.shouldMaintain || this.pendingSocket !== socket) {
        socket.close();
        return;
      }
      this.ws = socket;
      this.setupSocketHandlers(socket);
      this.sshAcknowledged = false;
      if (credential && this.sshEnabled) this.setSshAccess(true);
      this.logger.log("Connected to relay server");
      this.send({ method: "browserInfo", params: detectBrowser() });
    } finally {
      if (this.pendingSocket !== this.ws) this.pendingSocket?.close();
      this.pendingSocket = null;
      this.connecting = false;
    }
  }

  /** Open one relay socket; with a credential, wait for the relay's pairing acknowledgement. */
  private async open(url: string, credential?: string): Promise<WebSocket> {
    const socket = new WebSocket(url);
    this.pendingSocket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Connection timeout"));
      }, 5000);
      const finish = (failure?: Error) => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else resolve();
      };

      socket.onopen = () => {
        if (credential) socket.send(JSON.stringify({ credential }));
        else finish();
      };
      socket.onmessage = (event) => {
        if (event.data === '{"method":"paired"}') finish();
        else {
          socket.close();
          finish(new Error("Invalid pairing acknowledgement"));
        }
      };
      socket.onerror = () => finish(new Error("WebSocket connection failed"));
      socket.onclose = () => finish(new Error("WebSocket connection closed"));
    });
    return socket;
  }

  /**
   * Set up WebSocket event handlers.
   */
  private setupSocketHandlers(socket: WebSocket): void {
    socket.onmessage = async (event: MessageEvent) => {
      if (this.ws !== socket || !this.shouldMaintain) return;
      let message: ExtensionCommandMessage | { method: "sshAccess"; enabled: boolean };
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        this.logger.debug("Error parsing message:", error);
        this.send({
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      if (message.method === "sshAccess") {
        this.sshAcknowledged = message.enabled;
        if (message.enabled === this.sshEnabled) {
          clearTimeout(this.sshTimer);
          this.sshTimer = undefined;
        }
        return;
      }

      const response: ExtensionResponseMessage = { id: message.id };
      try {
        response.result = await this.onMessage(message);
      } catch (error) {
        this.logger.debug("Error handling command:", error);
        response.error = (error as Error).message;
      }
      if (this.ws === socket) this.send(response);
    };

    socket.onclose = (event: CloseEvent) => {
      this.logger.debug("Connection closed:", event.code, event.reason);
      // Only clear ws if this closing socket is still the active one.
      // Prevents race condition where old socket's onclose overwrites new socket reference.
      if (this.ws === socket) {
        clearTimeout(this.sshTimer);
        this.sshTimer = undefined;
        this.sshAcknowledged = false;
        this.ws = null;
      }
      // Only trigger onDisconnect for intentional disconnects
      // For unexpected disconnects (network issues, server restart), preserve tab state
      if (this.intentionalDisconnect) {
        this.onDisconnect();
      }
      // Code 4001 means the relay replaced this connection with a newer one
      // from this same extension. Don't reconnect — the new connection is already active.
      if (event.code === 4001) {
        this.logger.debug("Replaced by newer connection, skipping reconnect");
        return;
      }
      // Only reconnect if this was the active socket and we should maintain
      if (this.ws === null && this.shouldMaintain) {
        this.startMaintaining();
      }
    };

    socket.onerror = (event: Event) => {
      this.logger.debug("WebSocket error:", event);
    };
  }
}
