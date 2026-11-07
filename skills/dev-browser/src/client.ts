import {
  chromium,
  type Browser,
  type Page as PlaywrightPage,
  type ElementHandle,
  type CDPSession,
} from "patchright";
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  ViewportSize,
} from "./types";
import type { Page } from "./page.js";
import { CDPPage } from "./cdp-page.js";
import {
  BROWSER_IDENTITY_SCRIPT,
  CLEAR_MOBILE_OPS,
  colorSchemeOp,
  mobileOps,
  type BrowserIdentity,
  type EmulateOptions,
} from "./emulation.js";
import {
  classifyNavigationError,
  detectChallengeFromSignals,
  readPageSignals,
  type Challenge,
  type NavigationErrorKind,
  type PageSignals,
} from "./challenge.js";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, createWriteStream, rmSync } from "node:fs";
import archiver from "archiver";
import { getSnapshotScript } from "./snapshot/browser-script";
import { createWaczFromHar } from "./wacz.js";
import { createLogger } from "./logging.js";
import { wrapWithCleanErrors } from "./errors.js";
import { authHeaders, loadToken, TOKEN_HEADER } from "./auth.js";
import TurndownService from "turndown";
import type { ConsoleMessage, DownloadRecord } from "./relay.js";
import {
  type HarEntry,
  type HarLog,
  type PendingHarEntry,
  processNetworkEvent,
} from "./har.js";

const logger = createLogger("client");

// Re-export for consumers
export type { Page, Locator, Keyboard, Mouse } from "./page.js";
export { detectChallenge, classifyNavigationError } from "./challenge.js";
export type { Challenge, ChallengeVendor, NavigationErrorKind } from "./challenge.js";
export { CDPPage, CDPFrame } from "./cdp-page.js";
export type { CDPCommandOptions } from "./cdp-page.js";
export type { HarCookie, HarPostData, HarContent, HarEntry, HarLog } from "./har.js";

// State for an active HAR recording (client-specific: has CDPSession and body fetch tracking)
interface HarRecorderState {
  cdpSession: CDPSession;
  pending: Map<string, PendingHarEntry>;
  completed: HarEntry[];
  pendingBodyFetches: number;
  bodyFetchDone?: () => void; // Called when pendingBodyFetches reaches 0
  /** Console messages captured on the same CDP session (capped). */
  consoleMessages: ConsoleMessage[];
  /** Whether console API calls and exceptions are being captured yet. */
  runtimeCapture: boolean;
}

const CONSOLE_BUFFER_MAX = 1000;

// Re-export so consumers can type console results without importing relay
export type { ConsoleMessage, DownloadRecord } from "./relay.js";

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
export interface WaitForPageLoadOptions {
  /** Maximum time to wait in ms (default: 10000) */
  timeout?: number;
  /** How often to check page state in ms (default: 50) */
  pollInterval?: number;
  /** Minimum time to wait even if page appears ready in ms (default: 100) */
  minimumWait?: number;
  /** Wait for network to be idle (no pending requests) (default: true) */
  waitForNetworkIdle?: boolean;
}

/**
 * Result of waiting for page load
 */
export interface WaitForPageLoadResult {
  /** Whether the page is considered loaded */
  success: boolean;
  /** Document ready state when finished */
  readyState: string;
  /** Number of pending network requests when finished */
  pendingRequests: number;
  /** Time spent waiting in ms */
  waitTimeMs: number;
  /** Whether timeout was reached */
  timedOut: boolean;
}

interface PageLoadState {
  documentReadyState: string;
  documentLoading: boolean;
  pendingRequests: PendingRequest[];
}

interface PendingRequest {
  url: string;
  loadingDurationMs: number;
  resourceType: string;
}

/**
 * Wait for a page to finish loading using document.readyState and performance API.
 *
 * Uses browser-use's approach of:
 * - Checking document.readyState for 'complete'
 * - Monitoring pending network requests via Performance API
 * - Filtering out ads, tracking, and non-critical resources
 * - Graceful timeout handling (continues even if timeout reached)
 */
export async function waitForPageLoad(
  page: PlaywrightPage,
  options: WaitForPageLoadOptions = {}
): Promise<WaitForPageLoadResult> {
  const {
    timeout = 10000,
    pollInterval = 50,
    minimumWait = 100,
    waitForNetworkIdle = true,
  } = options;

  const startTime = Date.now();
  let lastState: PageLoadState | null = null;

  // Wait minimum time first
  if (minimumWait > 0) {
    await new Promise((resolve) => setTimeout(resolve, minimumWait));
  }

  // Poll until ready or timeout
  while (Date.now() - startTime < timeout) {
    try {
      lastState = await getPageLoadState(page);

      // Check if document is complete
      const documentReady = lastState.documentReadyState === "complete";

      // Check if network is idle (no pending critical requests)
      const networkIdle = !waitForNetworkIdle || lastState.pendingRequests.length === 0;

      if (documentReady && networkIdle) {
        return {
          success: true,
          readyState: lastState.documentReadyState,
          pendingRequests: lastState.pendingRequests.length,
          waitTimeMs: Date.now() - startTime,
          timedOut: false,
        };
      }
    } catch {
      // Page may be navigating, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout reached - return current state
  return {
    success: false,
    readyState: lastState?.documentReadyState ?? "unknown",
    pendingRequests: lastState?.pendingRequests.length ?? 0,
    waitTimeMs: Date.now() - startTime,
    timedOut: true,
  };
}

/**
 * Get the current page load state including document ready state and pending requests.
 * Filters out ads, tracking, and non-critical resources that shouldn't block loading.
 */
async function getPageLoadState(page: PlaywrightPage): Promise<PageLoadState> {
  const result = await page.evaluate(() => {
    // Access browser globals via globalThis for TypeScript compatibility
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const g = globalThis as { document?: any; performance?: any };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const perf = g.performance!;
    const doc = g.document!;

    const now = perf.now();
    const resources = perf.getEntriesByType("resource");
    const pending: Array<{ url: string; loadingDurationMs: number; resourceType: string }> = [];

    // Common ad/tracking domains and patterns to filter out
    const adPatterns = [
      "doubleclick.net",
      "googlesyndication.com",
      "googletagmanager.com",
      "google-analytics.com",
      "facebook.net",
      "connect.facebook.net",
      "analytics",
      "ads",
      "tracking",
      "pixel",
      "hotjar.com",
      "clarity.ms",
      "mixpanel.com",
      "segment.com",
      "newrelic.com",
      "nr-data.net",
      "/tracker/",
      "/collector/",
      "/beacon/",
      "/telemetry/",
      "/log/",
      "/events/",
      "/track.",
      "/metrics/",
    ];

    // Non-critical resource types
    const nonCriticalTypes = ["img", "image", "icon", "font"];

    for (const entry of resources) {
      // Resources with responseEnd === 0 are still loading
      if (entry.responseEnd === 0) {
        const url = entry.name;

        // Filter out ads and tracking
        const isAd = adPatterns.some((pattern) => url.includes(pattern));
        if (isAd) continue;

        // Filter out data: URLs and very long URLs
        if (url.startsWith("data:") || url.length > 500) continue;

        const loadingDuration = now - entry.startTime;

        // Skip requests loading > 10 seconds (likely stuck/polling)
        if (loadingDuration > 10000) continue;

        const resourceType = entry.initiatorType || "unknown";

        // Filter out non-critical resources loading > 3 seconds
        if (nonCriticalTypes.includes(resourceType) && loadingDuration > 3000) continue;

        // Filter out image URLs even if type is unknown
        const isImageUrl = /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i.test(url);
        if (isImageUrl && loadingDuration > 3000) continue;

        pending.push({
          url,
          loadingDurationMs: Math.round(loadingDuration),
          resourceType,
        });
      }
    }

    return {
      documentReadyState: doc.readyState,
      documentLoading: doc.readyState !== "complete",
      pendingRequests: pending,
    };
  });

  return result;
}

/**
 * Options for navigateTo
 */
export interface NavigateOptions {
  /** Overall timeout in ms (default: 15000) */
  timeout?: number;
  /** Whether to wait for page load after navigation (default: true) */
  waitForLoad?: boolean;
}

/**
 * Result of navigateTo
 */
export interface NavigateResult {
  /** Whether navigation and load completed successfully */
  success: boolean;
  /** Final URL after navigation (may differ from input due to redirects) */
  url: string;
  /** Document ready state when finished */
  readyState: string;
  /** Number of pending network requests when finished */
  pendingRequests: number;
  /** Total time spent in ms */
  totalTimeMs: number;
  /** Whether the initial navigation timed out (page may still be usable) */
  navigationTimedOut: boolean;
  /** Whether the load wait timed out (page may still be usable) */
  loadTimedOut: boolean;
  /** HTTP status of the main document, when known */
  status?: number;
  /** Bot challenge or block page on the loaded page, or null if none was found */
  challenge?: Challenge | null;
  /** Length of the page's visible text; near zero means a block or an unhydrated app shell */
  textLength?: number;
  /** Why navigation failed, when it did */
  error?: { kind: NavigationErrorKind; message: string };
}

/**
 * Resilient page navigation that never hangs.
 *
 * Uses a two-phase approach:
 * 1. Navigate with `waitUntil: "commit"` (server started responding — fast, reliable)
 * 2. Wait for page load using smart polling (readyState + network idle, with graceful timeout)
 *
 * Unlike `page.goto()`, this function:
 * - Never throws on timeout — returns a result object instead
 * - Works on sites with websockets, long-polling, or heavy analytics
 * - Always returns a usable page (even if not fully loaded)
 *
 * @example
 * ```typescript
 * import { connect, navigateTo } from "@/client.js";
 *
 * const client = await connect();
 * const page = await client.page("research");
 * const result = await navigateTo(page, "https://example.com");
 * console.log(result.success); // true if fully loaded
 * ```
 */
export async function navigateTo(
  page: PlaywrightPage,
  url: string,
  options: NavigateOptions = {}
): Promise<NavigateResult> {
  const timeout = options.timeout ?? 15000;
  const startTime = Date.now();
  let navigationTimedOut = false;

  // Phase 1: Navigate with "commit" — server has started responding
  // This is the fastest reliable waitUntil and works on virtually all sites.
  let response: Awaited<ReturnType<PlaywrightPage["goto"]>> = null;
  try {
    response = await page.goto(url, { waitUntil: "commit", timeout });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      navigationTimedOut = true;
      // Page may still be partially loaded — continue to phase 2
    } else {
      // Real navigation error (DNS failure, connection refused, etc.)
      return {
        success: false,
        url: page.url(),
        readyState: "unknown",
        pendingRequests: 0,
        totalTimeMs: Date.now() - startTime,
        navigationTimedOut: false,
        loadTimedOut: false,
        error: { kind: classifyNavigationError(msg), message: msg },
      };
    }
  }

  // Phase 2: Wait for page load with graceful timeout
  let load = { success: !navigationTimedOut, readyState: "unknown", pendingRequests: 0, timedOut: false };
  if (options.waitForLoad !== false) {
    const remainingTime = Math.max(timeout - (Date.now() - startTime), 2000);
    load = await waitForPageLoad(page, { timeout: remainingTime });
    load.success = load.success && !navigationTimedOut;
  }

  // Phase 3: Check what loaded. Best effort: a page mid-navigation can't be read.
  let signals: PageSignals | undefined;
  try {
    signals = await readPageSignals(page as unknown as Page);
  } catch {
    // Leave status, challenge, and textLength unknown
  }
  const headers = response?.headers() ?? {};
  return {
    success: load.success,
    url: page.url(),
    readyState: load.readyState,
    pendingRequests: load.pendingRequests,
    totalTimeMs: Date.now() - startTime,
    navigationTimedOut,
    loadTimedOut: load.timedOut,
    status: response?.status() ?? (signals?.status || undefined),
    challenge: signals ? detectChallengeFromSignals(signals, headers) : undefined,
    textLength: signals?.textLength,
    ...(navigationTimedOut ? { error: { kind: "timeout" as const, message: "Navigation timed out" } } : {}),
  };
}

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

// ============================================================================
// Shared HTTP helpers used by both extension and standalone modes
// ============================================================================

async function fetchServerInfo(
  serverUrl: string,
  defaultMode: "launch" | "extension"
): Promise<ServerInfo> {
  const res = await fetch(serverUrl, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}: ${await res.text()}`);
  }
  const info = (await res.json()) as {
    wsEndpoint: string;
    mode?: string;
    extensionConnected?: boolean;
  };
  return {
    wsEndpoint: info.wsEndpoint,
    mode: (info.mode as "launch" | "extension") ?? defaultMode,
    extensionConnected: info.extensionConnected,
  };
}

async function fetchAllTargets(
  serverUrl: string,
  sessionHeaders: Record<string, string>
): Promise<BrowserTarget[]> {
  const res = await fetch(`${serverUrl}/all-targets`, {
    headers: sessionHeaders,
  });
  const data = (await res.json()) as { error?: string; targets?: BrowserTarget[] };
  if (data.error) throw new Error(data.error);
  return data.targets ?? [];
}

async function fetchCloseTarget(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  tabId: number
): Promise<void> {
  const res = await fetch(`${serverUrl}/close-target`, {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ tabId }),
  });
  const data = (await res.json()) as { error?: string; success?: boolean };
  if (data.error) throw new Error(data.error);
}

async function fetchCleanup(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  pattern: string
): Promise<{ closed: number; urls: string[] }> {
  const res = await fetch(`${serverUrl}/cleanup`, {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ pattern }),
  });
  const data = (await res.json()) as { error?: string; closed?: number; urls?: string[] };
  if (data.error) throw new Error(data.error);
  return { closed: data.closed ?? 0, urls: data.urls ?? [] };
}

async function fetchPin(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  name: string,
  pinned: boolean
): Promise<void> {
  const res = await fetch(
    `${serverUrl}/pages/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ pinned }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to ${pinned ? "pin" : "unpin"} page: ${await res.text()}`);
  }
}

async function deleteSessionPages(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  session: string
): Promise<{ closed: number; pages: string[] }> {
  const res = await fetch(
    `${serverUrl}/sessions/${encodeURIComponent(session)}`,
    { method: "DELETE", headers: sessionHeaders }
  );
  const data = (await res.json()) as { error?: string; closed?: number; pages?: string[] };
  if (data.error) throw new Error(data.error);
  return { closed: data.closed ?? 0, pages: data.pages ?? [] };
}

// ============================================================================
// Shared feature helpers (mode-agnostic, operate on Page / HAR entries)
// ============================================================================

/** document.body.innerText of a page. */
function pageInnerText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    return (g.document?.body?.innerText as string) ?? "";
  });
}

/** Rendered DOM converted to Markdown. */
async function pageMarkdown(page: Page): Promise<string> {
  const html = await page.content();
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.remove(["script", "style", "noscript"]);
  return turndown.turndown(html);
}

/** Filter snapshot lines for find(). */
function findInSnapshot(snapshot: string, query: string): FindMatch[] {
  const q = query.toLowerCase();
  const matches: FindMatch[] = [];
  for (const line of snapshot.split("\n")) {
    if (line.toLowerCase().includes(q)) {
      const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
      matches.push({ ref, line: line.trim() });
      if (matches.length >= 20) break;
    }
  }
  return matches;
}

/** Fill several fields sequentially. */
async function fillFormFields(
  page: Page,
  fields: Record<string, string>
): Promise<void> {
  for (const [selector, value] of Object.entries(fields)) {
    await page.fill(selector, value);
  }
}

/** Map HAR entries to the live network-log shape, with regex URL filter. */
function harToNetworkRequests(
  entries: HarEntry[],
  pattern?: string,
  offset = 0
): NetworkRequest[] {
  const regex = pattern ? new RegExp(pattern) : null;
  const requests: NetworkRequest[] = [];
  for (const [i, entry] of entries.entries()) {
    if (regex && !regex.test(entry.request.url)) continue;
    requests.push({
      id: offset + i,
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      statusText: entry.response.statusText,
      mimeType: entry.response.content?.mimeType,
      startedDateTime: entry.startedDateTime,
      timeMs: entry.time,
    });
  }
  return requests;
}

/** Filter console messages by regex and since-index. */
function filterConsoleMessages(
  buffer: ConsoleMessage[],
  options?: { pattern?: string; since?: number }
): { messages: ConsoleMessage[]; total: number } {
  const since =
    options?.since && options.since > 0 ? Math.floor(options.since) : 0;
  let messages = buffer.slice(since);
  if (options?.pattern) {
    const regex = new RegExp(options.pattern);
    messages = messages.filter((m) => regex.test(m.text));
  }
  return { messages, total: buffer.length };
}

/** Read an origin's cookies + localStorage via a raw-CDP sender and the page. */
async function exportOriginStateImpl(
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  page: Page,
  origin: string
): Promise<OriginState> {
  const cookieResult = (await sendCdp("Network.getCookies", {
    urls: [origin],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as { cookies: any[] };

  const localStorageData = await page.evaluate((targetOrigin: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g.location?.origin !== targetOrigin) return {};
    const out: Record<string, string> = {};
    const storage = g.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) out[key] = storage.getItem(key) ?? "";
    }
    return out;
  }, origin);

  return { origin, cookies: cookieResult.cookies ?? [], localStorage: localStorageData };
}

/** Write an origin's cookies + localStorage back. */
async function importOriginStateImpl(
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  page: Page,
  state: OriginState
): Promise<void> {
  for (const cookie of state.cookies) {
    await sendCdp("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires,
    });
  }
  if (Object.keys(state.localStorage).length > 0) {
    // Single argument object: Playwright's evaluate only forwards one arg
    await page.evaluate(
      (arg: { targetOrigin: string; items: Record<string, string> }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = globalThis as any;
        if (g.location?.origin !== arg.targetOrigin) {
          throw new Error(
            `Page must be on ${arg.targetOrigin} to import localStorage (currently ${g.location?.origin})`
          );
        }
        for (const [key, value] of Object.entries(arg.items)) {
          g.localStorage.setItem(key, value);
        }
      },
      { targetOrigin: state.origin, items: state.localStorage }
    );
  }
}

/** Clear browsing data via raw CDP. */
/**
 * Poll a download source until a matching download completes.
 * Shared by both modes; `fetchSince` returns downloads with startedAt >= since.
 */
async function pollForDownload(
  fetchSince: (since: number) => Promise<DownloadRecord[]>,
  options?: { since?: number; timeoutMs?: number }
): Promise<DownloadRecord> {
  // Default window reaches 60s back so the call works after the triggering click
  const since = options?.since ?? Date.now() - 60_000;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await fetchSince(since);
    const done = records.find((d) => d.state === "completed");
    if (done) return done;
    const failed = records.find((d) => d.state === "interrupted");
    if (failed) {
      throw new Error(`Download interrupted: ${failed.url}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a download after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** GET /downloads from a dev-browser server (either mode). */
async function fetchDownloadsHttp(
  serverUrl: string,
  headers: Record<string, string>,
  since?: number
): Promise<DownloadRecord[]> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set("since", String(since));
  const res = await fetch(`${serverUrl}/downloads?${params}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get downloads: ${await res.text()}`);
  }
  const data = (await res.json()) as { downloads: DownloadRecord[] };
  return data.downloads;
}

/**
 * Stream a completed download's bytes from the server to a local file.
 * This is how downloads reach the agent when the browser runs on another
 * machine; `record.path` is a path on the server.
 */
async function saveDownloadHttp(
  serverUrl: string,
  headers: Record<string, string>,
  id: number,
  destPath: string
): Promise<string> {
  const res = await fetch(`${serverUrl}/download/${id}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch download ${id}: ${await res.text()}`);
  }
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  return destPath;
}

async function clearBrowsingDataImpl(
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  options?: { origin?: string }
): Promise<void> {
  if (options?.origin) {
    await sendCdp("Storage.clearDataForOrigin", {
      origin: options.origin,
      storageTypes:
        "cookies,local_storage,session_storage,indexeddb,cache_storage",
    });
    return;
  }
  await sendCdp("Network.clearBrowserCookies");
  await sendCdp("Network.clearBrowserCache");
}

export interface SaveWaczOptions {
  outputPath?: string;
  title?: string;
  description?: string;
}

/**
 * Stop HAR recording and save as WACZ in one step.
 * Recording is auto-started by client.page(), so this is usually all you need.
 *
 * @returns Path to the saved WACZ file
 */
export async function saveWacz(
  client: DevBrowserClient,
  name: string,
  options?: SaveWaczOptions
): Promise<string> {
  const har = await client.stopHarRecording(name);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(homedir(), ".dev-browser", "archives");
  await mkdir(archiveDir, { recursive: true });
  const outputPath = options?.outputPath ?? join(archiveDir, `${name}-${timestamp}.wacz`);
  await createWaczFromHar(har, outputPath, {
    title: options?.title,
    description: options?.description,
  });
  logger.info(`Saved WACZ to ${outputPath}`);
  return outputPath;
}

export interface SaveArchiveOptions extends SaveWaczOptions {
  /** Skip PDF capture (e.g., if page.pdf() fails in headed mode) */
  skipPdf?: boolean;
  /** Skip rendered HTML capture */
  skipHtml?: boolean;
}

/**
 * Save a complete archive bundle: WACZ + rendered HTML + PDF in a single .zip.
 *
 * The .zip contains:
 * - `<name>.wacz` — WARC-based web archive (network traffic)
 * - `<name>.html` — as-rendered DOM snapshot
 * - `<name>.pdf`  — PDF rendering of the page
 *
 * @returns Path to the saved .zip archive
 */
export async function saveArchive(
  client: DevBrowserClient,
  name: string,
  options?: SaveArchiveOptions
): Promise<string> {
  const page = await client.page(name, { record: false });

  // Capture rendered HTML
  let renderedHtml: string | null = null;
  if (!options?.skipHtml) {
    try {
      renderedHtml = await page.content();
    } catch (err) {
      logger.warn(`Failed to capture rendered HTML for "${name}":`, err);
    }
  }

  // Capture PDF
  let pdfBuffer: Buffer | null = null;
  if (!options?.skipPdf) {
    try {
      pdfBuffer = await page.pdf({ printBackground: true });
    } catch (err) {
      logger.warn(`Failed to capture PDF for "${name}":`, err);
    }
  }

  // Stop recording and create WACZ
  const har = await client.stopHarRecording(name);
  const tempDir = mkdtempSync(join(tmpdir(), "dev-browser-archive-"));
  const waczPath = join(tempDir, `${name}.wacz`);
  await createWaczFromHar(har, waczPath, {
    title: options?.title,
    description: options?.description,
  });

  // Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(homedir(), ".dev-browser", "archives");
  await mkdir(archiveDir, { recursive: true });
  const outputPath = options?.outputPath ?? join(archiveDir, `${name}-${timestamp}.zip`);

  // Bundle into .zip
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const zip = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    zip.on("error", reject);
    zip.pipe(output);
    zip.file(waczPath, { name: `${name}.wacz` });
    if (renderedHtml !== null) {
      zip.append(renderedHtml, { name: `${name}.html` });
    }
    if (pdfBuffer !== null) {
      zip.append(pdfBuffer, { name: `${name}.pdf` });
    }
    zip.finalize();
  });

  rmSync(tempDir, { recursive: true });

  const parts = [
    "wacz",
    renderedHtml !== null ? "html" : null,
    pdfBuffer !== null ? "pdf" : null,
  ].filter(Boolean);
  logger.info(`Saved archive to ${outputPath} (${parts.join(" + ")})`);
  return outputPath;
}

// ============================================================================
// Extension mode client
// ============================================================================

/**
 * Extension mode client — no Playwright, just HTTP RPC to the relay.
 *
 * Each page() call returns a CDPPage that communicates via POST /cdp.
 * HAR recording uses the relay's /har/start and /har/stop endpoints.
 */
async function connectExtensionMode(
  serverUrl: string,
  session: string,
  sessionHeaders: Record<string, string>,
  isAutoGenerated: boolean
): Promise<DevBrowserClient> {
  // HAR recording state lives on the relay (source of truth) — the client is
  // stateless so recorders survive across separate connect() invocations.

  // Local helper to stop HAR recording (avoids `this` context issues in object literal)
  async function stopRecording(name: string): Promise<HarLog> {
    const res = await fetch(`${serverUrl}/har/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ page: name }),
    });
    if (res.status === 404) {
      // Surface the server's message (e.g. `No HAR recording active for "x"`)
      const text = await res.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON — use the raw text
      }
      throw new Error(message);
    }
    if (!res.ok) {
      throw new Error(`Failed to stop HAR recording: ${await res.text()}`);
    }
    const har = (await res.json()) as HarLog;
    logger.debug(
      `Stopped HAR recording for "${name}" (${har.log.entries.length} entries)`
    );
    return har;
  }

  logger.debug(`Extension mode: HTTP RPC to ${serverUrl}`);

  // Raw CDP command against a named page via the relay
  async function sendCdp(
    name: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const res = await fetch(`${serverUrl}/cdp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ page: name, method, params }),
    });
    const data = (await res.json()) as {
      result?: unknown;
      error?: { message: string };
    };
    if (!res.ok || data.error) {
      throw new Error(data.error?.message ?? `CDP ${method} failed (${res.status})`);
    }
    return data.result;
  }

  // Lightweight handle to an existing page (no HAR/console auto-start)
  function existingPage(name: string): Page {
    return new CDPPage(serverUrl, name, session);
  }

  async function fetchSnapshot(name: string): Promise<string> {
    const res = await fetch(`${serverUrl}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ page: name }),
    });
    if (!res.ok) {
      throw new Error(`Snapshot failed: ${await res.text()}`);
    }
    const data = (await res.json()) as { snapshot: string };
    return data.snapshot;
  }

  async function enableConsole(name: string): Promise<void> {
    const res = await fetch(`${serverUrl}/console/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ page: name }),
    });
    if (!res.ok) {
      throw new Error(`Failed to enable console capture: ${await res.text()}`);
    }
  }

  async function fetchDownloads(since?: number): Promise<DownloadRecord[]> {
    return fetchDownloadsHttp(serverUrl, sessionHeaders, since);
  }

  return {
    async page(name: string, options?: PageOptions): Promise<Page> {
      const res = await fetch(`${serverUrl}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders },
        body: JSON.stringify({
          name,
          viewport: options?.viewport,
          pinned: options?.pinned,
          tabId: options?.tabId,
        } satisfies GetPageRequest),
      });

      if (!res.ok) {
        throw new Error(`Failed to get page: ${await res.text()}`);
      }

      const pageInfo = (await res.json()) as GetPageResponse & { url?: string };
      const page = new CDPPage(serverUrl, name, session, pageInfo.url);

      // Agent tabs open in the background, and Chrome won't deliver input to a
      // hidden tab. Playwright enables this on every page; do the same here.
      try {
        await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch (err) {
        logger.warn(`Failed to enable focus emulation for "${name}":`, err);
      }

      // Auto-start HAR recording unless opted out
      if (options?.record !== false) {
        try {
          const harRes = await fetch(`${serverUrl}/har/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...sessionHeaders },
            body: JSON.stringify({ page: name }),
          });
          if (harRes.ok) {
            logger.debug(`Auto-started HAR recording for "${name}"`);
          } else if (harRes.status === 409) {
            // Already recording server-side — that's the desired state
            logger.debug(`HAR recording already active for "${name}"`);
          }
        } catch (err) {
          logger.warn(
            `Failed to auto-start HAR recording for "${name}":`,
            err
          );
        }

        // Auto-enable console capture too (same opt-out as HAR)
        try {
          await enableConsole(name);
        } catch (err) {
          logger.warn(`Failed to enable console capture for "${name}":`, err);
        }
      }

      return wrapWithCleanErrors(page, `page:${name}`);
    },

    async list(): Promise<string[]> {
      const res = await fetch(`${serverUrl}/pages`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      const res = await fetch(
        `${serverUrl}/pages/${encodeURIComponent(name)}`,
        { method: "DELETE", headers: sessionHeaders }
      );
      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    async pin(name: string, pinned = true): Promise<void> {
      return fetchPin(serverUrl, sessionHeaders, name, pinned);
    },

    async disconnect(): Promise<void> {
      if (isAutoGenerated) {
        try {
          const result = await deleteSessionPages(serverUrl, sessionHeaders, session);
          if (result.closed > 0) {
            logger.debug(`Auto-closed ${result.closed} page(s) for ephemeral session`);
          }
        } catch {
          // Server may be unreachable
        }
      }
    },

    async getAISnapshot(name: string): Promise<string> {
      return fetchSnapshot(name);
    },

    async selectSnapshotRef(
      _name: string,
      _ref: string
    ): Promise<ElementHandle | null> {
      logger.warn(
        "selectSnapshotRef is not available in extension mode. " +
          "Use page.clickRef(ref) or page.fillRef(ref, value) instead."
      );
      return null;
    },

    getServerInfo: () => fetchServerInfo(serverUrl, "extension"),
    getSession: () => session,
    allTargets: () => fetchAllTargets(serverUrl, sessionHeaders),
    closeTarget: (tabId: number) => fetchCloseTarget(serverUrl, sessionHeaders, tabId),
    cleanup: (pattern: string) => fetchCleanup(serverUrl, sessionHeaders, pattern),

    async closeAll(): Promise<{ closed: number; pages: string[] }> {
      const result = await deleteSessionPages(serverUrl, sessionHeaders, session);
      if (result.closed > 0) {
        logger.debug(`Closed ${result.closed} page(s): ${result.pages.join(", ")}`);
      }
      return result;
    },

    async startHarRecording(name: string): Promise<void> {
      const res = await fetch(`${serverUrl}/har/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders },
        body: JSON.stringify({ page: name }),
      });
      if (res.status === 409) {
        // Already recording server-side — treat as success (no-op)
        logger.debug(`HAR recording already active for "${name}"`);
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to start HAR recording: ${await res.text()}`);
      }
      logger.debug(`Started HAR recording for "${name}"`);
    },

    async stopHarRecording(name: string): Promise<HarLog> {
      return stopRecording(name);
    },

    async isRecordingHar(name: string): Promise<boolean> {
      const res = await fetch(
        `${serverUrl}/har/status?page=${encodeURIComponent(name)}`,
        { headers: sessionHeaders }
      );
      if (!res.ok) {
        throw new Error(`Failed to get HAR status: ${await res.text()}`);
      }
      const data = (await res.json()) as { recording: boolean };
      return data.recording;
    },

    async getHarEntries(
      name: string,
      options?: { since?: number }
    ): Promise<{ entries: HarEntry[]; total: number }> {
      const params = new URLSearchParams({ page: name });
      if (options?.since !== undefined) {
        params.set("since", String(options.since));
      }
      const res = await fetch(`${serverUrl}/har/entries?${params}`, {
        headers: sessionHeaders,
      });
      if (res.status === 404) {
        // Surface the server's message (e.g. `No HAR recording active for "x"`)
        const text = await res.text();
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // Not JSON — use the raw text
        }
        throw new Error(message);
      }
      if (!res.ok) {
        throw new Error(`Failed to get HAR entries: ${await res.text()}`);
      }
      const data = (await res.json()) as { entries: HarEntry[]; total: number };
      return { entries: data.entries, total: data.total };
    },

    async batch(
      name: string,
      ops: BatchOp[]
    ): Promise<{ results: BatchOpResult[]; completed: number }> {
      const res = await fetch(`${serverUrl}/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders },
        body: JSON.stringify({ page: name, ops }),
      });
      const data = (await res.json()) as {
        results?: BatchOpResult[];
        completed?: number;
        error?: { message: string };
      };
      if (!res.ok || data.error) {
        throw new Error(data.error?.message ?? `Batch failed (${res.status})`);
      }
      return { results: data.results ?? [], completed: data.completed ?? 0 };
    },

    async getConsoleMessages(
      name: string,
      options?: { pattern?: string; since?: number }
    ): Promise<{ messages: ConsoleMessage[]; total: number }> {
      await enableConsole(name);
      const params = new URLSearchParams({ page: name });
      if (options?.pattern) params.set("pattern", options.pattern);
      if (options?.since !== undefined) params.set("since", String(options.since));
      const res = await fetch(`${serverUrl}/console?${params}`, {
        headers: sessionHeaders,
      });
      if (!res.ok) {
        throw new Error(`Failed to get console messages: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        messages: ConsoleMessage[];
        total: number;
      };
      return data;
    },

    async getNetworkRequests(
      name: string,
      options?: { pattern?: string; since?: number }
    ): Promise<{ requests: NetworkRequest[]; total: number }> {
      const params = new URLSearchParams({ page: name });
      if (options?.since !== undefined) params.set("since", String(options.since));
      const res = await fetch(`${serverUrl}/har/entries?${params}`, {
        headers: sessionHeaders,
      });
      if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // Not JSON
        }
        throw new Error(message);
      }
      const data = (await res.json()) as { entries: HarEntry[]; total: number };
      return {
        requests: harToNetworkRequests(data.entries, options?.pattern, options?.since ?? 0),
        total: data.total,
      };
    },

    async emulate(name: string, options: EmulateOptions): Promise<void> {
      const page = existingPage(name);
      if (options.colorScheme) {
        const op = colorSchemeOp(options.colorScheme);
        await sendCdp(name, op.method, op.params);
      }
      if (options.mobile) {
        const identity = await page.evaluate<BrowserIdentity>(BROWSER_IDENTITY_SCRIPT);
        for (const op of mobileOps(identity, options.width ?? 375, options.height ?? 812)) {
          await sendCdp(name, op.method, op.params);
        }
      } else if (options.mobile === false) {
        for (const op of CLEAR_MOBILE_OPS) await sendCdp(name, op.method, op.params);
      }
      if (!options.mobile && options.width && options.height) {
        await page.setViewportSize({ width: options.width, height: options.height });
      }
    },

    async find(name: string, query: string): Promise<FindMatch[]> {
      const snapshot = await fetchSnapshot(name);
      return findInSnapshot(snapshot, query);
    },

    async fillForm(name: string, fields: Record<string, string>): Promise<void> {
      await fillFormFields(existingPage(name), fields);
    },

    async markdown(name: string): Promise<string> {
      return pageMarkdown(existingPage(name));
    },

    async text(name: string): Promise<string> {
      return pageInnerText(existingPage(name));
    },

    async grantPermissions(
      name: string,
      origin: string,
      permissions: string[]
    ): Promise<void> {
      await sendCdp(name, "Browser.grantPermissions", { origin, permissions });
    },

    async clearBrowsingData(
      name: string,
      options?: { origin?: string }
    ): Promise<void> {
      await clearBrowsingDataImpl((m, p) => sendCdp(name, m, p), options);
    },

    async exportOriginState(name: string, origin: string): Promise<OriginState> {
      return exportOriginStateImpl(
        (m, p) => sendCdp(name, m, p),
        existingPage(name),
        origin
      );
    },

    async importOriginState(name: string, state: OriginState): Promise<void> {
      await importOriginStateImpl(
        (m, p) => sendCdp(name, m, p),
        existingPage(name),
        state
      );
    },

    async getDownloads(options?: { since?: number }): Promise<DownloadRecord[]> {
      return fetchDownloads(options?.since);
    },

    async waitForDownload(options?: {
      since?: number;
      timeoutMs?: number;
    }): Promise<DownloadRecord> {
      return pollForDownload((since) => fetchDownloads(since), options);
    },

    async saveDownload(id: number, destPath: string): Promise<string> {
      return saveDownloadHttp(serverUrl, sessionHeaders, id, destPath);
    },

    async listBrowsers(): Promise<BrowserInfo[]> {
      const res = await fetch(`${serverUrl}/browsers`, {
        headers: sessionHeaders,
      });
      if (!res.ok) {
        throw new Error(`Failed to list browsers: ${await res.text()}`);
      }
      const data = (await res.json()) as { browsers: BrowserInfo[] };
      return data.browsers;
    },
  };
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

  // ---- Standalone mode: Playwright-based implementation ----
  let browser: Browser | null = null;
  let wsEndpoint: string | null = null;
  let connectingPromise: Promise<Browser> | null = null;
  let cachedServerMode: "launch" | "extension" | null = null;

  // Track active HAR recordings: pageName -> recorder state
  const harRecorders = new Map<string, HarRecorderState>();
  // CDP sessions holding device emulation, one per emulated page
  const emulationSessions = new Map<string, CDPSession>();

  // Force reconnect by closing existing connection and starting fresh
  // This is needed in extension mode when new tabs are created after Playwright connected
  async function forceReconnect(): Promise<Browser> {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore close errors
      }
      browser = null;
    }
    connectingPromise = null;
    cachedServerMode = null; // Invalidate on reconnect
    return ensureConnected();
  }

  async function ensureConnected(): Promise<Browser> {
    // Return existing connection if still active
    if (browser && browser.isConnected()) {
      return browser;
    }

    // If already connecting, wait for that connection (prevents race condition)
    if (connectingPromise) {
      return connectingPromise;
    }

    // Start new connection with mutex
    connectingPromise = (async () => {
      try {
        const res = await fetch(serverUrl, { headers: sessionHeaders });
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}: ${await res.text()}`);
        }
        const info = (await res.json()) as ServerInfoResponse;

        // Include session in CDP URL for multi-agent isolation, and the auth
        // token as a query param (Playwright's connectOverCDP can't send
        // custom headers).
        if (info.wsPath) {
          // Server exposes its own authenticated CDP proxy: derive the WS URL
          // from the HTTP URL we dialed, so remote/forwarded hosts work.
          const base = serverUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
          const wsToken = opts.token ?? loadToken();
          const qs = wsToken ? `?token=${encodeURIComponent(wsToken)}` : "";
          wsEndpoint = `${base}${info.wsPath}/${encodeURIComponent(session)}${qs}`;
        } else {
          // Legacy server: raw Chromium endpoint, local only
          wsEndpoint = `${info.wsEndpoint}/${encodeURIComponent(session)}`;
        }

        // Connect to the browser via CDP
        browser = await chromium.connectOverCDP(wsEndpoint);
        // This connection answers proxy auth challenges too (patchright
        // intercepts every request), so it needs the proxy's credentials
        if (info.proxyCredentials) {
          await Promise.all(browser.contexts().map((c) => c.setHTTPCredentials(info.proxyCredentials!)));
        }
        return browser;
      } finally {
        connectingPromise = null;
      }
    })();

    return connectingPromise;
  }

  // Find page by CDP targetId - more reliable than JS globals
  async function findPageByTargetId(b: Browser, targetId: string): Promise<PlaywrightPage | null> {
    for (const context of b.contexts()) {
      for (const page of context.pages()) {
        let cdpSession;
        try {
          cdpSession = await context.newCDPSession(page);
          const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
          if (targetInfo.targetId === targetId) {
            return page;
          }
        } catch (err) {
          // Only ignore "target closed" errors, log unexpected ones
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Target closed") && !msg.includes("Session closed")) {
            logger.warn(`Unexpected error checking page target: ${msg}`);
          }
        } finally {
          if (cdpSession) {
            try {
              await cdpSession.detach();
            } catch {
              // Ignore detach errors - session may already be closed
            }
          }
        }
      }
    }
    return null;
  }

  // Helper to get a page by name (used by multiple methods)
  async function getPage(name: string, options?: PageOptions): Promise<PlaywrightPage> {
    // Connect to browser first
    const b = await ensureConnected();

    // Request the page from server (creates if doesn't exist)
    const res = await fetch(`${serverUrl}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ name, viewport: options?.viewport } satisfies GetPageRequest),
    });

    if (!res.ok) {
      throw new Error(`Failed to get page: ${await res.text()}`);
    }

    const pageInfo = (await res.json()) as GetPageResponse & { url?: string };
    const { targetId } = pageInfo;

    // Check if we're in extension mode (cached after first call)
    if (cachedServerMode === null) {
      const infoRes = await fetch(serverUrl);
      const info = (await infoRes.json()) as { mode?: string };
      cachedServerMode = (info.mode as "launch" | "extension") ?? "launch";
    }
    const isExtensionModeServer = cachedServerMode === "extension";

    if (isExtensionModeServer) {
      // In extension mode, DON'T use findPageByTargetId as it corrupts page state
      // Instead, find page by URL or use the only available page
      let allPages = b.contexts().flatMap((ctx) => ctx.pages());

      // If no pages visible, force reconnect to refresh target list
      // This handles the case where a tab was created after Playwright connected
      if (allPages.length === 0) {
        logger.debug(`No pages visible, forcing reconnect to refresh target list...`);
        const freshBrowser = await forceReconnect();
        allPages = freshBrowser.contexts().flatMap((ctx) => ctx.pages());

        if (allPages.length === 0) {
          throw new Error(`No pages available in browser after reconnect`);
        }
      }

      if (allPages.length === 1) {
        return allPages[0]!;
      }

      // Multiple pages - try to match by URL if available
      // Don't trust about:blank or empty URLs - they're unreliable during navigation
      if (pageInfo.url && pageInfo.url !== "about:blank" && pageInfo.url !== "") {
        const matchingPage = allPages.find((p) => p.url() === pageInfo.url);
        if (matchingPage) {
          return matchingPage;
        }
      }

      // Try to find a non-about:blank page if we have the targetId
      // This helps when URL matching fails due to stale data
      if (targetId) {
        // Filter out about:blank pages as candidates
        const nonBlankPages = allPages.filter((p) => p.url() !== "about:blank");
        if (nonBlankPages.length === 1) {
          return nonBlankPages[0]!;
        }
      }

      // Fall back to first non-blank page, or first page
      const nonBlank = allPages.find((p) => p.url() !== "about:blank");
      if (nonBlank) {
        return nonBlank;
      }
      if (!allPages[0]) {
        throw new Error(`No pages available in browser`);
      }
      return allPages[0];
    }

    // In launch mode, use the original targetId-based lookup. A page the
    // server just created can take a moment to attach on this CDP
    // connection (especially through the /cdp proxy), so retry briefly.
    const deadline = Date.now() + 5000;
    for (;;) {
      const page = await findPageByTargetId(b, targetId);
      if (page) return page;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Page "${name}" not found in browser contexts`);
  }

  function pushConsole(state: HarRecorderState, msg: ConsoleMessage): void {
    state.consoleMessages.push(msg);
    if (state.consoleMessages.length > CONSOLE_BUFFER_MAX) {
      state.consoleMessages.splice(0, state.consoleMessages.length - CONSOLE_BUFFER_MAX);
    }
  }

  // Start capturing console API calls and exceptions on a recording session.
  async function startRuntimeCapture(state: HarRecorderState): Promise<void> {
    if (state.runtimeCapture) return;
    state.runtimeCapture = true;
    const { cdpSession } = state;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remoteText = (obj: any): string => {
      if (obj == null) return "";
      if (obj.value !== undefined) {
        return typeof obj.value === "string" ? obj.value : JSON.stringify(obj.value);
      }
      return obj.description ?? obj.unserializableValue ?? `[${obj.type}]`;
    };
    cdpSession.on("Runtime.consoleAPICalled", (params) => {
      pushConsole(state, {
        level: params.type,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        text: (params.args ?? []).map((a: any) => remoteText(a)).join(" "),
        source: "console",
        timestamp: params.timestamp ?? Date.now(),
      });
    });
    cdpSession.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails;
      pushConsole(state, {
        level: "error",
        text: details.exception?.description ?? details.text,
        source: "exception",
        timestamp: params.timestamp ?? Date.now(),
        url: details.url,
        line: details.lineNumber,
      });
    });
    await cdpSession.send("Runtime.enable");
  }

  // Helper: set up HAR recording CDP listeners on a page
  async function setupHarRecording(page: PlaywrightPage): Promise<HarRecorderState> {
    const cdpSession = await page.context().newCDPSession(page);
    const state: HarRecorderState = {
      cdpSession,
      pending: new Map(),
      completed: [],
      pendingBodyFetches: 0,
      consoleMessages: [],
      runtimeCapture: false,
    };

    await cdpSession.send("Network.enable");

    // Browser log entries ride on the same CDP session. Console API calls and
    // exceptions need Runtime.enable, which pages can detect, so that part
    // waits for the first getConsoleMessages call (startRuntimeCapture).
    try {
      await cdpSession.send("Log.enable");
      cdpSession.on("Log.entryAdded", (params) => {
        pushConsole(state, {
          level: params.entry.level,
          text: params.entry.text,
          source: "log",
          timestamp: params.entry.timestamp ?? Date.now(),
          url: params.entry.url,
          line: params.entry.lineNumber,
        });
      });
    } catch (err) {
      logger.warn("Failed to enable browser log capture:", err);
    }

    // Wrap fetchBody with pendingBodyFetches tracking for collectHarRecording()
    const fetchBody = async (requestId: string) => {
      state.pendingBodyFetches++;
      try {
        const { body, base64Encoded } = await cdpSession.send("Network.getResponseBody", {
          requestId,
        });
        return { body, base64Encoded };
      } catch {
        return null;
      } finally {
        state.pendingBodyFetches--;
        if (state.pendingBodyFetches === 0 && state.bodyFetchDone) {
          state.bodyFetchDone();
        }
      }
    };

    for (const event of [
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.loadingFinished",
      "Network.loadingFailed",
    ] as const) {
      cdpSession.on(event, (params) => {
        processNetworkEvent(state.pending, state.completed, event, params, fetchBody);
      });
    }

    return state;
  }

  // Helper: stop recording and return HAR data
  async function collectHarRecording(name: string): Promise<HarLog> {
    const state = harRecorders.get(name);
    if (!state) {
      throw new Error(`No HAR recording active for page "${name}"`);
    }

    // Wait for any pending body fetches to complete (with timeout)
    if (state.pendingBodyFetches > 0) {
      await Promise.race([
        new Promise<void>((resolve) => { state.bodyFetchDone = resolve; }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    await state.cdpSession.detach();
    harRecorders.delete(name);

    const har: HarLog = {
      log: {
        version: "1.2",
        creator: { name: "dev-browser", version: "0.0.1" },
        entries: state.completed,
      },
    };

    logger.debug(`Stopped HAR recording for "${name}" (${state.completed.length} entries)`);
    return har;
  }

  // Helper: silently stop and discard a recording (cleanup only, no save)
  async function discardHarRecording(name: string): Promise<void> {
    const state = harRecorders.get(name);
    if (!state) return;
    try {
      await state.cdpSession.detach();
    } catch {
      // Ignore detach errors during cleanup
    }
    harRecorders.delete(name);
  }

  const clientImpl: DevBrowserClient = {
    async page(name: string, options?: PageOptions): Promise<Page> {
      const p = await getPage(name, options);
      // Auto-start HAR recording unless opted out
      if (options?.record !== false && !harRecorders.has(name)) {
        try {
          const state = await setupHarRecording(p);
          harRecorders.set(name, state);
          logger.debug(`Auto-started HAR recording for "${name}"`);
        } catch (err) {
          // Don't fail page creation if recording fails
          logger.warn(`Failed to auto-start HAR recording for "${name}":`, err);
        }
      }
      return wrapWithCleanErrors(p as unknown as Page, `page:${name}`);
    },

    async list(): Promise<string[]> {
      const res = await fetch(`${serverUrl}/pages`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      await discardHarRecording(name);

      const res = await fetch(`${serverUrl}/pages/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: sessionHeaders,
      });

      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    pin: (name: string, pinned = true) => fetchPin(serverUrl, sessionHeaders, name, pinned),

    async disconnect(): Promise<void> {
      for (const name of [...harRecorders.keys()]) {
        await discardHarRecording(name);
      }

      // For auto-generated sessions, close all pages first (they can't be reconnected anyway)
      if (isAutoGenerated) {
        try {
          const result = await deleteSessionPages(serverUrl, sessionHeaders, session);
          if (result.closed > 0) {
            logger.debug(`Auto-closed ${result.closed} page(s) for ephemeral session`);
          }
        } catch {
          // Server may be unreachable, continue with disconnect
        }
      }

      // Disconnect the CDP connection - pages persist on server (unless auto-generated)
      if (browser) {
        await browser.close();
        browser = null;
      }
    },

    async getAISnapshot(name: string, options?: { timeout?: number }): Promise<string> {
      const timeout = options?.timeout ?? 10000;
      const page = await getPage(name);

      // Health check - fail fast if page is unresponsive
      const healthCheckTimeout = Math.min(3000, timeout);
      try {
        await Promise.race([
          page.evaluate(() => true),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("health check timeout")),
              healthCheckTimeout
            )
          ),
        ]);
      } catch {
        throw new Error(
          `Page "${name}" is unresponsive to JavaScript execution. ` +
            `This often happens on sites with heavy anti-bot measures. ` +
            `Try navigating with waitUntil: "commit" instead of waiting for full load.`
        );
      }

      // Inject the snapshot script and call getAISnapshot
      const snapshotScript = getSnapshotScript();
      const snapshot = await Promise.race([
        page.evaluate((script: string) => {
          // Inject script if not already present
          // Note: page.evaluate runs in browser context where window exists
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = globalThis as any;
          if (!w.__devBrowser_getAISnapshot) {
            // eslint-disable-next-line no-eval
            eval(script);
          }
          return w.__devBrowser_getAISnapshot();
        }, snapshotScript),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Snapshot timed out after ${timeout}ms. ` +
                    `The page may have heavy JavaScript blocking execution. ` +
                    `Try using screenshots instead, or navigate with waitUntil: "commit".`
                )
              ),
            timeout
          )
        ),
      ]);

      return snapshot;
    },

    async selectSnapshotRef(name: string, ref: string): Promise<ElementHandle | null> {
      // Get the page
      const page = await getPage(name);

      // Find the element using the stored refs
      const elementHandle = await page.evaluateHandle((refId: string) => {
        // Note: page.evaluateHandle runs in browser context where globalThis is the window
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) {
          throw new Error("No snapshot refs found. Call getAISnapshot first.");
        }
        const element = refs[refId];
        if (!element) {
          throw new Error(
            `Ref "${refId}" not found. Available refs: ${Object.keys(refs).join(", ")}`
          );
        }
        return element;
      }, ref);

      // Check if we got an element
      const element = elementHandle.asElement();
      if (!element) {
        await elementHandle.dispose();
        return null;
      }

      return element;
    },

    getServerInfo: () => fetchServerInfo(serverUrl, "launch"),
    getSession: () => session,
    allTargets: () => fetchAllTargets(serverUrl, sessionHeaders),
    closeTarget: (tabId: number) => fetchCloseTarget(serverUrl, sessionHeaders, tabId),
    cleanup: (pattern: string) => fetchCleanup(serverUrl, sessionHeaders, pattern),

    async closeAll(): Promise<{ closed: number; pages: string[] }> {
      const result = await deleteSessionPages(serverUrl, sessionHeaders, session);
      if (result.closed > 0) {
        logger.debug(`Closed ${result.closed} page(s): ${result.pages.join(", ")}`);
      }
      return result;
    },

    async startHarRecording(name: string): Promise<void> {
      if (harRecorders.has(name)) {
        throw new Error(`HAR recording already active for page "${name}"`);
      }
      const page = await getPage(name);
      const state = await setupHarRecording(page);
      harRecorders.set(name, state);
      logger.debug(`Started HAR recording for "${name}"`);
    },

    async stopHarRecording(name: string): Promise<HarLog> {
      return collectHarRecording(name);
    },

    // Standalone recording is genuinely client-local (CDPSession-based),
    // so the local map is the source of truth here.
    isRecordingHar: async (name: string) => harRecorders.has(name),

    async getHarEntries(
      name: string,
      options?: { since?: number }
    ): Promise<{ entries: HarEntry[]; total: number }> {
      const state = harRecorders.get(name);
      if (!state) {
        throw new Error(`No HAR recording active for page "${name}"`);
      }
      return {
        entries: state.completed.slice(options?.since ?? 0),
        total: state.completed.length,
      };
    },

    async batch(
      name: string,
      ops: BatchOp[]
    ): Promise<{ results: BatchOpResult[]; completed: number }> {
      const page = await getPage(name);
      const cdpSession = await page.context().newCDPSession(page);
      const results: BatchOpResult[] = [];
      try {
        for (const op of ops) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await cdpSession.send(op.method as any, op.params as any);
            results.push({ result });
          } catch (err) {
            results.push({ error: err instanceof Error ? err.message : String(err) });
            break;
          }
        }
      } finally {
        await cdpSession.detach().catch(() => {});
      }
      return { results, completed: results.filter((r) => !r.error).length };
    },

    async getConsoleMessages(
      name: string,
      options?: { pattern?: string; since?: number }
    ): Promise<{ messages: ConsoleMessage[]; total: number }> {
      const state = harRecorders.get(name);
      if (!state) {
        throw new Error(
          `No console capture active for page "${name}". ` +
            `Console capture starts with recording — open the page without { record: false }.`
        );
      }
      // Console API capture starts on the first call (see setupHarRecording)
      await startRuntimeCapture(state);
      return filterConsoleMessages(state.consoleMessages, options);
    },

    async getNetworkRequests(
      name: string,
      options?: { pattern?: string; since?: number }
    ): Promise<{ requests: NetworkRequest[]; total: number }> {
      const state = harRecorders.get(name);
      if (!state) {
        throw new Error(`No HAR recording active for page "${name}"`);
      }
      const entries = state.completed.slice(options?.since ?? 0);
      return {
        requests: harToNetworkRequests(entries, options?.pattern, options?.since ?? 0),
        total: state.completed.length,
      };
    },

    async emulate(name: string, options: EmulateOptions): Promise<void> {
      const page = await getPage(name);
      if (options.colorScheme) await page.emulateMedia({ colorScheme: options.colorScheme });
      if (options.mobile) {
        let session = emulationSessions.get(name);
        if (!session) {
          session = await page.context().newCDPSession(page);
          emulationSessions.set(name, session);
        }
        const identity = await page.evaluate<BrowserIdentity>(BROWSER_IDENTITY_SCRIPT);
        for (const op of mobileOps(identity, options.width ?? 375, options.height ?? 812)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await session.send(op.method as any, op.params);
        }
      } else if (options.mobile === false) {
        // Detaching drops every override the session set
        await emulationSessions.get(name)?.detach().catch(() => {});
        emulationSessions.delete(name);
      }
      if (!options.mobile && options.width && options.height) {
        await page.setViewportSize({ width: options.width, height: options.height });
      }
    },

    async find(name: string, query: string): Promise<FindMatch[]> {
      const snapshot = await clientImpl.getAISnapshot(name);
      return findInSnapshot(snapshot, query);
    },

    async fillForm(name: string, fields: Record<string, string>): Promise<void> {
      const page = await getPage(name);
      await fillFormFields(page as unknown as Page, fields);
    },

    async markdown(name: string): Promise<string> {
      const page = await getPage(name);
      return pageMarkdown(page as unknown as Page);
    },

    async text(name: string): Promise<string> {
      const page = await getPage(name);
      return pageInnerText(page as unknown as Page);
    },

    async grantPermissions(
      name: string,
      origin: string,
      permissions: string[]
    ): Promise<void> {
      const page = await getPage(name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.context().grantPermissions(permissions as any, { origin });
    },

    async clearBrowsingData(
      name: string,
      options?: { origin?: string }
    ): Promise<void> {
      const page = await getPage(name);
      const cdpSession = await page.context().newCDPSession(page);
      try {
        await clearBrowsingDataImpl(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m, p) => cdpSession.send(m as any, p as any),
          options
        );
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    },

    async exportOriginState(name: string, origin: string): Promise<OriginState> {
      const page = await getPage(name);
      const cdpSession = await page.context().newCDPSession(page);
      try {
        return await exportOriginStateImpl(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m, p) => cdpSession.send(m as any, p as any),
          page as unknown as Page,
          origin
        );
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    },

    async importOriginState(name: string, state: OriginState): Promise<void> {
      const page = await getPage(name);
      const cdpSession = await page.context().newCDPSession(page);
      try {
        await importOriginStateImpl(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m, p) => cdpSession.send(m as any, p as any),
          page as unknown as Page,
          state
        );
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    },

    async getDownloads(options?: { since?: number }): Promise<DownloadRecord[]> {
      return fetchDownloadsHttp(serverUrl, sessionHeaders, options?.since);
    },

    async waitForDownload(options?: {
      since?: number;
      timeoutMs?: number;
    }): Promise<DownloadRecord> {
      return pollForDownload(
        (since) => fetchDownloadsHttp(serverUrl, sessionHeaders, since),
        options
      );
    },

    async saveDownload(id: number, destPath: string): Promise<string> {
      return saveDownloadHttp(serverUrl, sessionHeaders, id, destPath);
    },

    async listBrowsers(): Promise<BrowserInfo[]> {
      const res = await fetch(`${serverUrl}/health`, { headers: sessionHeaders });
      if (!res.ok) {
        throw new Error(`Failed to get server health: ${await res.text()}`);
      }
      const health = (await res.json()) as { browser?: string };
      return [{ browser: health.browser ?? "chromium", connected: true }];
    },
  };

  return wrapWithCleanErrors(clientImpl, "client");
}
