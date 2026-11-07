/**
 * A browser-level CDP connection for the few commands Playwright doesn't
 * expose on a persistent context (which has no Browser object to open a
 * browser CDP session from).
 */

export interface BrowserCdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export function connectBrowserCdp(wsEndpoint: string): BrowserCdp {
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let socket: Promise<WebSocket> | null = null;

  const open = (): Promise<WebSocket> => {
    socket ??= new Promise((resolve, reject) => {
      const ws = new WebSocket(wsEndpoint);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error(`Browser CDP connection to ${wsEndpoint} failed`));
      ws.onclose = () => {
        socket = null;
        for (const { reject: fail } of pending.values()) fail(new Error("Browser CDP connection closed"));
        pending.clear();
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        const waiter = msg.id === undefined ? undefined : pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id!);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
      };
    });
    return socket;
  };

  return {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const ws = await open();
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      void socket?.then((ws) => ws.close()).catch(() => {});
    },
  };
}
