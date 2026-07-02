/**
 * Shared mock-extension harness for relay integration tests.
 *
 * Simulates the Chrome extension side of the relay protocol over WebSocket:
 * responds to forwarded CDP commands and emits CDP events, without a browser.
 */

import WebSocket from "ws";

/** Pick a random port to avoid conflicts between parallel test runs */
export function randomPort(): number {
  return 19000 + Math.floor(Math.random() * 10000);
}

/** Wait for a condition with timeout */
export async function waitFor(
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
export async function fetchJson(
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
export class MockExtension {
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

  /** CDP commands forwarded to this mock, in arrival order */
  forwardedCdpCommands(): Array<{ method: string; params?: Record<string, unknown> }> {
    return this.received
      .filter((m) => m.method === "forwardCDPCommand")
      .map((m) => m.params as { method: string; params?: Record<string, unknown> });
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
        void (cdpParams as { targetId: string })?.targetId;
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
