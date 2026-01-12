import { chromium, type Browser, type Page, type ElementHandle } from "playwright";
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  ViewportSize,
} from "./types";
import { getSnapshotScript } from "./snapshot/browser-script";
import type {
  NetworkSearchOptions,
  NetworkSearchResult,
  NetworkRequest,
} from "./network-store";

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
  page: Page,
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
async function getPageLoadState(page: Page): Promise<PageLoadState> {
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
}

export interface DevBrowserClient {
  page: (name: string, options?: PageOptions) => Promise<Page>;
  list: () => Promise<string[]>;
  close: (name: string) => Promise<void>;
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
   * Search network requests for a page with optional filtering.
   * Returns request summaries (use networkDetail for full info).
   */
  network: (name: string, options?: NetworkSearchOptions) => Promise<NetworkSearchResult>;
  /**
   * Get full details for a specific network request.
   */
  networkDetail: (name: string, requestId: string) => Promise<NetworkRequest>;
  /**
   * Get response body for a specific network request.
   * Bodies are fetched on-demand for large responses.
   */
  networkBody: (name: string, requestId: string) => Promise<{ body: string; base64Encoded: boolean }>;
  /**
   * Clear stored network requests for a page.
   */
  clearNetwork: (name: string) => Promise<void>;
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
  // 1. Explicit opts.session (user override)
  // 2. CLAUDE_SESSION_ID env var (from SessionStart hook - provides per-agent persistence)
  // 3. Fall back to generated session ID
  const session =
    opts.session ??
    process.env.CLAUDE_SESSION_ID ??
    `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // Log session source for debugging
  if (opts.session) {
    console.log(`[dev-browser] Session: ${session} (explicit)`);
  } else if (process.env.CLAUDE_SESSION_ID) {
    console.log(`[dev-browser] Session: ${session} (from CLAUDE_SESSION_ID)`);
  } else {
    console.log(`[dev-browser] Session: ${session} (generated - pages won't persist across scripts)`);
  }

  // Headers to include session in all requests
  const sessionHeaders = { "X-DevBrowser-Session": session };
  let browser: Browser | null = null;
  let wsEndpoint: string | null = null;
  let connectingPromise: Promise<Browser> | null = null;

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
        // Fetch wsEndpoint from server
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
  async function findPageByTargetId(b: Browser, targetId: string): Promise<Page | null> {
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
            console.warn(`Unexpected error checking page target: ${msg}`);
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
  async function getPage(name: string, options?: PageOptions): Promise<Page> {
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

    // Connect to browser
    const b = await ensureConnected();

    // Check if we're in extension mode
    const infoRes = await fetch(serverUrl);
    const info = (await infoRes.json()) as { mode?: string };
    const isExtensionMode = info.mode === "extension";

    if (isExtensionMode) {
      // In extension mode, DON'T use findPageByTargetId as it corrupts page state
      // Instead, find page by URL or use the only available page
      const allPages = b.contexts().flatMap((ctx) => ctx.pages());

      if (allPages.length === 0) {
        throw new Error(`No pages available in browser`);
      }

      if (allPages.length === 1) {
        return allPages[0]!;
      }

      // Multiple pages - try to match by URL if available
      if (pageInfo.url) {
        const matchingPage = allPages.find((p) => p.url() === pageInfo.url);
        if (matchingPage) {
          return matchingPage;
        }
      }

      // Fall back to first page
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

  return {
    page: getPage,

    async list(): Promise<string[]> {
      const res = await fetch(`${serverUrl}/pages`, {
        headers: sessionHeaders,
      });
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      const res = await fetch(`${serverUrl}/pages/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: sessionHeaders,
      });

      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    async disconnect(): Promise<void> {
      // Just disconnect the CDP connection - pages persist on server
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

    async network(name: string, options?: NetworkSearchOptions): Promise<NetworkSearchResult> {
      const queryParams = new URLSearchParams();
      if (options?.filter?.url) queryParams.set("url", options.filter.url);
      if (options?.filter?.method) queryParams.set("method", options.filter.method);
      if (options?.filter?.status !== undefined) queryParams.set("status", String(options.filter.status));
      if (options?.filter?.statusMin !== undefined) queryParams.set("statusMin", String(options.filter.statusMin));
      if (options?.filter?.statusMax !== undefined) queryParams.set("statusMax", String(options.filter.statusMax));
      if (options?.filter?.resourceType) queryParams.set("resourceType", options.filter.resourceType);
      if (options?.filter?.failed !== undefined) queryParams.set("failed", String(options.filter.failed));
      if (options?.filter?.hasResponseBody !== undefined) queryParams.set("hasResponseBody", String(options.filter.hasResponseBody));
      if (options?.sortBy) queryParams.set("sortBy", options.sortBy);
      if (options?.sortOrder) queryParams.set("sortOrder", options.sortOrder);
      if (options?.limit !== undefined) queryParams.set("limit", String(options.limit));
      if (options?.offset !== undefined) queryParams.set("offset", String(options.offset));

      const url = `${serverUrl}/pages/${encodeURIComponent(name)}/network?${queryParams.toString()}`;
      const res = await fetch(url, { headers: sessionHeaders });

      if (!res.ok) {
        throw new Error(`Failed to get network requests: ${await res.text()}`);
      }

      return (await res.json()) as NetworkSearchResult;
    },

    async networkDetail(name: string, requestId: string): Promise<NetworkRequest> {
      const res = await fetch(
        `${serverUrl}/pages/${encodeURIComponent(name)}/network/${encodeURIComponent(requestId)}`,
        { headers: sessionHeaders }
      );

      if (!res.ok) {
        throw new Error(`Failed to get network request detail: ${await res.text()}`);
      }

      return (await res.json()) as NetworkRequest;
    },

    async networkBody(name: string, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
      const res = await fetch(
        `${serverUrl}/pages/${encodeURIComponent(name)}/network/${encodeURIComponent(requestId)}/body`,
        { headers: sessionHeaders }
      );

      if (!res.ok) {
        throw new Error(`Failed to get response body: ${await res.text()}`);
      }

      return (await res.json()) as { body: string; base64Encoded: boolean };
    },

    async clearNetwork(name: string): Promise<void> {
      const res = await fetch(
        `${serverUrl}/pages/${encodeURIComponent(name)}/network`,
        { method: "DELETE", headers: sessionHeaders }
      );

      if (!res.ok) {
        throw new Error(`Failed to clear network requests: ${await res.text()}`);
      }
    },
  };
}
