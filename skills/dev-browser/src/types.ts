// API request/response types and shared constants — used by client, server, and relay.

import type { Context } from "hono";

// Session and tab limit constants
export const SESSION_HEADER = "X-DevBrowser-Session";
export const TAB_WARNING_THRESHOLD = 3;
export const TAB_LIMIT = 5;

/** Extract the agent session ID from a Hono request context (header first, then `session` query param). */
export function getAgentSession(c: Context): string {
  return c.req.header(SESSION_HEADER) ?? c.req.query("session") ?? "default";
}

/** Validate a page name. Returns an error string or null if valid. */
export function validatePageName(name: unknown): string | null {
  if (!name || typeof name !== "string") return "name is required and must be a string";
  if (name.length === 0) return "name cannot be empty";
  if (name.length > 256) return "name must be 256 characters or less";
  return null;
}

/** Add a timeout to any promise. Rejects with the given message on expiry. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

export interface ServeOptions {
  port?: number;
  headless?: boolean;
  cdpPort?: number;
  /**
   * Interface to bind the HTTP API to. Default "127.0.0.1"; use "0.0.0.0"
   * inside a container. Chromium's own CDP port always stays on loopback —
   * remote clients reach it only through the authenticated /cdp proxy.
   */
  host?: string;
  /** Require X-DevBrowser-Token on every request and WS upgrade. Default true. */
  requireAuth?: boolean;
  /**
   * Optional raw Node handler mounted at ALL /mcp — lets the CLI serve the
   * MCP streamable-HTTP endpoint from the same port without this package
   * depending on the mcp-server package.
   */
  mcpHandler?: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void | Promise<void>;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /**
   * Named profile. Each name gets its own persistent data directory
   * (".browser-data-<name>"), so "work" and "personal" state stay separate.
   */
  profile?: string;
  /**
   * Which browser to launch. "chromium" (default) is Playwright's bundled
   * Chromium; the others use a locally installed branded browser via
   * Playwright's channel mechanism.
   */
  browser?: "chromium" | "chrome" | "msedge";
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface GetPageRequest {
  name: string;
  /** Optional viewport size for new pages */
  viewport?: ViewportSize;
  /** Pin this page to exempt it from idle cleanup (for human collaboration) */
  pinned?: boolean;
  /** Extension mode: bind the name to this existing Chrome tab instead of creating one */
  tabId?: number;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
  /**
   * Path of the server's own authenticated CDP WebSocket proxy (e.g. "/cdp").
   * Clients derive the full WS URL from the HTTP URL they dialed, which works
   * across Docker/port-forwarding/TLS; `wsEndpoint` is kept for old clients.
   */
  wsPath?: string;
}
