/**
 * ConnectionManager - Manages WebSocket connection to relay server.
 */

import type { Logger } from "../utils/logger";
import type { ExtensionCommandMessage, ExtensionResponseMessage } from "../utils/types";

const RELAY_URL = "ws://localhost:9224/extension";
const RECONNECT_INTERVAL = 3000;

export interface ConnectionManagerDeps {
  logger: Logger;
  onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  onConnect: () => void;
  onDisconnect: () => void;
}

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldMaintain = false;
  private connecting = false;
  private replacedUntil = 0; // Timestamp until which we should not reconnect (after 4001)
  private logger: Logger;
  private onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  private onConnect: () => void;
  private onDisconnect: () => void;

  constructor(deps: ConnectionManagerDeps) {
    this.logger = deps.logger;
    this.onMessage = deps.onMessage;
    this.onConnect = deps.onConnect;
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
      return response.ok;
    } catch {
      // Server unreachable - close stale socket
      if (this.ws) {
        this.ws.close();
        this.ws = null;
        this.onDisconnect();
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
   */
  startMaintaining(): void {
    this.shouldMaintain = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Skip reconnect if we were recently replaced (backoff period)
    if (Date.now() < this.replacedUntil) {
      this.logger.debug("Skipping reconnect - in replacement backoff period");
      const remaining = this.replacedUntil - Date.now();
      this.reconnectTimer = setTimeout(() => this.startMaintaining(), remaining + 100);
      return;
    }

    this.tryConnect().catch(() => {});
    this.reconnectTimer = setTimeout(() => this.startMaintaining(), RECONNECT_INTERVAL);
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
   */
  disconnect(): void {
    this.stopMaintaining();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onDisconnect();
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
    if (this.isConnected()) return;
    if (this.connecting) return;

    // Check if server is available
    try {
      await fetch("http://localhost:9224", { method: "HEAD" });
    } catch {
      return;
    }

    this.connecting = true;
    this.logger.debug("Connecting to relay server...");
    const socket = new WebSocket(RELAY_URL);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, 5000);

        socket.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        };

        socket.onclose = (event) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket closed: ${event.reason || event.code}`));
        };
      });

      this.ws = socket;
      this.setupSocketHandlers(socket);
      this.logger.log("Connected to relay server");
      this.onConnect();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Set up WebSocket event handlers.
   */
  private setupSocketHandlers(socket: WebSocket): void {
    socket.onmessage = async (event: MessageEvent) => {
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
      this.send(response);
    };

    socket.onclose = (event: CloseEvent) => {
      this.logger.debug("Connection closed:", event.code, event.reason);
      this.ws = null;

      // If replaced by another extension instance, set a backoff period
      // This prevents a reconnection loop when reloading the extension
      if (event.code === 4001) {
        this.logger.debug("Connection replaced, entering backoff period");
        this.replacedUntil = Date.now() + 10000;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        return;
      }

      this.onDisconnect();
      if (this.shouldMaintain) {
        this.startMaintaining();
      }
    };

    socket.onerror = (event: Event) => {
      this.logger.debug("WebSocket error:", event);
    };
  }
}
