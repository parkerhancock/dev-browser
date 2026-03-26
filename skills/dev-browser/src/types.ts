// API request/response types and shared constants — used by client, server, and relay.

import type { Context } from "hono";

// Session and tab limit constants
export const SESSION_HEADER = "X-DevBrowser-Session";
export const TAB_WARNING_THRESHOLD = 3;
export const TAB_LIMIT = 5;

/** Extract the agent session ID from a Hono request context. */
export function getAgentSession(c: Context): string {
  return c.req.header(SESSION_HEADER) ?? "default";
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
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
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
}
