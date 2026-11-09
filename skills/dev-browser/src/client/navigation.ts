/**
 * Page-load waiting and navigation helpers: waitForPageLoad() and navigateTo().
 */

import type { Page as PlaywrightPage } from "patchright";
import type { Page } from "../page.js";
import {
  classifyNavigationError,
  detectChallengeFromSignals,
  readPageSignals,
  type Challenge,
  type NavigationErrorKind,
  type PageSignals,
} from "../challenge.js";

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
  let load = {
    success: !navigationTimedOut,
    readyState: "unknown",
    pendingRequests: 0,
    timedOut: false,
  };
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
    ...(navigationTimedOut
      ? { error: { kind: "timeout" as const, message: "Navigation timed out" } }
      : {}),
  };
}
