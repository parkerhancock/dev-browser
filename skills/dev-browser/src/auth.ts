/**
 * Shared-secret auth for the relay (and any future local HTTP surface).
 *
 * A random token lives at ~/.dev-browser/token (0600). The relay generates it
 * on first start and requires it on every HTTP request and WebSocket upgrade;
 * the client reads the same file. This keeps other local users and web pages
 * (via fetch/WebSocket from a browser) from driving tabs on the relay port.
 * A same-user local process can read the token file — that residual risk is
 * accepted until the native-messaging-host design lands.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "X-DevBrowser-Token";

export function devBrowserDir(): string {
  return process.env.DEV_BROWSER_DIR ?? join(homedir(), ".dev-browser");
}

/** Path to the token file (respects DEV_BROWSER_DIR for test isolation). */
export function tokenFilePath(): string {
  return join(devBrowserDir(), "token");
}

/**
 * Read the token if it exists; null otherwise. Never creates.
 * DEV_BROWSER_TOKEN overrides the file — that's how a client on a different
 * machine (or a container) gets the token without sharing a filesystem.
 */
export function loadToken(): string | null {
  const fromEnv = process.env.DEV_BROWSER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const value = readFileSync(tokenFilePath(), "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Read the token, generating and persisting one (0600) if missing. */
export function loadOrCreateToken(): string {
  const existing = loadToken();
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  mkdirSync(devBrowserDir(), { recursive: true });
  writeFileSync(tokenFilePath(), `${token}\n`, { mode: 0o600 });
  if (existsSync(tokenFilePath())) {
    try {
      chmodSync(tokenFilePath(), 0o600);
    } catch {
      // Windows: chmod is a no-op; mkdir/write already succeeded
    }
  }
  return token;
}

/** Constant-time string comparison. */
export function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Auth headers for client requests to the relay. Empty when no token file
 * exists yet (the relay creates one on first start, so this only happens
 * when connecting before any relay has ever run).
 */
export function authHeaders(): Record<string, string> {
  const token = loadToken();
  return token ? { [TOKEN_HEADER]: token } : {};
}
