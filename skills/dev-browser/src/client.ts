import {
  chromium,
  type Browser,
  type Page as PlaywrightPage,
  type ElementHandle,
  type CDPSession,
} from "playwright";
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  ViewportSize,
} from "./types";
import type { Page } from "./page.js";
import { CDPPage } from "./cdp-page.js";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { mkdtempSync, createWriteStream, rmSync } from "node:fs";
import archiver from "archiver";
import { getSnapshotScript } from "./snapshot/browser-script";
import { createWaczFromHar } from "./wacz.js";
import { createLogger } from "./logging.js";

const logger = createLogger("client");

// Re-export for consumers
export type { Page, Locator, Keyboard, Mouse } from "./page.js";
export { CDPPage } from "./cdp-page.js";

// HAR types (exported for consumers)
export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    cookies: HarCookie[];
    headersSize: number;
    bodySize: number;
    postData?: HarPostData;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: HarCookie[];
    content: HarContent;
    headersSize: number;
    bodySize: number;
  };
  timings: { send: number; wait: number; receive: number };
}

export interface HarLog {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

// State for an active HAR recording
interface PendingHarEntry {
  entry: Partial<HarEntry>;
  startTime: number;
  requestId: string;
  mimeType?: string;
}

interface HarRecorderState {
  cdpSession: CDPSession;
  pending: Map<string, PendingHarEntry>;
  completed: HarEntry[];
  pendingBodyFetches: number;
  bodyFetchDone?: () => void; // Called when pendingBodyFetches reaches 0
}

// Helper: parse Cookie header into HarCookie array
function parseCookieHeader(cookieHeader: string): HarCookie[] {
  if (!cookieHeader) return [];
  return cookieHeader.split(";").map((part) => {
    const [name, ...rest] = part.trim().split("=");
    return { name: name ?? "", value: rest.join("=") };
  });
}

// Helper: parse Set-Cookie header into HarCookie
function parseSetCookie(setCookie: string): HarCookie {
  const parts = setCookie.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const [name, ...rest] = (nameValue ?? "").split("=");
  const cookie: HarCookie = { name: name ?? "", value: rest.join("=") };

  for (const attr of attrs) {
    const [key, val] = attr.split("=");
    const lowerKey = key?.toLowerCase();
    if (lowerKey === "path") cookie.path = val;
    else if (lowerKey === "domain") cookie.domain = val;
    else if (lowerKey === "expires") cookie.expires = val;
    else if (lowerKey === "httponly") cookie.httpOnly = true;
    else if (lowerKey === "secure") cookie.secure = true;
    else if (lowerKey === "samesite") cookie.sameSite = val;
  }
  return cookie;
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
  try {
    await page.goto(url, { waitUntil: "commit", timeout });
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
      };
    }
  }

  // Phase 2: Wait for page load with graceful timeout
  if (options.waitForLoad !== false) {
    const remainingTime = Math.max(timeout - (Date.now() - startTime), 2000);
    const loadResult = await waitForPageLoad(page, { timeout: remainingTime });

    return {
      success: loadResult.success && !navigationTimedOut,
      url: page.url(),
      readyState: loadResult.readyState,
      pendingRequests: loadResult.pendingRequests,
      totalTimeMs: Date.now() - startTime,
      navigationTimedOut,
      loadTimedOut: loadResult.timedOut,
    };
  }

  return {
    success: !navigationTimedOut,
    url: page.url(),
    readyState: "unknown",
    pendingRequests: 0,
    totalTimeMs: Date.now() - startTime,
    navigationTimedOut,
    loadTimedOut: false,
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
}

/** Default ports for each server mode */
const DEFAULT_PORTS = {
  standalone: 9222,
  extension: 9224,
  electron: 9225,
} as const;

/**
 * Options for connecting to the dev-browser server
 */
export interface ConnectOptions {
  /**
   * Server mode. Determines which port to connect to if serverUrl is not specified.
   * - "standalone": Fresh Chromium browser (port 9222)
   * - "extension": User's Chrome via extension (port 9224)
   * - "electron": Connect directly to Electron app's CDP (port 9225)
   * @default "standalone"
   */
  mode?: "standalone" | "extension" | "electron";
  /**
   * CDP port for electron mode. The Electron app must be started with
   * --remote-debugging-port=XXXX
   * @default 9225
   */
  cdpPort?: number;
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
   * @param name - Page name
   * @throws Error if recording is already active for this page
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
   */
  isRecordingHar: (name: string) => boolean;
  /**
   * Save HAR as WACZ (Web Archive Collection Zipped) file.
   * WACZ is a standard format for portable web archives.
   *
   * @param har - HAR data from stopHarRecording()
   * @param outputPath - Path for the .wacz file
   * @param options - Optional title and description
   */
  saveAsWacz: (
    har: HarLog,
    outputPath: string,
    options?: { title?: string; description?: string }
  ) => Promise<void>;
  /**
   * Stop HAR recording and save as WACZ in one step.
   * Recording is auto-started by page(), so this is usually all you need.
   *
   * @param name - Page name
   * @param options - Output path (defaults to ~/.dev-browser/archives/<name>-<timestamp>.wacz),
   *                  title, and description
   * @returns Path to the saved WACZ file
   */
  saveWacz: (
    name: string,
    options?: { outputPath?: string; title?: string; description?: string }
  ) => Promise<string>;
  /**
   * Save a complete archive bundle: WACZ + rendered HTML + PDF in a single .zip.
   * This is the recommended way to archive a page for search engine ingestion.
   *
   * Recording is auto-started by page(), so typical usage is:
   * ```typescript
   * const page = await client.page("research");
   * await page.goto("https://example.com");
   * const archivePath = await client.saveArchive("research");
   * ```
   *
   * The .zip contains:
   * - `<name>.wacz` — WARC-based web archive (network traffic)
   * - `<name>.html` — as-rendered DOM snapshot
   * - `<name>.pdf`  — PDF rendering of the page
   *
   * @param name - Page name
   * @param options - Output path, title, description, and format controls
   * @returns Path to the saved .zip archive
   */
  saveArchive: (
    name: string,
    options?: {
      outputPath?: string;
      title?: string;
      description?: string;
      /** Skip PDF capture (e.g., if page.pdf() fails in headed mode) */
      skipPdf?: boolean;
      /** Skip rendered HTML capture */
      skipHtml?: boolean;
    }
  ) => Promise<string>;
}

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
  // Track which pages have HAR recording (for isRecordingHar check)
  const harPages = new Set<string>();

  // Local helper to stop HAR recording (avoids `this` context issues in object literal)
  async function stopRecording(name: string): Promise<HarLog> {
    if (!harPages.has(name)) {
      throw new Error(`No HAR recording active for page "${name}"`);
    }
    const res = await fetch(`${serverUrl}/har/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ page: name }),
    });
    if (!res.ok) {
      throw new Error(`Failed to stop HAR recording: ${await res.text()}`);
    }
    harPages.delete(name);
    const har = (await res.json()) as HarLog;
    logger.debug(
      `Stopped HAR recording for "${name}" (${har.log.entries.length} entries)`
    );
    return har;
  }

  logger.debug(`Extension mode: HTTP RPC to ${serverUrl}`);

  return {
    async page(name: string, options?: PageOptions): Promise<Page> {
      const res = await fetch(`${serverUrl}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders },
        body: JSON.stringify({
          name,
          viewport: options?.viewport,
          pinned: options?.pinned,
        } satisfies GetPageRequest),
      });

      if (!res.ok) {
        throw new Error(`Failed to get page: ${await res.text()}`);
      }

      const pageInfo = (await res.json()) as GetPageResponse & { url?: string };
      const page = new CDPPage(serverUrl, name, session, pageInfo.url);

      // Auto-start HAR recording unless opted out
      if (options?.record !== false && !harPages.has(name)) {
        try {
          const harRes = await fetch(`${serverUrl}/har/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...sessionHeaders },
            body: JSON.stringify({ page: name }),
          });
          if (harRes.ok) {
            harPages.add(name);
            logger.debug(`Auto-started HAR recording for "${name}"`);
          }
        } catch (err) {
          logger.warn(
            `Failed to auto-start HAR recording for "${name}":`,
            err
          );
        }
      }

      return page;
    },

    async list(): Promise<string[]> {
      const res = await fetch(`${serverUrl}/pages`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      harPages.delete(name);
      const res = await fetch(
        `${serverUrl}/pages/${encodeURIComponent(name)}`,
        { method: "DELETE", headers: sessionHeaders }
      );
      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    async pin(name: string, pinned = true): Promise<void> {
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
    },

    async disconnect(): Promise<void> {
      // For auto-generated sessions, close all pages
      if (isAutoGenerated) {
        try {
          const res = await fetch(
            `${serverUrl}/sessions/${encodeURIComponent(session)}`,
            { method: "DELETE", headers: sessionHeaders }
          );
          const data = (await res.json()) as { closed?: number };
          if (data.closed && data.closed > 0) {
            logger.debug(
              `Auto-closed ${data.closed} page(s) for ephemeral session`
            );
          }
        } catch {
          // Server may be unreachable
        }
      }
      harPages.clear();
    },

    async getAISnapshot(name: string): Promise<string> {
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
    },

    async selectSnapshotRef(
      _name: string,
      _ref: string
    ): Promise<ElementHandle | null> {
      // ElementHandle requires Playwright — not available in extension mode.
      // Use CDPPage.clickRef() / fillRef() instead.
      logger.warn(
        "selectSnapshotRef is not available in extension mode. " +
          "Use page.clickRef(ref) or page.fillRef(ref, value) instead."
      );
      return null;
    },

    async getServerInfo(): Promise<ServerInfo> {
      const res = await fetch(serverUrl);
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
        mode: (info.mode as "launch" | "extension") ?? "extension",
        extensionConnected: info.extensionConnected,
      };
    },

    getSession(): string {
      return session;
    },

    async allTargets(): Promise<BrowserTarget[]> {
      const res = await fetch(`${serverUrl}/all-targets`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as {
        error?: string;
        targets?: BrowserTarget[];
      };
      if (data.error) throw new Error(data.error);
      return data.targets ?? [];
    },

    async closeTarget(tabId: number): Promise<void> {
      const res = await fetch(`${serverUrl}/close-target`, {
        method: "POST",
        headers: { ...sessionHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ tabId }),
      });
      const data = (await res.json()) as {
        error?: string;
        success?: boolean;
      };
      if (data.error) throw new Error(data.error);
    },

    async cleanup(pattern: string): Promise<{ closed: number; urls: string[] }> {
      const res = await fetch(`${serverUrl}/cleanup`, {
        method: "POST",
        headers: { ...sessionHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      const data = (await res.json()) as {
        error?: string;
        closed?: number;
        urls?: string[];
      };
      if (data.error) throw new Error(data.error);
      return { closed: data.closed ?? 0, urls: data.urls ?? [] };
    },

    async closeAll(): Promise<{ closed: number; pages: string[] }> {
      const res = await fetch(
        `${serverUrl}/sessions/${encodeURIComponent(session)}`,
        { method: "DELETE", headers: sessionHeaders }
      );
      const data = (await res.json()) as {
        error?: string;
        closed?: number;
        pages?: string[];
      };
      if (data.error) throw new Error(data.error);
      const result = { closed: data.closed ?? 0, pages: data.pages ?? [] };
      if (result.closed > 0) {
        logger.debug(
          `Closed ${result.closed} page(s): ${result.pages.join(", ")}`
        );
      }
      harPages.clear();
      return result;
    },

    async startHarRecording(name: string): Promise<void> {
      if (harPages.has(name)) {
        throw new Error(`HAR recording already active for page "${name}"`);
      }
      const res = await fetch(`${serverUrl}/har/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders },
        body: JSON.stringify({ page: name }),
      });
      if (!res.ok) {
        throw new Error(`Failed to start HAR recording: ${await res.text()}`);
      }
      harPages.add(name);
      logger.debug(`Started HAR recording for "${name}"`);
    },

    async stopHarRecording(name: string): Promise<HarLog> {
      return stopRecording(name);
    },

    isRecordingHar(name: string): boolean {
      return harPages.has(name);
    },

    async saveAsWacz(
      har: HarLog,
      outputPath: string,
      options?: { title?: string; description?: string }
    ): Promise<void> {
      await createWaczFromHar(har, outputPath, options);
      logger.info(`Saved WACZ to ${outputPath}`);
    },

    async saveWacz(
      name: string,
      options?: {
        outputPath?: string;
        title?: string;
        description?: string;
      }
    ): Promise<string> {
      const har = await stopRecording(name);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveDir = join(homedir(), ".dev-browser", "archives");
      await mkdir(archiveDir, { recursive: true });
      const outputPath =
        options?.outputPath ?? join(archiveDir, `${name}-${timestamp}.wacz`);
      await createWaczFromHar(har, outputPath, {
        title: options?.title,
        description: options?.description,
      });
      logger.info(`Saved WACZ to ${outputPath}`);
      return outputPath;
    },

    async saveArchive(
      name: string,
      options?: {
        outputPath?: string;
        title?: string;
        description?: string;
        skipPdf?: boolean;
        skipHtml?: boolean;
      }
    ): Promise<string> {
      // Get the page to capture HTML and PDF before stopping recording
      const pageRes = await fetch(`${serverUrl}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders },
        body: JSON.stringify({ name } satisfies GetPageRequest),
      });
      if (!pageRes.ok) {
        throw new Error(`Failed to get page for archive: ${await pageRes.text()}`);
      }
      const pageInfo = (await pageRes.json()) as GetPageResponse & {
        url?: string;
      };
      const page = new CDPPage(serverUrl, name, session, pageInfo.url);

      // Capture rendered HTML
      let renderedHtml: string | null = null;
      if (!options?.skipHtml) {
        try {
          renderedHtml = await page.content();
        } catch (err) {
          logger.warn(
            `Failed to capture rendered HTML for "${name}":`,
            err
          );
        }
      }

      // Capture PDF
      let pdfBuffer: Buffer | null = null;
      if (!options?.skipPdf) {
        try {
          pdfBuffer = await page.pdf({ printBackground: true });
        } catch (err) {
          logger.warn(
            `Failed to capture PDF for "${name}":`,
            err
          );
        }
      }

      // Stop recording and create WACZ
      const har = await stopRecording(name);
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
      const outputPath =
        options?.outputPath ?? join(archiveDir, `${name}-${timestamp}.zip`);

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
      logger.info(
        `Saved archive to ${outputPath} (${parts.join(" + ")})`
      );
      return outputPath;
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

  // Headers to include session in all requests
  const sessionHeaders = { "X-DevBrowser-Session": session };

  // ---- Extension mode: HTTP RPC via CDPPage (no Playwright) ----
  if (opts.mode === "extension") {
    return connectExtensionMode(serverUrl, session, sessionHeaders, isAutoGenerated);
  }

  // ---- Standalone / Electron mode: Playwright-based implementation ----
  let browser: Browser | null = null;
  let wsEndpoint: string | null = null;
  let connectingPromise: Promise<Browser> | null = null;
  const isElectronMode = opts.mode === "electron";
  const electronCdpPort = opts.cdpPort ?? DEFAULT_PORTS.electron;
  let cachedServerMode: "launch" | "extension" | null = null;

  // Track active HAR recordings: pageName -> recorder state
  const harRecorders = new Map<string, HarRecorderState>();

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
        if (isElectronMode) {
          // Electron mode: connect directly to Electron's CDP endpoint
          // Fetch wsEndpoint from Electron's /json/version endpoint
          const cdpUrl = `http://127.0.0.1:${electronCdpPort}/json/version`;
          logger.debug(`Connecting to Electron CDP at ${cdpUrl}...`);

          const res = await fetch(cdpUrl);
          if (!res.ok) {
            throw new Error(
              `Could not connect to Electron CDP at port ${electronCdpPort}. ` +
              `Make sure the Electron app is running with --remote-debugging-port=${electronCdpPort}`
            );
          }
          const info = (await res.json()) as { webSocketDebuggerUrl: string };
          wsEndpoint = info.webSocketDebuggerUrl;
          logger.debug(`Electron CDP WebSocket: ${wsEndpoint}`);

          // Connect to Electron via CDP
          browser = await chromium.connectOverCDP(wsEndpoint);
          return browser;
        }

        // Standard mode: fetch wsEndpoint from dev-browser server
        const res = await fetch(serverUrl);
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}: ${await res.text()}`);
        }
        const info = (await res.json()) as ServerInfoResponse;

        // Include session in CDP URL for multi-agent isolation
        // (Playwright's connectOverCDP can't send custom headers)
        wsEndpoint = `${info.wsEndpoint}/${encodeURIComponent(session)}`;

        // Connect to the browser via CDP
        browser = await chromium.connectOverCDP(wsEndpoint);
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

    // Electron mode: get pages directly without server
    if (isElectronMode) {
      const allPages = b.contexts().flatMap((ctx) => ctx.pages());

      // Filter out DevTools pages
      const appPages = allPages.filter((p) => {
        const url = p.url();
        return !url.startsWith("devtools://") && !url.startsWith("chrome-devtools://");
      });

      logger.debug(`Electron mode: found ${allPages.length} page(s), ${appPages.length} app page(s)`);

      if (appPages.length === 0) {
        throw new Error(`No app pages available in Electron. Is the window open?`);
      }

      // Return first non-devtools page
      // TODO: Support multiple windows by name/URL matching
      const page = appPages[0]!;
      logger.debug(`Using page: ${page.url()}`);
      return page;
    }

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

    // In launch mode, use the original targetId-based lookup
    const page = await findPageByTargetId(b, targetId);
    if (!page) {
      throw new Error(`Page "${name}" not found in browser contexts`);
    }

    return page;
  }

  // Helper: set up HAR recording CDP listeners on a page
  async function setupHarRecording(page: PlaywrightPage): Promise<HarRecorderState> {
    const cdpSession = await page.context().newCDPSession(page);
    const state: HarRecorderState = {
      cdpSession,
      pending: new Map(),
      completed: [],
      pendingBodyFetches: 0,
    };

    await cdpSession.send("Network.enable");

    cdpSession.on("Network.requestWillBeSent", (params) => {
      const url = new URL(params.request.url);
      const headers = Object.entries(params.request.headers).map(([n, v]) => ({
        name: n,
        value: String(v),
      }));
      const cookieHeader = params.request.headers["Cookie"] ?? params.request.headers["cookie"] ?? "";
      const cookies = parseCookieHeader(cookieHeader);
      const postData = params.request.postData
        ? {
            mimeType: params.request.headers["Content-Type"] ??
                      params.request.headers["content-type"] ?? "application/octet-stream",
            text: params.request.postData,
          }
        : undefined;

      state.pending.set(params.requestId, {
        startTime: params.timestamp * 1000,
        requestId: params.requestId,
        entry: {
          startedDateTime: new Date(params.wallTime * 1000).toISOString(),
          request: {
            method: params.request.method,
            url: params.request.url,
            httpVersion: "HTTP/1.1",
            headers,
            queryString: [...url.searchParams].map(([n, v]) => ({ name: n, value: v })),
            cookies,
            headersSize: -1,
            bodySize: params.request.postData?.length ?? 0,
            postData,
          },
        },
      });
    });

    cdpSession.on("Network.responseReceived", (params) => {
      const pending = state.pending.get(params.requestId);
      if (!pending) return;

      const timing = params.response.timing;
      const headers = Object.entries(params.response.headers).map(([n, v]) => ({
        name: n,
        value: String(v),
      }));

      const resCookies: HarCookie[] = [];
      for (const [hName, hValue] of Object.entries(params.response.headers)) {
        if (hName.toLowerCase() === "set-cookie") {
          resCookies.push(parseSetCookie(String(hValue)));
        }
      }

      pending.mimeType = params.response.mimeType;
      pending.entry.response = {
        status: params.response.status,
        statusText: params.response.statusText,
        httpVersion: params.response.protocol ?? "HTTP/1.1",
        headers,
        cookies: resCookies,
        content: {
          size: params.response.encodedDataLength ?? 0,
          mimeType: params.response.mimeType,
        },
        headersSize: -1,
        bodySize: -1,
      };

      if (timing) {
        pending.entry.timings = {
          send: timing.sendEnd - timing.sendStart,
          wait: timing.receiveHeadersEnd - timing.sendEnd,
          receive: 0,
        };
      }
    });

    cdpSession.on("Network.loadingFinished", async (params) => {
      const pending = state.pending.get(params.requestId);
      if (!pending?.entry.response) return;

      const endTime = params.timestamp * 1000;
      pending.entry.time = endTime - pending.startTime;
      pending.entry.response.bodySize = params.encodedDataLength;

      if (pending.entry.timings) {
        pending.entry.timings.receive = Math.max(
          0,
          pending.entry.time - (pending.entry.timings.send + pending.entry.timings.wait)
        );
      } else {
        pending.entry.timings = { send: 0, wait: pending.entry.time, receive: 0 };
      }

      const isText = pending.mimeType?.startsWith("text/") ||
                     pending.mimeType?.includes("json") ||
                     pending.mimeType?.includes("xml") ||
                     pending.mimeType?.includes("javascript");
      if (isText && params.encodedDataLength < 1024 * 1024) {
        state.pendingBodyFetches++;
        try {
          const { body, base64Encoded } = await cdpSession.send("Network.getResponseBody", {
            requestId: params.requestId,
          });
          pending.entry.response.content.text = body;
          if (base64Encoded) {
            pending.entry.response.content.encoding = "base64";
          }
        } catch {
          // Body may not be available
        } finally {
          state.pendingBodyFetches--;
          if (state.pendingBodyFetches === 0 && state.bodyFetchDone) {
            state.bodyFetchDone();
          }
        }
      }

      state.completed.push(pending.entry as HarEntry);
      state.pending.delete(params.requestId);
    });

    cdpSession.on("Network.loadingFailed", (params) => {
      state.pending.delete(params.requestId);
    });

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

  return {
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
      return p as unknown as Page;
    },

    async list(): Promise<string[]> {
      if (isElectronMode) {
        // Electron mode: list page URLs from browser
        const b = await ensureConnected();
        const allPages = b.contexts().flatMap((ctx) => ctx.pages());
        return allPages.map((p) => p.url());
      }

      const res = await fetch(`${serverUrl}/pages`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      // Clean up any active HAR recording for this page
      await discardHarRecording(name);

      if (isElectronMode) {
        // Electron mode: can't close windows via CDP, just log
        logger.debug(`Electron mode: close("${name}") is a no-op`);
        return;
      }

      const res = await fetch(`${serverUrl}/pages/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: sessionHeaders,
      });

      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    async pin(name: string, pinned = true): Promise<void> {
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
    },

    async disconnect(): Promise<void> {
      // Clean up all active HAR recordings
      for (const name of [...harRecorders.keys()]) {
        await discardHarRecording(name);
      }

      if (isElectronMode) {
        // Electron mode: just disconnect CDP, don't try to close pages
        if (browser) {
          await browser.close();
          browser = null;
        }
        return;
      }

      // For auto-generated sessions, close all pages first (they can't be reconnected anyway)
      if (isAutoGenerated) {
        try {
          const res = await fetch(`${serverUrl}/sessions/${encodeURIComponent(session)}`, {
            method: "DELETE",
            headers: sessionHeaders,
          });
          const data = (await res.json()) as { closed?: number };
          if (data.closed && data.closed > 0) {
            logger.debug(`Auto-closed ${data.closed} page(s) for ephemeral session`);
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

    async getServerInfo(): Promise<ServerInfo> {
      const res = await fetch(serverUrl);
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
        mode: (info.mode as "launch" | "extension") ?? "launch",
        extensionConnected: info.extensionConnected,
      };
    },

    getSession(): string {
      return session;
    },

    async allTargets(): Promise<BrowserTarget[]> {
      const res = await fetch(`${serverUrl}/all-targets`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as { error?: string; targets?: BrowserTarget[] };
      if (data.error) throw new Error(data.error);
      return data.targets ?? [];
    },

    async closeTarget(tabId: number): Promise<void> {
      const res = await fetch(`${serverUrl}/close-target`, {
        method: "POST",
        headers: { ...sessionHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ tabId }),
      });
      const data = (await res.json()) as { error?: string; success?: boolean };
      if (data.error) throw new Error(data.error);
    },

    async cleanup(pattern: string): Promise<{ closed: number; urls: string[] }> {
      const res = await fetch(`${serverUrl}/cleanup`, {
        method: "POST",
        headers: { ...sessionHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      const data = (await res.json()) as { error?: string; closed?: number; urls?: string[] };
      if (data.error) throw new Error(data.error);
      return { closed: data.closed ?? 0, urls: data.urls ?? [] };
    },

    async closeAll(): Promise<{ closed: number; pages: string[] }> {
      if (isElectronMode) {
        logger.debug(`Electron mode: closeAll() is a no-op`);
        return { closed: 0, pages: [] };
      }

      const res = await fetch(`${serverUrl}/sessions/${encodeURIComponent(session)}`, {
        method: "DELETE",
        headers: sessionHeaders,
      });
      const data = (await res.json()) as { error?: string; closed?: number; pages?: string[] };
      if (data.error) throw new Error(data.error);

      const result = { closed: data.closed ?? 0, pages: data.pages ?? [] };
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

    isRecordingHar(name: string): boolean {
      return harRecorders.has(name);
    },

    async saveAsWacz(
      har: HarLog,
      outputPath: string,
      options?: { title?: string; description?: string }
    ): Promise<void> {
      await createWaczFromHar(har, outputPath, options);
      logger.info(`Saved WACZ to ${outputPath}`);
    },

    async saveWacz(
      name: string,
      options?: { outputPath?: string; title?: string; description?: string }
    ): Promise<string> {
      const har = await collectHarRecording(name);

      // Default path: ~/.dev-browser/archives/<name>-<ISO-timestamp>.wacz
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
    },

    async saveArchive(
      name: string,
      options?: {
        outputPath?: string;
        title?: string;
        description?: string;
        skipPdf?: boolean;
        skipHtml?: boolean;
      }
    ): Promise<string> {
      // Get the live page before stopping recording
      const page = await getPage(name);

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
          pdfBuffer = await page.pdf({ format: "Letter", printBackground: true });
        } catch (err) {
          logger.warn(`Failed to capture PDF for "${name}":`, err);
        }
      }

      // Stop recording and create WACZ in temp directory
      const har = await collectHarRecording(name);
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

      // Clean up temp
      rmSync(tempDir, { recursive: true });

      const parts = [
        "wacz",
        renderedHtml !== null ? "html" : null,
        pdfBuffer !== null ? "pdf" : null,
      ].filter(Boolean);
      logger.info(`Saved archive to ${outputPath} (${parts.join(" + ")})`);
      return outputPath;
    },
  };
}
