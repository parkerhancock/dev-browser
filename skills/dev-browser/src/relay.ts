/**
 * CDP Relay Server for Chrome Extension mode
 *
 * This server acts as a bridge between Playwright clients and a Chrome extension.
 * Instead of launching a browser, it waits for the extension to connect and
 * forwards CDP commands/events between them.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import {
  loadPersistedPages,
  savePersistedPages,
  createDebouncedSave,
  type PersistedPage,
} from "./persistence.js";
import { createLogger } from "./logging.js";
import { getSnapshotScript } from "./snapshot/browser-script.js";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// ============================================================================
// Types
// ============================================================================

export interface RelayOptions {
  port?: number;
  host?: string;
}

export interface RelayServer {
  wsEndpoint: string;
  port: number;
  stop(): Promise<void>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  browserContextId?: string;
  attached: boolean;
}

interface ConnectedTarget {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
  lastActivity: number; // Timestamp of last CDP activity
  pinned: boolean; // Pinned pages are exempt from idle cleanup (for human collaboration)
}

// Session state for multi-agent isolation
interface SessionState {
  id: string;
  pageNames: Set<string>; // Page names owned by this session
  targetSessions: Set<string>; // CDP sessionIds owned by this session
}

// Message types for extension communication
interface ExtensionCommandMessage {
  id: number;
  method: "forwardCDPCommand";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

interface ExtensionResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

interface ExtensionEventMessage {
  method: "forwardCDPEvent";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | { method: "log"; params: { level: string; args: string[] } };

// ============================================================================
// Relay Server Implementation
// ============================================================================

export async function serveRelay(options: RelayOptions = {}): Promise<RelayServer> {
  const port = options.port ?? 9224;
  const host = options.host ?? "127.0.0.1";

  // State
  const connectedTargets = new Map<string, ConnectedTarget>();
  const namedPages = new Map<string, string>(); // "session:name" -> CDP sessionId
  const pageKeyByTargetId = new Map<string, string>(); // targetId -> "session:name"
  // Track pending detach with targetId for reattachment matching
  const pendingDetach = new Map<string, { timeout: NodeJS.Timeout; targetId: string }>(); // cdpSessionId -> {timeout, targetId}
  // Waiters for target attachment (event-driven replacement for sleep after createTarget)
  const pendingTargetWaiters = new Map<string, { resolve: () => void }>();
  let extensionWs: WSContext | null = null;
  let isRecovering = false; // True during extension reconnect recovery

  // Logging
  const { log, logFile } = createLogger("relay", { stdout: true });

  // Tab limits
  const TAB_WARNING_THRESHOLD = 3;
  const TAB_LIMIT = 5;

  // Idle timeout: close pages with no CDP activity after 15 seconds.
  // Page state (cookies, localStorage) persists in Chrome, so agents can
  // re-open named pages cheaply. Short timeout keeps tab count minimal.
  const IDLE_TIMEOUT_MS = 15 * 1000; // 15 seconds
  const IDLE_CHECK_INTERVAL_MS = 5 * 1000; // Check every 5 seconds

  // PDF storage for large printToPDF responses
  const pdfDir = join(homedir(), ".dev-browser", "pdfs");
  mkdirSync(pdfDir, { recursive: true });
  const pdfFiles = new Map<string, { path: string; createdAt: number }>(); // id -> file info
  const PDF_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

  // Cleanup old PDF files on startup and periodically
  function cleanupOldPdfs() {
    const now = Date.now();
    // Clean up tracked files
    for (const [id, info] of pdfFiles) {
      if (now - info.createdAt > PDF_MAX_AGE_MS) {
        try {
          unlinkSync(info.path);
        } catch {
          // File may already be deleted
        }
        pdfFiles.delete(id);
      }
    }
    // Clean up orphaned files on disk
    try {
      for (const file of readdirSync(pdfDir)) {
        const filePath = join(pdfDir, file);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > PDF_MAX_AGE_MS) {
          unlinkSync(filePath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
  cleanupOldPdfs();
  const pdfCleanupInterval = setInterval(cleanupOldPdfs, 60 * 1000); // Every minute

  // ---- Server-side HAR recording ----
  // Buffers CDP Network events per-page for HAR generation.
  // This replaces the client-side CDPSession-based HAR recording in extension mode.

  interface HarCookie {
    name: string;
    value: string;
    path?: string;
    domain?: string;
    expires?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }

  interface HarEntry {
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
      postData?: { mimeType: string; text: string };
    };
    response: {
      status: number;
      statusText: string;
      httpVersion: string;
      headers: Array<{ name: string; value: string }>;
      cookies: HarCookie[];
      content: { size: number; mimeType: string; text?: string; encoding?: string };
      headersSize: number;
      bodySize: number;
    };
    timings: { send: number; wait: number; receive: number };
  }

  interface PendingHarEntry {
    entry: Partial<HarEntry>;
    startTime: number;
    requestId: string;
    mimeType?: string;
  }

  interface RelayHarState {
    cdpSessionId: string;
    pending: Map<string, PendingHarEntry>;
    completed: HarEntry[];
  }

  const harRecorders = new Map<string, RelayHarState>(); // pageKey -> state

  function parseCookieHeader(cookieHeader: string): HarCookie[] {
    if (!cookieHeader) return [];
    return cookieHeader.split(";").map((part) => {
      const [name, ...rest] = part.trim().split("=");
      return { name: name ?? "", value: rest.join("=") };
    });
  }

  function parseSetCookie(setCookie: string): HarCookie {
    const parts = setCookie.split(";").map((p) => p.trim());
    const [nameValue, ...attrs] = parts;
    const [name, ...rest] = (nameValue ?? "").split("=");
    const cookie: HarCookie = { name: name ?? "", value: rest.join("=") };
    for (const attr of attrs) {
      const [key, val] = attr.split("=");
      const lk = key?.toLowerCase();
      if (lk === "path") cookie.path = val;
      else if (lk === "domain") cookie.domain = val;
      else if (lk === "expires") cookie.expires = val;
      else if (lk === "httponly") cookie.httpOnly = true;
      else if (lk === "secure") cookie.secure = true;
      else if (lk === "samesite") cookie.sameSite = val;
    }
    return cookie;
  }

  /** Handle a CDP Network event for HAR recording */
  function handleHarNetworkEvent(
    state: RelayHarState,
    method: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: Record<string, any>
  ): void {
    if (method === "Network.requestWillBeSent") {
      const url = new URL(params.request.url);
      const headers = Object.entries(params.request.headers).map(([n, v]) => ({
        name: n,
        value: String(v),
      }));
      const cookieHeader =
        params.request.headers["Cookie"] ?? params.request.headers["cookie"] ?? "";
      const cookies = parseCookieHeader(cookieHeader);
      const postData = params.request.postData
        ? {
            mimeType:
              params.request.headers["Content-Type"] ??
              params.request.headers["content-type"] ??
              "application/octet-stream",
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
            queryString: [...url.searchParams].map(([n, v]) => ({
              name: n,
              value: v,
            })),
            cookies,
            headersSize: -1,
            bodySize: params.request.postData?.length ?? 0,
            postData,
          },
        },
      });
    } else if (method === "Network.responseReceived") {
      const pending = state.pending.get(params.requestId);
      if (!pending) return;

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

      const timing = params.response.timing;
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
    } else if (method === "Network.loadingFinished") {
      const pending = state.pending.get(params.requestId);
      if (!pending?.entry.response) return;

      const endTime = params.timestamp * 1000;
      pending.entry.time = endTime - pending.startTime;
      pending.entry.response.bodySize = params.encodedDataLength;

      if (pending.entry.timings) {
        pending.entry.timings.receive = Math.max(
          0,
          pending.entry.time -
            (pending.entry.timings.send + pending.entry.timings.wait)
        );
      } else {
        pending.entry.timings = {
          send: 0,
          wait: pending.entry.time,
          receive: 0,
        };
      }

      // Fetch response body for text content (async, but fire-and-forget)
      const isText =
        pending.mimeType?.startsWith("text/") ||
        pending.mimeType?.includes("json") ||
        pending.mimeType?.includes("xml") ||
        pending.mimeType?.includes("javascript");
      if (isText && params.encodedDataLength < 1024 * 1024) {
        sendToExtension({
          method: "forwardCDPCommand",
          params: {
            sessionId: state.cdpSessionId,
            method: "Network.getResponseBody",
            params: { requestId: params.requestId },
          },
        })
          .then((bodyResult) => {
            const br = bodyResult as {
              body?: string;
              base64Encoded?: boolean;
            };
            if (br.body) {
              pending.entry.response!.content.text = br.body;
              if (br.base64Encoded) {
                pending.entry.response!.content.encoding = "base64";
              }
            }
          })
          .catch(() => {
            // Body may not be available
          });
      }

      state.completed.push(pending.entry as HarEntry);
      state.pending.delete(params.requestId);
    } else if (method === "Network.loadingFailed") {
      state.pending.delete(params.requestId);
    }
  }

  // Idle page cleanup - close pages with no activity
  async function cleanupIdlePages(): Promise<void> {
    const now = Date.now();
    const idleThreshold = now - IDLE_TIMEOUT_MS;

    for (const [cdpSessionId, target] of connectedTargets) {
      if (target.pinned) continue; // Pinned pages are exempt (human collaboration)
      if (target.lastActivity < idleThreshold) {
        // Find the page key for logging
        const pageKey = pageKeyByTargetId.get(target.targetId);
        log(`Idle timeout: closing ${pageKey ?? target.targetId} (inactive for ${Math.round((now - target.lastActivity) / 1000)}s)`);

        // Close the tab via extension
        if (extensionWs) {
          try {
            await sendToExtension({
              method: "forwardCDPCommand",
              params: { method: "Target.closeTarget", params: { targetId: target.targetId } },
              timeout: 5000,
            });
          } catch (err) {
            log(`Failed to close idle tab ${target.targetId}: ${err}`);
          }
        }

        // Clean up mappings (the Target.detachedFromTarget event will also fire)
        if (pageKey) {
          namedPages.delete(pageKey);
          pageKeyByTargetId.delete(target.targetId);

          // Extract session and name from pageKey
          const colonIdx = pageKey.indexOf(":");
          if (colonIdx > 0) {
            const owningSession = pageKey.slice(0, colonIdx);
            const pageName = pageKey.slice(colonIdx + 1);
            const sessionState = sessions.get(owningSession);
            if (sessionState) {
              sessionState.pageNames.delete(pageName);
              sessionState.targetSessions.delete(cdpSessionId);
            }
          }

          // Remove from persistence
          persistedPages = persistedPages.filter((p) => p.key !== pageKey);
          debouncedSave();
        }

        targetToAgentSession.delete(cdpSessionId);
        connectedTargets.delete(cdpSessionId);
      }
    }
  }

  const idleCleanupInterval = setInterval(cleanupIdlePages, IDLE_CHECK_INTERVAL_MS);

  // Multi-agent session state
  const sessions = new Map<string, SessionState>();
  const targetToAgentSession = new Map<string, string>(); // CDP sessionId -> agent session

  // Persistence for page mappings (survives extension disconnects)
  let persistedPages: PersistedPage[] = loadPersistedPages();
  log(`Loaded ${persistedPages.length} persisted page mappings`);
  const debouncedSave = createDebouncedSave(() => persistedPages);

  // Pending requests to extension
  const extensionPendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let extensionMessageId = 0;

  // ============================================================================
  // Helper Functions
  // ============================================================================

  // Helper to get or create a session
  function getOrCreateSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        pageNames: new Set(),
        targetSessions: new Set(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  }

  /** Check if a target belongs to an agent session */
  function isTargetOwnedBySession(
    cdpSessionId: string,
    agentSession: string
  ): boolean {
    return targetToAgentSession.get(cdpSessionId) === agentSession;
  }

  /** Get all CDP sessionIds owned by an agent session */
  function getSessionTargets(agentSession: string): string[] {
    const sessionState = sessions.get(agentSession);
    return sessionState ? Array.from(sessionState.targetSessions) : [];
  }

  // Recover persisted pages by re-attaching to existing tabs
  async function recoverPersistedPages(): Promise<void> {
    if (persistedPages.length === 0) {
      log("No persisted pages to recover");
      isRecovering = false;
      return;
    }

    log(`Attempting to recover ${persistedPages.length} persisted pages...`);

    // Ask extension for available targets (tabs we can attach to)
    let availableTargets: Array<{
      tabId: number;
      targetId: string;
      url: string;
    }>;

    try {
      const result = (await sendToExtension({
        method: "getAvailableTargets",
        params: {},
      })) as { targets: typeof availableTargets };
      availableTargets = result.targets;
    } catch (err) {
      log("Failed to get available targets:", err);
      isRecovering = false;
      return;
    }

    log(`Found ${availableTargets.length} available targets`);

    // Build lookup by targetId and URL for matching
    const targetsByUrl = new Map<string, (typeof availableTargets)[0]>();
    for (const target of availableTargets) {
      targetsByUrl.set(target.url, target);
    }

    const recovered: string[] = [];
    const stale: string[] = [];

    for (const persisted of persistedPages) {
      // Try to find matching tab by URL
      const matchingTarget = targetsByUrl.get(persisted.url);

      if (matchingTarget) {
        try {
          // Ask extension to attach debugger to this tab
          const attachResult = (await sendToExtension({
            method: "attachToTab",
            params: { tabId: matchingTarget.tabId },
          })) as { sessionId: string; targetInfo: TargetInfo };

          const cdpSessionId = attachResult.sessionId;

          // Rebuild in-memory mappings
          connectedTargets.set(cdpSessionId, {
            sessionId: cdpSessionId,
            targetId: attachResult.targetInfo.targetId,
            targetInfo: attachResult.targetInfo,
            lastActivity: Date.now(),
            pinned: false,
          });
          namedPages.set(persisted.key, cdpSessionId);
          pageKeyByTargetId.set(attachResult.targetInfo.targetId, persisted.key);

          // Parse session and page name from key
          const colonIdx = persisted.key.indexOf(":");
          const agentSession = persisted.key.slice(0, colonIdx);
          const pageName = persisted.key.slice(colonIdx + 1);

          const sessionState = getOrCreateSession(agentSession);
          sessionState.pageNames.add(pageName);
          sessionState.targetSessions.add(cdpSessionId);
          targetToAgentSession.set(cdpSessionId, agentSession);

          // Update persisted entry with new targetId
          persisted.targetId = attachResult.targetInfo.targetId;
          persisted.tabId = matchingTarget.tabId;
          persisted.lastSeen = Date.now();

          recovered.push(persisted.key);
          log(`Recovered: ${persisted.key} -> ${persisted.url}`);
        } catch (err) {
          log(`Failed to reattach ${persisted.key}: ${err}`);
          stale.push(persisted.key);
        }
      } else {
        log(`Tab not found for ${persisted.key} (${persisted.url})`);
        stale.push(persisted.key);
      }
    }

    // Clean up stale entries
    if (stale.length > 0) {
      persistedPages = persistedPages.filter((p) => !stale.includes(p.key));
      savePersistedPages(persistedPages);
    } else if (recovered.length > 0) {
      // Save updated entries
      savePersistedPages(persistedPages);
    }

    log(`Recovery complete: ${recovered.length} recovered, ${stale.length} stale`);
    isRecovering = false;
  }

  async function sendToExtension({
    method,
    params,
    timeout = 30000,
  }: {
    method: string;
    params?: Record<string, unknown>;
    timeout?: number;
  }): Promise<unknown> {
    if (!extensionWs) {
      throw new Error("Extension not connected");
    }

    const id = ++extensionMessageId;
    const message = { id, method, params };

    extensionWs.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        extensionPendingRequests.delete(id);
        reject(new Error(`Extension request timeout after ${timeout}ms: ${method}`));
      }, timeout);

      extensionPendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });
  }

  async function routeCdpCommand({
    method,
    params,
    sessionId,
    agentSession = "default",
  }: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
    agentSession?: string;
  }): Promise<unknown> {
    // Handle some CDP commands locally
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/Extension-Bridge",
          revision: "1.0.0",
          userAgent: "dev-browser-relay/1.0.0",
          jsVersion: "V8",
        };

      case "Browser.setDownloadBehavior":
        return {};

      case "Target.setAutoAttach":
        if (sessionId) {
          break; // Forward to extension for child frames
        }
        return {};

      case "Target.setDiscoverTargets":
        return {};

      case "Target.attachToBrowserTarget":
        // Browser-level session - return a fake session since we only proxy tabs
        return { sessionId: "browser" };

      case "Target.detachFromTarget":
        // If detaching from our fake "browser" session, just return success
        if (sessionId === "browser" || params?.sessionId === "browser") {
          return {};
        }
        // Otherwise forward to extension
        break;

      case "Target.attachToTarget": {
        const targetId = params?.targetId as string;
        if (!targetId) {
          throw new Error("targetId is required for Target.attachToTarget");
        }

        for (const [cdpSessionId, target] of connectedTargets) {
          if (target.targetId === targetId) {
            const owner = targetToAgentSession.get(cdpSessionId);
            // Allow if owned by this session OR unclaimed (for new page creation)
            if (!owner || owner === agentSession) {
              // Claim unclaimed targets
              if (!owner) {
                targetToAgentSession.set(cdpSessionId, agentSession);
                const sessionState = getOrCreateSession(agentSession);
                sessionState.targetSessions.add(cdpSessionId);
              }
              return { sessionId: cdpSessionId };
            }
            throw new Error(`Target ${targetId} belongs to another session`);
          }
        }

        throw new Error(`Target ${targetId} not found in connected targets`);
      }

      case "Target.getTargetInfo": {
        const targetId = params?.targetId as string;

        if (targetId) {
          for (const [cdpSessionId, target] of connectedTargets) {
            if (target.targetId === targetId) {
              const owner = targetToAgentSession.get(cdpSessionId);
              // Only return info if owned by this session or unclaimed
              if (!owner || owner === agentSession) {
                return { targetInfo: { ...target.targetInfo, attached: true } };
              }
              throw new Error(`Target ${targetId} belongs to another session`);
            }
          }
        }

        if (sessionId) {
          const target = connectedTargets.get(sessionId);
          if (target) {
            const owner = targetToAgentSession.get(sessionId);
            if (!owner || owner === agentSession) {
              return { targetInfo: { ...target.targetInfo, attached: true } };
            }
          }
        }

        // Return first owned target if no specific one requested
        const ownedSessionIds = getSessionTargets(agentSession);
        const firstOwned = Array.from(connectedTargets.values()).find((t) =>
          ownedSessionIds.includes(t.sessionId)
        );
        if (firstOwned) {
          return { targetInfo: { ...firstOwned.targetInfo, attached: true } };
        }
        // No local targets - return browser-level target info for initial handshake
        // This allows Playwright's connectOverCDP to succeed before tabs are created
        return {
          targetInfo: {
            targetId: "browser",
            type: "browser",
            title: "Chrome",
            url: "",
            attached: true,
          },
        };
      }

      case "Target.getTargets": {
        const ownedSessionIds = getSessionTargets(agentSession);
        const ownedTargets = Array.from(connectedTargets.values()).filter((t) =>
          ownedSessionIds.includes(t.sessionId)
        );
        return {
          targetInfos: ownedTargets.map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        };
      }

      case "Target.createTarget":
      case "Target.closeTarget":
        // Forward to extension
        return await sendToExtension({
          method: "forwardCDPCommand",
          params: { method, params },
        });

      case "Page.printToPDF": {
        // Intercept PDF generation to handle large responses
        log(`Page.printToPDF requested for session ${sessionId}`);

        // Forward the command to extension
        const pdfResult = (await sendToExtension({
          method: "forwardCDPCommand",
          params: { sessionId, method, params },
        })) as { data?: string; stream?: string };

        if (!pdfResult.data) {
          throw new Error("PDF generation failed: no data returned");
        }

        // Save PDF to disk instead of returning inline
        const pdfId = randomUUID();
        const pdfPath = join(pdfDir, `${pdfId}.pdf`);
        const pdfBuffer = Buffer.from(pdfResult.data, "base64");
        writeFileSync(pdfPath, pdfBuffer);

        pdfFiles.set(pdfId, { path: pdfPath, createdAt: Date.now() });

        log(`Page.printToPDF saved ${pdfBuffer.length} bytes to ${pdfPath}`);

        // Return URL instead of base64 data
        // The client will need to download from this URL
        return {
          data: pdfResult.data, // Still return data for compatibility
          _pdfUrl: `http://${host}:${port}/pdf/${pdfId}`,
          _pdfSize: pdfBuffer.length,
        };
      }
    }

    // Forward all other commands to extension
    const result = await sendToExtension({
      method: "forwardCDPCommand",
      params: { sessionId, method, params },
    });

    // Update activity timestamp for the target
    if (sessionId) {
      const target = connectedTargets.get(sessionId);
      if (target) {
        target.lastActivity = Date.now();
      }
    }

    return result;
  }

  // ============================================================================
  // HTTP/WebSocket Server
  // ============================================================================

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Health check / server info
  app.get("/", (c) => {
    return c.json({
      wsEndpoint: `ws://${host}:${port}/cdp`,
      extensionConnected: extensionWs !== null,
      mode: "extension",
    });
  });

  // List named pages (filtered by session)
  app.get("/pages", (c) => {
    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const sessionState = sessions.get(agentSession);

    if (!sessionState) {
      return c.json({ pages: [] });
    }

    // Return only this session's page names (without session prefix)
    return c.json({
      pages: Array.from(sessionState.pageNames),
    });
  });

  // Get or create a named page (namespaced by session)
  app.post("/pages", async (c) => {
    // Block requests during extension reconnect recovery
    if (isRecovering) {
      return c.json({ error: "Extension reconnecting, please retry" }, 503);
    }

    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const body = await c.req.json();
    const name = body.name as string;
    const pinned = body.pinned === true; // Pinned pages are exempt from idle cleanup

    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    // Validate session and page name don't contain colons (used as key delimiter)
    if (agentSession.includes(":")) {
      return c.json({ error: "Session ID must not contain colons" }, 400);
    }
    if (name.includes(":")) {
      return c.json({ error: "Page name must not contain colons" }, 400);
    }

    // Internal key includes session prefix for isolation
    const pageKey = `${agentSession}:${name}`;

    // Ensure session exists
    const sessionState = getOrCreateSession(agentSession);

    const sessionPageCount = sessionState.pageNames.size;

    // Check if page already exists for THIS session
    const existingCdpSessionId = namedPages.get(pageKey);
    if (existingCdpSessionId) {
      const target = connectedTargets.get(existingCdpSessionId);
      if (target) {
        // Update pinned flag if explicitly set on reuse
        if (pinned && !target.pinned) {
          target.pinned = true;
        }
        // Return existing page without activating (use page.bringToFront() if needed)
        log(`POST /pages session=${agentSession} name=${name} action=reused pinned=${target.pinned} total=${namedPages.size} sessionTotal=${sessionPageCount}`);
        return c.json({
          wsEndpoint: `ws://${host}:${port}/cdp`,
          name, // Return without session prefix
          targetId: target.targetId,
          url: target.targetInfo.url,
          pinned: target.pinned,
        });
      }
      // CDP session no longer valid, clean up
      log(`POST /pages session=${agentSession} name=${name} action=stale-cleanup`);
      namedPages.delete(pageKey);
      sessionState.pageNames.delete(name);
    }

    // Check tab limits before creating
    if (sessionPageCount >= TAB_LIMIT) {
      log(`POST /pages session=${agentSession} name=${name} action=rejected-limit total=${namedPages.size} sessionTotal=${sessionPageCount}`);
      return c.json(
        {
          error: `Tab limit exceeded. Session "${agentSession}" already has ${sessionPageCount} tabs (limit: ${TAB_LIMIT}). Close some tabs before opening new ones.`,
        },
        429
      );
    }

    // Check for warning threshold
    let warning: string | undefined;
    if (sessionPageCount >= TAB_WARNING_THRESHOLD) {
      warning = `Warning: Session "${agentSession}" has ${sessionPageCount} tabs. Limit is ${TAB_LIMIT}. Consider closing unused tabs.`;
      log(`POST /pages session=${agentSession} name=${name} warning=approaching-limit sessionTotal=${sessionPageCount}`);
    }

    // Create a new tab
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    try {
      const result = (await sendToExtension({
        method: "forwardCDPCommand",
        params: { method: "Target.createTarget", params: { url: "about:blank" } },
      })) as { targetId: string; tabId: number };

      // Wait for Target.attachedToTarget event to register the new target
      // Check if already registered (event may have arrived before we started waiting)
      let targetAlreadyRegistered = false;
      for (const [, t] of connectedTargets) {
        if (t.targetId === result.targetId) {
          targetAlreadyRegistered = true;
          break;
        }
      }

      if (!targetAlreadyRegistered) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingTargetWaiters.delete(result.targetId);
            reject(new Error(`Timeout waiting for target ${result.targetId} to attach (5s)`));
          }, 5000);

          pendingTargetWaiters.set(result.targetId, {
            resolve: () => {
              clearTimeout(timeout);
              resolve();
            },
          });
        });
      }

      // Find and name the new target
      for (const [cdpSessionId, target] of connectedTargets) {
        if (target.targetId === result.targetId) {
          // Apply pinned flag from request
          target.pinned = pinned;

          // Register with namespaced key
          namedPages.set(pageKey, cdpSessionId);
          pageKeyByTargetId.set(target.targetId, pageKey);
          sessionState.pageNames.add(name);

          // Track reverse mapping for event routing
          targetToAgentSession.set(cdpSessionId, agentSession);
          sessionState.targetSessions.add(cdpSessionId);

          // Persist the page mapping
          persistedPages = persistedPages.filter((p) => p.key !== pageKey);
          persistedPages.push({
            key: pageKey,
            targetId: target.targetId,
            tabId: result.tabId,
            url: target.targetInfo.url,
            lastSeen: Date.now(),
          });
          savePersistedPages(persistedPages);

          log(`POST /pages session=${agentSession} name=${name} action=created pinned=${pinned} total=${namedPages.size} sessionTotal=${sessionState.pageNames.size}`);

          // Return new page without activating (use page.bringToFront() if needed)
          const response: {
            wsEndpoint: string;
            name: string;
            targetId: string;
            url: string;
            pinned: boolean;
            warning?: string;
          } = {
            wsEndpoint: `ws://${host}:${port}/cdp`,
            name, // Return without session prefix
            targetId: target.targetId,
            url: target.targetInfo.url,
            pinned,
          };
          if (warning) {
            response.warning = warning;
          }
          return c.json(response);
        }
      }

      throw new Error("Target created but not found in registry");
    } catch (err) {
      log("Error creating tab:", err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Delete a named page (filtered by session)
  app.delete("/pages/:name", (c) => {
    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const name = c.req.param("name");
    const pageKey = `${agentSession}:${name}`;

    const cdpSessionId = namedPages.get(pageKey);
    if (!cdpSessionId) {
      log(`DELETE /pages session=${agentSession} name=${name} action=not-found`);
      return c.json({ error: "Page not found" }, 404);
    }

    // Clean up mappings
    namedPages.delete(pageKey);
    // Also clean up targetId reverse mapping
    const target = connectedTargets.get(cdpSessionId);
    if (target) {
      pageKeyByTargetId.delete(target.targetId);
    }
    const sessionState = sessions.get(agentSession);
    if (sessionState) {
      sessionState.pageNames.delete(name);
      sessionState.targetSessions.delete(cdpSessionId);
    }
    targetToAgentSession.delete(cdpSessionId);

    // Remove from persistence
    persistedPages = persistedPages.filter((p) => p.key !== pageKey);
    savePersistedPages(persistedPages);

    log(`DELETE /pages session=${agentSession} name=${name} action=deleted total=${namedPages.size}`);
    return c.json({ success: true });
  });

  // Pin/unpin a page (pinned pages are exempt from idle cleanup)
  app.patch("/pages/:name", async (c) => {
    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const name = c.req.param("name");
    const pageKey = `${agentSession}:${name}`;

    const cdpSessionId = namedPages.get(pageKey);
    if (!cdpSessionId) {
      return c.json({ error: "Page not found" }, 404);
    }

    const target = connectedTargets.get(cdpSessionId);
    if (!target) {
      return c.json({ error: "Page target not connected" }, 404);
    }

    const body = await c.req.json();
    if (typeof body.pinned === "boolean") {
      target.pinned = body.pinned;
      log(`PATCH /pages session=${agentSession} name=${name} pinned=${target.pinned}`);
    }

    return c.json({ name, pinned: target.pinned });
  });

  // Get server stats for debugging
  app.get("/stats", (c) => {
    // Group pages by session
    const sessionStats: Record<string, string[]> = {};
    for (const [pageKey] of namedPages) {
      const parts = pageKey.split(":");
      const session = parts[0] ?? "unknown";
      const name = parts.slice(1).join(":");
      if (!sessionStats[session]) {
        sessionStats[session] = [];
      }
      sessionStats[session].push(name);
    }

    return c.json({
      namedPages: namedPages.size,
      pageKeyByTargetId: pageKeyByTargetId.size,
      pendingDetach: pendingDetach.size,
      connectedTargets: connectedTargets.size,
      sessions: sessions.size,
      persistedPages: persistedPages.length,
      extensionConnected: !!extensionWs,
      harRecorders: harRecorders.size,
      tabLimit: TAB_LIMIT,
      tabWarningThreshold: TAB_WARNING_THRESHOLD,
      bySession: sessionStats,
    });
  });

  // Download a generated PDF file
  app.get("/pdf/:id", (c) => {
    const id = c.req.param("id");
    const pdfInfo = pdfFiles.get(id);

    if (!pdfInfo) {
      return c.json({ error: "PDF not found or expired" }, 404);
    }

    try {
      const { readFileSync } = require("fs");
      const pdfData = readFileSync(pdfInfo.path);

      // Delete after download (one-time use)
      try {
        unlinkSync(pdfInfo.path);
      } catch {
        // Ignore deletion errors
      }
      pdfFiles.delete(id);

      return new Response(pdfData, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${id}.pdf"`,
        },
      });
    } catch {
      pdfFiles.delete(id);
      return c.json({ error: "PDF file not found" }, 404);
    }
  });

  // ============================================================================
  // Tab Management Endpoints (bypass session isolation for management)
  // ============================================================================

  // List all browser tabs (not just session-scoped ones)
  app.get("/all-targets", async (c) => {
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    try {
      const result = (await sendToExtension({
        method: "getAvailableTargets",
        params: {},
      })) as {
        targets: Array<{ tabId: number; url: string; title: string; targetId?: string }>;
      };

      return c.json({
        targets: result.targets.map((t) => ({
          tabId: t.tabId,
          targetId: t.targetId,
          url: t.url,
          title: t.title,
        })),
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Close a specific tab by tabId
  app.post("/close-target", async (c) => {
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const { tabId } = await c.req.json();

    if (!tabId) {
      return c.json({ error: "Must provide tabId" }, 400);
    }

    try {
      await sendToExtension({
        method: "closeTab",
        params: { tabId },
      });

      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Close all pages for a session (for SessionEnd hook integration)
  app.delete("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const sessionState = sessions.get(sessionId);

    if (!sessionState || sessionState.pageNames.size === 0) {
      log(`DELETE /sessions/${sessionId} - no pages to close`);
      return c.json({ closed: 0, pages: [] });
    }

    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const closedPages: string[] = [];
    const errors: string[] = [];

    // Snapshot page names before iterating (set modified during iteration)
    const pageNames = Array.from(sessionState.pageNames);

    // Close each page in the session
    for (const pageName of pageNames) {
      const pageKey = `${sessionId}:${pageName}`;
      const cdpSessionId = namedPages.get(pageKey);

      if (cdpSessionId) {
        const target = connectedTargets.get(cdpSessionId);
        if (target) {
          try {
            await sendToExtension({
              method: "forwardCDPCommand",
              params: { method: "Target.closeTarget", params: { targetId: target.targetId } },
              timeout: 5000,
            });
            closedPages.push(pageName);
          } catch (err) {
            errors.push(`${pageName}: ${err}`);
          }

          // Clean up mappings immediately (don't wait for async detach events)
          pageKeyByTargetId.delete(target.targetId);
          connectedTargets.delete(cdpSessionId);
        }

        namedPages.delete(pageKey);
        targetToAgentSession.delete(cdpSessionId!);
      }

      sessionState.pageNames.delete(pageName);
      sessionState.targetSessions.delete(cdpSessionId!);
    }

    // Remove persistence entries for this session
    persistedPages = persistedPages.filter((p) => !p.key.startsWith(`${sessionId}:`));
    savePersistedPages(persistedPages);

    log(`DELETE /sessions/${sessionId} - closed ${closedPages.length} pages: ${closedPages.join(", ")}`);
    return c.json({ closed: closedPages.length, pages: closedPages, errors: errors.length > 0 ? errors : undefined });
  });

  // Close all tabs matching a URL pattern
  app.post("/cleanup", async (c) => {
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const { pattern } = await c.req.json();

    if (!pattern) {
      return c.json({ error: "Must provide pattern (string or regex)" }, 400);
    }

    try {
      const result = (await sendToExtension({
        method: "getAvailableTargets",
        params: {},
      })) as { targets: Array<{ tabId: number; url: string }> };

      const regex = new RegExp(pattern);
      const matching = result.targets.filter((t) => regex.test(t.url));

      for (const target of matching) {
        await sendToExtension({
          method: "closeTab",
          params: { tabId: target.tabId },
        });
      }

      return c.json({ closed: matching.length, urls: matching.map((t) => t.url) });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ============================================================================
  // HTTP CDP Endpoint (replaces WebSocket proxy for extension mode)
  // ============================================================================

  /**
   * POST /cdp — Stateless CDP command execution.
   *
   * Body: { page: string, method: string, params?: object }
   * Response: { result: object } | { error: { message: string } }
   *
   * Routes CDP commands to the extension via sendToExtension. No session tracking,
   * no message routing, no reconnection state — just request/response.
   */
  app.post("/cdp", async (c) => {
    if (!extensionWs) {
      return c.json({ error: { message: "Extension not connected" } }, 503);
    }

    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const body = await c.req.json();
    const { page: pageName, method, params } = body as {
      page: string;
      method: string;
      params?: Record<string, unknown>;
    };

    if (!pageName || !method) {
      return c.json(
        { error: { message: "page and method are required" } },
        400
      );
    }

    // Resolve page name to CDP sessionId
    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);

    if (!cdpSessionId) {
      return c.json(
        { error: { message: `Page "${pageName}" not found in session "${agentSession}"` } },
        404
      );
    }

    try {
      const result = await routeCdpCommand({
        method,
        params,
        sessionId: cdpSessionId,
        agentSession,
      });

      return c.json({ result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`POST /cdp error: ${method} for ${pageName}: ${msg}`);
      return c.json({ error: { message: msg } }, 500);
    }
  });

  // ============================================================================
  // Server-side HAR Recording Endpoints
  // ============================================================================

  /**
   * POST /har/start — Enable Network domain and start buffering events.
   * Body: { page: string }
   */
  app.post("/har/start", async (c) => {
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const { page: pageName } = (await c.req.json()) as { page: string };
    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);

    if (!cdpSessionId) {
      return c.json({ error: `Page "${pageName}" not found` }, 404);
    }

    if (harRecorders.has(pageKey)) {
      return c.json({ error: `HAR recording already active for "${pageName}"` }, 409);
    }

    // Enable Network domain for this page
    await sendToExtension({
      method: "forwardCDPCommand",
      params: {
        sessionId: cdpSessionId,
        method: "Network.enable",
        params: {},
      },
    });

    harRecorders.set(pageKey, {
      cdpSessionId,
      pending: new Map(),
      completed: [],
    });

    log(`HAR recording started for ${pageKey}`);
    return c.json({ success: true });
  });

  /**
   * POST /har/stop — Stop recording and return HAR data.
   * Body: { page: string }
   */
  app.post("/har/stop", async (c) => {
    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const { page: pageName } = (await c.req.json()) as { page: string };
    const pageKey = `${agentSession}:${pageName}`;
    const state = harRecorders.get(pageKey);

    if (!state) {
      return c.json({ error: `No HAR recording active for "${pageName}"` }, 404);
    }

    // Give pending body fetches a moment to complete
    await new Promise((r) => setTimeout(r, 500));

    harRecorders.delete(pageKey);

    log(`HAR recording stopped for ${pageKey} (${state.completed.length} entries)`);
    return c.json({
      log: {
        version: "1.2",
        creator: { name: "dev-browser", version: "0.0.1" },
        entries: state.completed,
      },
    });
  });

  /**
   * GET /har/status — Check if HAR recording is active for a page.
   */
  app.get("/har/status", (c) => {
    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const pageName = c.req.query("page");
    if (!pageName) {
      return c.json({ error: "page query param required" }, 400);
    }
    const pageKey = `${agentSession}:${pageName}`;
    return c.json({ recording: harRecorders.has(pageKey) });
  });

  // ============================================================================
  // ARIA Snapshot & Ref-based Interaction Endpoints
  // ============================================================================

  /**
   * POST /snapshot — Get ARIA snapshot for a page.
   * Body: { page: string }
   * Response: { snapshot: string }
   */
  app.post("/snapshot", async (c) => {
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const { page: pageName } = (await c.req.json()) as { page: string };
    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);

    if (!cdpSessionId) {
      return c.json({ error: `Page "${pageName}" not found` }, 404);
    }

    try {
      const snapshotScript = getSnapshotScript();

      // Inject snapshot script and call it
      const result = (await sendToExtension({
        method: "forwardCDPCommand",
        params: {
          sessionId: cdpSessionId,
          method: "Runtime.evaluate",
          params: {
            expression: `(() => {
              const w = globalThis;
              if (!w.__devBrowser_getAISnapshot) {
                eval(${JSON.stringify(snapshotScript)});
              }
              return w.__devBrowser_getAISnapshot();
            })()`,
            returnByValue: true,
            awaitPromise: true,
          },
        },
        timeout: 15000,
      })) as { result: { value: string } };

      return c.json({ snapshot: result.result.value });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  /**
   * POST /ref-action — Interact with an element by ARIA snapshot ref.
   * Body: { page: string, action: "click" | "fill", ref: string, value?: string }
   */
  app.post("/ref-action", async (c) => {
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const { page: pageName, action, ref, value } = (await c.req.json()) as {
      page: string;
      action: string;
      ref: string;
      value?: string;
    };
    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);

    if (!cdpSessionId) {
      return c.json({ error: `Page "${pageName}" not found` }, 404);
    }

    let expression: string;

    if (action === "click") {
      expression = `(() => {
        const refs = globalThis.__devBrowserRefs;
        if (!refs) throw new Error("No refs available - call snapshot first");
        const el = refs[${JSON.stringify(ref)}];
        if (!el) throw new Error("Ref ${ref} not found");
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      })()`;
    } else if (action === "fill") {
      expression = `(() => {
        const refs = globalThis.__devBrowserRefs;
        if (!refs) throw new Error("No refs available - call snapshot first");
        const el = refs[${JSON.stringify(ref)}];
        if (!el) throw new Error("Ref ${ref} not found");
        el.scrollIntoView({ block: "center" });
        el.focus();
        el.value = ${JSON.stringify(value ?? "")};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`;
    } else {
      return c.json({ error: `Unknown action: ${action}` }, 400);
    }

    try {
      await sendToExtension({
        method: "forwardCDPCommand",
        params: {
          sessionId: cdpSessionId,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        },
      });

      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ============================================================================
  // Extension WebSocket
  // ============================================================================

  app.get(
    "/extension",
    upgradeWebSocket(() => {
      return {
        onOpen(_event, ws) {
          if (extensionWs) {
            log("Closing existing extension connection");
            extensionWs.close(4001, "Extension Replaced");

            // Only clear connectedTargets - CDP sessions are invalid after reconnect
            // Keep namedPages, sessions, targetToAgentSession - recovery will update them
            connectedTargets.clear();
            isRecovering = true;
            for (const pending of extensionPendingRequests.values()) {
              pending.reject(new Error("Extension reconnecting, please retry"));
            }
            extensionPendingRequests.clear();
          }

          extensionWs = ws;
          log("Extension connected");

          // Attempt recovery of persisted pages after connection stabilizes
          setTimeout(() => {
            recoverPersistedPages().catch((err) => {
              log("Recovery failed:", err);
            });
          }, 500);
        },

        async onMessage(event, ws) {
          let message: ExtensionMessage;

          try {
            message = JSON.parse(event.data.toString());
          } catch {
            ws.close(1000, "Invalid JSON");
            return;
          }

          // Handle response to our request
          if ("id" in message && typeof message.id === "number") {
            const pending = extensionPendingRequests.get(message.id);
            if (!pending) {
              log("Unexpected response with id:", message.id);
              return;
            }

            extensionPendingRequests.delete(message.id);

            if ((message as ExtensionResponseMessage).error) {
              pending.reject(new Error((message as ExtensionResponseMessage).error));
            } else {
              pending.resolve((message as ExtensionResponseMessage).result);
            }
            return;
          }

          // Handle log messages
          if ("method" in message && message.method === "log") {
            const { level, args } = message.params;
            console.log(`[extension:${level}]`, ...args);
            return;
          }

          // Handle CDP events from extension
          if ("method" in message && message.method === "forwardCDPEvent") {
            const eventMsg = message as ExtensionEventMessage;
            const { method, params, sessionId } = eventMsg.params;

            // Handle target lifecycle events
            if (method === "Target.attachedToTarget") {
              const targetParams = params as {
                sessionId: string;
                targetInfo: TargetInfo;
              };

              // Only track page targets - ignore service workers, iframes, etc.
              // Service workers (like x.com/sw.js) can interfere with CDP routing
              const targetType = targetParams.targetInfo.type;
              if (targetType !== "page") {
                log(`Ignoring non-page target: ${targetType} ${targetParams.targetInfo.url}`);
                return;
              }

              const target: ConnectedTarget = {
                sessionId: targetParams.sessionId,
                targetId: targetParams.targetInfo.targetId,
                targetInfo: targetParams.targetInfo,
                lastActivity: Date.now(),
                pinned: false,
              };
              connectedTargets.set(targetParams.sessionId, target);

              // Resolve any pending waiter for this targetId (from POST /pages)
              const waiter = pendingTargetWaiters.get(targetParams.targetInfo.targetId);
              if (waiter) {
                pendingTargetWaiters.delete(targetParams.targetInfo.targetId);
                waiter.resolve();
              }

              log(`Target attached: ${targetParams.targetInfo.url} (${targetParams.sessionId})`);

              // Check if this is a reattachment after cross-origin navigation
              // If we have a pending detach for this targetId, cancel it and update mappings
              const pageKey = pageKeyByTargetId.get(targetParams.targetInfo.targetId);

              // Find and cancel any pending detach for this targetId (regardless of old sessionId)
              for (const [oldSessionId, pendingInfo] of pendingDetach) {
                if (pendingInfo.targetId === targetParams.targetInfo.targetId) {
                  clearTimeout(pendingInfo.timeout);
                  pendingDetach.delete(oldSessionId);
                  log(`Cancelled pending detach for ${oldSessionId} - target ${targetParams.targetInfo.targetId} reattached as ${targetParams.sessionId}`);

                  // Clean up the old session from connectedTargets if it's still there
                  connectedTargets.delete(oldSessionId);
                  break;
                }
              }

              if (pageKey) {
                // Update all mappings atomically to point to the new CDP sessionId
                const oldCdpSessionId = namedPages.get(pageKey);
                if (oldCdpSessionId && oldCdpSessionId !== targetParams.sessionId) {
                  // Update namedPages
                  namedPages.set(pageKey, targetParams.sessionId);

                  // Extract session info and update session state
                  const colonIdx = pageKey.indexOf(":");
                  if (colonIdx > 0) {
                    const owningSession = pageKey.slice(0, colonIdx);
                    const sessionState = sessions.get(owningSession);
                    if (sessionState) {
                      sessionState.targetSessions.delete(oldCdpSessionId);
                      sessionState.targetSessions.add(targetParams.sessionId);
                    }
                    // Update targetToAgentSession
                    targetToAgentSession.delete(oldCdpSessionId);
                    targetToAgentSession.set(targetParams.sessionId, owningSession);
                  }

                  // Clean up old session from connectedTargets
                  connectedTargets.delete(oldCdpSessionId);

                  log(`Updated mappings for ${pageKey}: ${oldCdpSessionId} -> ${targetParams.sessionId} (cross-origin navigation)`);
                }
              }

              // No need to forward to Playwright — CDPPage uses HTTP RPC
            } else if (method === "Target.detachedFromTarget") {
              const detachParams = params as { sessionId: string };
              const cdpSessionId = detachParams.sessionId;

              // Get target info BEFORE cleanup (needed to check for reattachment)
              const target = connectedTargets.get(cdpSessionId);
              const targetId = target?.targetId;

              // Find the owning agent session before cleanup
              const agentSession = targetToAgentSession.get(cdpSessionId);

              // DON'T delete from connectedTargets immediately!
              // Keep it so reattachment logic can find the old session info.
              // It will be deleted either:
              // 1. In the deferred cleanup timeout (if no reattachment)
              // 2. In the reattachment handler (when new session takes over)

              // Check if this session owns a named page
              let ownedPageKey: string | undefined;
              for (const [pageKey, sid] of namedPages) {
                if (sid === cdpSessionId) {
                  ownedPageKey = pageKey;
                  break;
                }
              }

              // If this session owns a named page, defer cleanup to allow for reattachment
              // during cross-origin navigation (new session may attach with same targetId)
              if (ownedPageKey && targetId) {
                log(`Target detached: ${cdpSessionId} (targetId=${targetId}) - deferring cleanup for potential reattachment`);

                const cleanupTimeout = setTimeout(() => {
                  pendingDetach.delete(cdpSessionId);

                  // Check if a new session has taken over this page
                  const currentSessionId = namedPages.get(ownedPageKey!);
                  if (currentSessionId && currentSessionId !== cdpSessionId) {
                    // A new session took over - don't clean up (reattachment handler already did)
                    log(`Skipping cleanup for ${cdpSessionId} - page ${ownedPageKey} now owned by ${currentSessionId}`);
                    return;
                  }

                  // No reattachment happened - do the full cleanup
                  log(`Cleanup timeout fired for ${cdpSessionId} - no reattachment, cleaning up`);

                  // Now delete from connectedTargets
                  connectedTargets.delete(cdpSessionId);

                  namedPages.delete(ownedPageKey!);
                  if (targetId) {
                    pageKeyByTargetId.delete(targetId);
                  }

                  // Extract session and name from pageKey
                  const colonIdx = ownedPageKey!.indexOf(":");
                  if (colonIdx > 0) {
                    const owningSession = ownedPageKey!.slice(0, colonIdx);
                    const pageName = ownedPageKey!.slice(colonIdx + 1);
                    const sessionState = sessions.get(owningSession);
                    if (sessionState) {
                      sessionState.pageNames.delete(pageName);
                      sessionState.targetSessions.delete(cdpSessionId);
                    }
                  }
                  targetToAgentSession.delete(cdpSessionId);
                }, 500); // 500ms grace period for reattachment

                // Store timeout WITH targetId for reattachment matching
                pendingDetach.set(cdpSessionId, { timeout: cleanupTimeout, targetId });
              } else {
                // No named page - clean up immediately
                connectedTargets.delete(cdpSessionId);
                targetToAgentSession.delete(cdpSessionId);
                log(`Target detached: ${cdpSessionId} (no named page - immediate cleanup)`);
              }
            } else if (method === "Target.targetInfoChanged") {
              const infoParams = params as { targetInfo: TargetInfo };
              let agentSession: string | undefined;

              for (const target of connectedTargets.values()) {
                if (target.targetId === infoParams.targetInfo.targetId) {
                  target.targetInfo = infoParams.targetInfo;
                  agentSession = targetToAgentSession.get(target.sessionId);
                  break;
                }
              }

              // Update persisted URL (debounced to avoid excessive writes)
              const persistedEntry = persistedPages.find(
                (p) => p.targetId === infoParams.targetInfo.targetId
              );
              if (persistedEntry) {
                persistedEntry.url = infoParams.targetInfo.url;
                persistedEntry.lastSeen = Date.now();
                debouncedSave();
              }

            } else if (method === "Page.frameNavigated") {
              // Extract URL from frameNavigated events to keep connectedTargets URL up to date
              // Chrome's extension API doesn't forward Target.targetInfoChanged, so we synthesize it
              const frameParams = params as { frame: { url: string; parentId?: string } };

              // Only update for main frame navigations (no parentId means main frame)
              if (!frameParams.frame.parentId && sessionId) {
                const target = connectedTargets.get(sessionId);
                if (target && target.targetInfo.url !== frameParams.frame.url) {
                  const oldUrl = target.targetInfo.url;
                  target.targetInfo.url = frameParams.frame.url;
                  log(`Page.frameNavigated: Updated URL for ${sessionId} from ${oldUrl} to ${frameParams.frame.url}`);

                  // Also update persisted pages
                  const pageKey = pageKeyByTargetId.get(target.targetId);
                  if (pageKey) {
                    const persistedEntry = persistedPages.find((p) => p.key === pageKey);
                    if (persistedEntry) {
                      persistedEntry.url = frameParams.frame.url;
                      persistedEntry.lastSeen = Date.now();
                      debouncedSave();
                    }
                  }
                }
              }

            } else {
              // Route Network events to HAR recorders
              if (sessionId && method.startsWith("Network.")) {
                for (const [, harState] of harRecorders) {
                  if (harState.cdpSessionId === sessionId) {
                    handleHarNetworkEvent(
                      harState,
                      method,
                      (params ?? {}) as Record<string, unknown>
                    );
                    break;
                  }
                }
              }

              // Update activity timestamp for any CDP event
              if (sessionId) {
                const target = connectedTargets.get(sessionId);
                if (target) {
                  target.lastActivity = Date.now();
                }
              }
            }
          }
        },

        onClose(_event, ws) {
          if (extensionWs && extensionWs !== ws) {
            log("Old extension connection closed");
            return;
          }

          log("Extension disconnected");

          for (const pending of extensionPendingRequests.values()) {
            pending.reject(new Error("Extension connection closed"));
          }
          extensionPendingRequests.clear();

          extensionWs = null;

          // Clear in-memory state but PRESERVE persistedPages for recovery
          connectedTargets.clear();
          namedPages.clear();
          pageKeyByTargetId.clear();
          // Cancel any pending detach timeouts
          for (const pendingInfo of pendingDetach.values()) {
            clearTimeout(pendingInfo.timeout);
          }
          pendingDetach.clear();
          sessions.clear();
          targetToAgentSession.clear();
          harRecorders.clear();
        },

        onError(event) {
          log("Extension WebSocket error:", event);
        },
      };
    })
  );

  // ============================================================================
  // Start Server
  // ============================================================================

  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  const wsEndpoint = `ws://${host}:${port}/cdp`;

  log("CDP relay server started");
  log(`  HTTP: http://${host}:${port}`);
  log(`  CDP endpoint: ${wsEndpoint}`);
  log(`  Extension endpoint: ws://${host}:${port}/extension`);
  log(`  Log file: ${logFile}`);
  log("");
  log("Waiting for extension to connect...");

  return {
    wsEndpoint,
    port,
    async stop() {
      extensionWs?.close(1000, "Server stopped");
      clearInterval(pdfCleanupInterval);
      clearInterval(idleCleanupInterval);
      server.close();
    },
  };
}
