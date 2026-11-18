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

export async function hasSshApproval(): Promise<boolean> {
  return (await chrome.storage.local.get(APPROVAL_STORAGE_KEY))[APPROVAL_STORAGE_KEY] === true;
}

export async function allowSshAccess(): Promise<void> {
  const stored = await chrome.storage.local.get([PAIRING_STORAGE_KEY, CANDIDATE_STORAGE_KEY]);
  const credential = stored[PAIRING_STORAGE_KEY] ?? stored[CANDIDATE_STORAGE_KEY] ?? Array.from(
    crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  await chrome.storage.local.set({ [CANDIDATE_STORAGE_KEY]: credential });
  let response: { approved?: boolean; error?: string };
  try {
    response = await chrome.runtime.sendNativeMessage("com.dev_browser.chrome", { credential });
  } catch {
    throw new Error("Could not reach the local Dev Browser host. Check the Dev Browser installation.");
  }
  if (response?.approved !== true) {
    throw new Error(response?.error ?? "SSH access could not be approved");
  }
  await chrome.storage.local.set({
    [PAIRING_STORAGE_KEY]: credential,
    [APPROVAL_STORAGE_KEY]: true,
  });
  await chrome.storage.local.remove(CANDIDATE_STORAGE_KEY);
}

const RECONNECT_INTERVAL = 3000;

export interface ConnectionManagerDeps {
  logger: Logger;
  onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  onDisconnect: () => void;
}

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private pendingSocket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldMaintain = false;
  private connecting = false;
  private intentionalDisconnect = false;
  private logger: Logger;
  private onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  private onDisconnect: () => void;

  constructor(deps: ConnectionManagerDeps) {
    this.logger = deps.logger;
    this.onMessage = deps.onMessage;
    this.onDisconnect = deps.onDisconnect;
  }

  /**
   * Check if WebSocket is open (may be stale if server crashed).
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
      const stored = await chrome.storage.local.get(PAIRING_STORAGE_KEY);
      if (!this.shouldMaintain) return;
      const credential = stored[PAIRING_STORAGE_KEY];
      const socket = new WebSocket(credential ? RELAY_URL + "/paired" : RELAY_URL);
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

      if (!this.shouldMaintain || this.pendingSocket !== socket) {
        socket.close();
        return;
      }
      this.ws = socket;
      this.setupSocketHandlers(socket);
      this.logger.log("Connected to relay server");
      this.send({ method: "browserInfo", params: detectBrowser() });
    } finally {
      if (this.pendingSocket !== this.ws) this.pendingSocket?.close();
      this.pendingSocket = null;
      this.connecting = false;
    }
  }

  /**
   * Set up WebSocket event handlers.
   */
  private setupSocketHandlers(socket: WebSocket): void {
    socket.onmessage = async (event: MessageEvent) => {
      if (this.ws !== socket || !this.shouldMaintain) return;
      let message: ExtensionCommandMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        this.logger.debug("Error parsing message:", error);
        this.send({
          error: { code: -32700, message: "Parse error" },
        });
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
