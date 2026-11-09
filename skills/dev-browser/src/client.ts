/**
 * dev-browser client: connect() and the public client types. Each mode's
 * implementation lives under ./client/ (extension.ts, standalone.ts).
 */

import type { ElementHandle } from "patchright";
import type { ViewportSize } from "./types";
import type { Page } from "./page.js";
import type { EmulateOptions } from "./emulation.js";
import { createLogger } from "./logging.js";
import { wrapWithCleanErrors } from "./errors.js";
import { authHeaders, TOKEN_HEADER } from "./auth.js";
import type { ConsoleMessage, DownloadRecord } from "./relay.js";
import type { HarEntry, HarLog } from "./har.js";
import { connectExtensionMode } from "./client/extension.js";
import { connectStandaloneMode } from "./client/standalone.js";

const logger = createLogger("client");

// Re-export for consumers
export type { Page, Locator, Keyboard, Mouse } from "./page.js";
export { detectChallenge, classifyNavigationError } from "./challenge.js";
export type { Challenge, ChallengeVendor, NavigationErrorKind } from "./challenge.js";
export { CDPPage, CDPFrame } from "./cdp-page.js";
export type { CDPCommandOptions } from "./cdp-page.js";
export type { HarCookie, HarPostData, HarContent, HarEntry, HarLog } from "./har.js";

// Re-export so consumers can type console results without importing relay
export type { ConsoleMessage, DownloadRecord } from "./relay.js";
export { waitForPageLoad, navigateTo } from "./client/navigation.js";
export type { WaitForPageLoadOptions, WaitForPageLoadResult, NavigateOptions, NavigateResult } from "./client/navigation.js";
export { saveWacz, saveArchive } from "./client/archive.js";
export type { SaveWaczOptions, SaveArchiveOptions } from "./client/archive.js";

/** A connected browser, as reported by listBrowsers(). */
export interface BrowserInfo {
  /** "chrome" | "msedge" | "brave" | "chromium" | ... */
  browser: string;
  version?: string;
  userAgent?: string;
  connected: boolean;
}

/** A single CDP operation for client.batch(). */
export interface BatchOp {
  method: string;
  params?: Record<string, unknown>;
}

/** Result of one batched CDP operation. */
export interface BatchOpResult {
  result?: unknown;
  error?: string;
}

/** A live network log line derived from the HAR recorder. */
export interface NetworkRequest {
  /** Index in the page's request log; pass to getHarEntries({ since: id }) for the full entry and body. */
  id: number;
  method: string;
  url: string;
  status: number;
  statusText?: string;
  mimeType?: string;
  startedDateTime: string;
  timeMs: number;
}

/** A match from client.find() — a snapshot line plus its interaction ref. */
export interface FindMatch {
  /** Ref usable with clickRef/fillRef/selectSnapshotRef (absent for static text). */
  ref?: string;
  line: string;
}

/** Cookies + localStorage for one origin (exportOriginState/importOriginState). */
export interface OriginState {
  origin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cookies: any[];
  localStorage: Record<string, string>;
}

/**
 * Options for waiting for page load
 */

/** Server mode information */
export interface ServerInfo {
  wsEndpoint: string;
  mode: "launch" | "extension";
  extensionConnected?: boolean;
}

/**
 * Options for creating or getting a page
 */
export interface PageOptions {
  /** Viewport size for new pages */
  viewport?: ViewportSize;
  /** Whether to auto-start HAR recording for this page (default: true) */
  record?: boolean;
  /** Pin this page to exempt it from idle cleanup (default: false).
   *  Use for human collaboration — pinned pages stay open until explicitly closed. */
  pinned?: boolean;
  /** Extension mode only: bind the name to an existing tab (a tabId from allTargets()),
   *  e.g. a tab the user signed in on. Rebinds the name if it points at another tab. */
  tabId?: number;
}

/** Default ports for each server mode */
const DEFAULT_PORTS = {
  standalone: 9222,
  extension: 9224,
} as const;

/**
 * Options for connecting to the dev-browser server
 */
export interface ConnectOptions {
  /**
   * Server mode. Determines which port to connect to if serverUrl is not specified.
   * - "standalone": Fresh Chromium browser (port 9222)
   * - "extension": User's Chrome via extension (port 9224)
   * @default "standalone"
   */
  mode?: "standalone" | "extension";
  /**
   * Session ID for multi-agent isolation.
   * Each session has its own namespace for page names.
   *
   * Priority if not provided:
   * 1. CLAUDE_SESSION_ID env var (set by SessionStart hook for automatic per-agent persistence)
   * 2. Auto-generated unique session ID
   */
  session?: string;
  /**
   * Create an ephemeral session that auto-closes all pages on disconnect.
   * Useful for quick one-off browser tasks that shouldn't persist.
   *
   * When true:
   * - Generates a unique session ID (ignores `session` and CLAUDE_SESSION_ID)
   * - All pages are automatically closed when disconnect() is called
   * - Pages won't count against your persistent session's tab limit
   *
   * @default false
   *
   * @example
   * ```typescript
   * // Quick lookup that auto-cleans up
   * const client = await connect({ ephemeral: true });
   * const page = await client.page("lookup");
   * await page.goto("https://example.com");
   * const title = await page.title();
   * await client.disconnect(); // Page automatically closed
   * ```
   */
  ephemeral?: boolean;
  /**
   * Auth token for the server. Defaults to DEV_BROWSER_TOKEN or the local
   * ~/.dev-browser/token file; pass it explicitly when connecting to a
   * dev-browser server on another machine or in a container.
   */
  token?: string;
  /**
   * Require the connected browser to match this label (e.g. "chrome",
   * "msedge", "brave"). Throws at connect time when the server or relay is
   * driving a different browser, or (extension mode) when no browser is
   * connected. Omit to accept whatever is running.
   */
  browser?: string;
}

/**
 * Browser target info returned by allTargets()
 */
export interface BrowserTarget {
  tabId: number;
  targetId?: string;
  url: string;
  title: string;
}

export interface DevBrowserClient {
  page: (name: string, options?: PageOptions) => Promise<Page>;
  list: () => Promise<string[]>;
  close: (name: string) => Promise<void>;
  /**
   * Pin or unpin a page. Pinned pages are exempt from idle cleanup.
   * Use for human collaboration — the idle timer can't detect non-CDP activity.
   * @param name - Page name
   * @param pinned - true to pin (default), false to unpin
   */
  pin: (name: string, pinned?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Get AI-friendly ARIA snapshot for a page.
   * Returns YAML format with refs like [ref=e1], [ref=e2].
   * Refs are stored on window.__devBrowserRefs for cross-connection persistence.
   */
  getAISnapshot: (name: string) => Promise<string>;
  /**
   * Get an element handle by its ref from the last getAISnapshot call.
   * Refs persist across Playwright connections.
   */
  selectSnapshotRef: (name: string, ref: string) => Promise<ElementHandle | null>;
  /**
   * Get server information including mode and extension connection status.
   */
  getServerInfo: () => Promise<ServerInfo>;
  /**
   * Get the session ID for this client.
   */
  getSession: () => string;
  /**
   * List all browser tabs (bypasses session isolation).
   * Useful for discovering orphaned tabs or tabs from other sessions.
   */
  allTargets: () => Promise<BrowserTarget[]>;
  /**
   * Close a specific tab by tabId.
   * Use allTargets() to get tabIds.
   */
  closeTarget: (tabId: number) => Promise<void>;
  /**
   * Close all tabs matching a URL pattern (regex).
   * Returns the count and URLs of closed tabs.
   */
  cleanup: (pattern: string) => Promise<{ closed: number; urls: string[] }>;
  /**
   * Close all pages in the current session.
   * Use this for explicit cleanup when done with browser automation.
   * Returns the names of closed pages.
   *
   * @example
   * ```typescript
   * const client = await connect({ session: "my-session" });
   * // ... do browser work ...
   * await client.closeAll(); // Clean up all pages
   * await client.disconnect();
   * ```
   */
  closeAll: () => Promise<{ closed: number; pages: string[] }>;
  /**
   * Start recording network traffic to a HAR.
   * Uses CDP Network events directly.
   *
   * In extension mode, recording state lives on the relay; if a recording is
   * already active for the page this is a no-op. In standalone mode, throws
   * if recording is already active for this page.
   *
   * @param name - Page name
   */
  startHarRecording: (name: string) => Promise<void>;
  /**
   * Stop HAR recording and return the HAR data.
   *
   * @param name - Page name
   * @returns HAR log object
   * @throws Error if no recording is active for this page
   */
  stopHarRecording: (name: string) => Promise<HarLog>;
  /**
   * Check if HAR recording is active for a page.
   *
   * In extension mode, queries the relay (the source of truth); in standalone
   * mode, reflects this client's local recorders.
   */
  isRecordingHar: (name: string) => Promise<boolean>;
  /**
   * Peek at the HAR entries captured so far without stopping the recorder.
   * Useful for inspecting a SPA's network traffic live, across separate
   * script runs.
   *
   * For incremental polling, pass the `total` from a previous call as
   * `options.since`: only entries at index >= since are returned, while
   * `total` always reflects the full completed count.
   *
   * Entries become visible once their response finishes loading; requests
   * still in flight are not included until they complete.
   *
   * @param name - Page name
   * @throws Error if no recording is active for this page
   */
  getHarEntries: (
    name: string,
    options?: { since?: number }
  ) => Promise<{ entries: HarEntry[]; total: number }>;
  /**
   * Execute several CDP commands against a page in one round trip.
   * Stops at the first failing op; `completed` counts the ops that succeeded.
   */
  batch: (
    name: string,
    ops: BatchOp[]
  ) => Promise<{ results: BatchOpResult[]; completed: number }>;
  /**
   * Read console messages captured for a page (console API calls, thrown
   * exceptions, and browser log entries). Capture starts when the page is
   * opened with recording on (the default). `pattern` is a regex applied to
   * the message text; pass a previous `total` as `since` for incremental reads.
   */
  getConsoleMessages: (
    name: string,
    options?: { pattern?: string; since?: number }
  ) => Promise<{ messages: ConsoleMessage[]; total: number }>;
  /**
   * Live network log for a page, derived from the HAR recorder: one line per
   * completed request (method, url, status). `pattern` is a regex applied to
   * the URL; pass a previous `total` as `since` for incremental reads.
   */
  getNetworkRequests: (
    name: string,
    options?: { pattern?: string; since?: number }
  ) => Promise<{ requests: NetworkRequest[]; total: number }>;
  /**
   * Emulate a viewport size, a touch phone or tablet (mobile layout, touch,
   * Android user agent), or a color scheme. `mobile: false` returns to the
   * desktop browser. Lasts while this client stays connected.
   */
  emulate: (name: string, options: EmulateOptions) => Promise<void>;
  /**
   * Find elements on the page whose ARIA-snapshot line contains `query`
   * (case-insensitive). Returns up to 20 matches with refs usable with
   * clickRef/fillRef (extension mode) or selectSnapshotRef (standalone).
   */
  find: (name: string, query: string) => Promise<FindMatch[]>;
  /**
   * Fill several form fields in one call: { "css-selector": "value" }.
   */
  fillForm: (name: string, fields: Record<string, string>) => Promise<void>;
  /** Page main content as Markdown (Turndown over the rendered DOM). */
  markdown: (name: string) => Promise<string>;
  /** Page text content (document.body.innerText). */
  text: (name: string) => Promise<string>;
  /**
   * Grant browser permissions (e.g. "geolocation", "clipboard-read") for an
   * origin. Standalone mode uses the browser context; extension mode
   * forwards Browser.grantPermissions and may be refused by Chrome.
   */
  grantPermissions: (
    name: string,
    origin: string,
    permissions: string[]
  ) => Promise<void>;
  /**
   * Clear browsing data. With `origin`, clears that origin's storage
   * (cookies, local/session storage, IndexedDB, cache storage); without,
   * clears all cookies and the HTTP cache.
   */
  clearBrowsingData: (
    name: string,
    options?: { origin?: string }
  ) => Promise<void>;
  /**
   * Export cookies + localStorage for an origin. localStorage can only be
   * read when the page is currently on that origin.
   */
  exportOriginState: (name: string, origin: string) => Promise<OriginState>;
  /**
   * Import cookies + localStorage captured by exportOriginState.
   * localStorage can only be written when the page is currently on that origin.
   */
  importOriginState: (name: string, state: OriginState) => Promise<void>;
  /**
   * Downloads tracked by the server. Standalone tracks per session; extension
   * mode reports chrome.downloads, which is browser-wide. `since` is an
   * epoch-ms floor on each download's start time.
   */
  getDownloads: (options?: { since?: number }) => Promise<DownloadRecord[]>;
  /**
   * Wait for a download to complete and return its record (with `path` on
   * this machine). By default matches downloads started up to 60s before the
   * call, so it works whether you call it before or after triggering the
   * download; pass `since` (epoch ms) to narrow the window. Throws on
   * interrupted downloads and after `timeoutMs` (default 30s).
   */
  waitForDownload: (options?: {
    since?: number;
    timeoutMs?: number;
  }) => Promise<DownloadRecord>;
  /**
   * Save a completed download's bytes to a local file and return destPath.
   * A DownloadRecord's `path` is a path on the server's machine, so use this
   * when the browser runs remotely (Docker, another host).
   */
  saveDownload: (id: number, destPath: string) => Promise<string>;
  /**
   * List connected browsers. Extension mode reports the browser the extension
   * runs in (chrome/msedge/brave/...); standalone mode reports the launched
   * browser. The relay holds one extension connection, so expect 0 or 1.
   */
  listBrowsers: () => Promise<BrowserInfo[]>;
}

export async function connect(
  serverUrlOrOptions?: string | ConnectOptions,
  options: ConnectOptions = {}
): Promise<DevBrowserClient> {
  // Handle overloaded signatures: connect() or connect(url) or connect(options) or connect(url, options)
  let serverUrl: string;
  let opts: ConnectOptions;

  if (typeof serverUrlOrOptions === "string") {
    serverUrl = serverUrlOrOptions;
    opts = options;
  } else if (serverUrlOrOptions) {
    opts = serverUrlOrOptions;
    const port = DEFAULT_PORTS[opts.mode ?? "standalone"];
    serverUrl = `http://localhost:${port}`;
  } else {
    opts = options;
    const port = DEFAULT_PORTS[opts.mode ?? "standalone"];
    serverUrl = `http://localhost:${port}`;
  }
  // Determine session ID with priority:
  // 1. ephemeral: true -> always generate unique session (ignores session and env var)
  // 2. Explicit opts.session (user override)
  // 3. CLAUDE_SESSION_ID env var (from SessionStart hook - provides per-agent persistence)
  // 4. Fall back to generated session ID
  const isEphemeral = opts.ephemeral === true;
  const isAutoGenerated = isEphemeral || (!opts.session && !process.env.CLAUDE_SESSION_ID);
  const session = isEphemeral
    ? `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    : (opts.session ??
       process.env.CLAUDE_SESSION_ID ??
       `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  // Log session source for debugging
  if (isEphemeral) {
    logger.debug(`Session: ${session} (ephemeral - pages auto-close on disconnect)`);
  } else if (opts.session) {
    logger.debug(`Session: ${session} (explicit)`);
  } else if (process.env.CLAUDE_SESSION_ID) {
    logger.debug(`Session: ${session} (from CLAUDE_SESSION_ID)`);
  } else {
    logger.debug(
      `Session: ${session} (auto-generated)\n` +
      `WARNING: Pages will be auto-closed on disconnect since this session is ephemeral.\n` +
      `For persistent pages across scripts, set CLAUDE_SESSION_ID env var or pass { session: "my-session" } to connect().`
    );
  }

  // Headers to include session (and the server auth token, when present) in all requests
  const sessionHeaders: Record<string, string> = {
    "X-DevBrowser-Session": session,
    ...(opts.token ? { [TOKEN_HEADER]: opts.token } : authHeaders()),
  };

  // Verify the connected browser matches the requested one (P1 #10b)
  if (opts.browser) {
    const wanted = opts.browser;
    if (opts.mode === "extension") {
      const res = await fetch(`${serverUrl}/browsers`, {
        headers: sessionHeaders,
      });
      if (!res.ok) {
        throw new Error(`Failed to list browsers: ${await res.text()}`);
      }
      const { browsers } = (await res.json()) as { browsers: BrowserInfo[] };
      const current = browsers[0];
      if (!current) {
        throw new Error(
          `No browser is connected to the relay (wanted "${wanted}")`
        );
      }
      if (current.browser !== "unknown" && current.browser !== wanted) {
        throw new Error(
          `Connected browser is "${current.browser}", not "${wanted}"`
        );
      }
    } else {
      const res = await fetch(`${serverUrl}/health`, {
        headers: sessionHeaders,
      });
      if (!res.ok) {
        throw new Error(`Failed to get server health: ${await res.text()}`);
      }
      const health = (await res.json()) as { browser?: string };
      const current = health.browser ?? "chromium";
      if (current !== wanted) {
        throw new Error(`Server browser is "${current}", not "${wanted}"`);
      }
    }
  }

  // ---- Extension mode: HTTP RPC via CDPPage (no Playwright) ----
  if (opts.mode === "extension") {
    return wrapWithCleanErrors(
      await connectExtensionMode(serverUrl, session, sessionHeaders, isAutoGenerated),
      "client"
    );
  }

  return connectStandaloneMode(serverUrl, session, sessionHeaders, isAutoGenerated, opts);
}
