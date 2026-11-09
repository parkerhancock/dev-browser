/**
 * The relay's shared state and core helpers: the target registry, the
 * extension connection and its request queue, CDP command routing,
 * page-mapping recovery, idle cleanup, HAR and console buffers, and policy
 * checks. Route modules receive this context instead of sharing a closure.
 */

import type { WSContext } from "hono/ws";
import {
  loadPersistedPages,
  savePersistedPages,
  createDebouncedSave,
  type PersistedPage,
} from "../persistence.js";
import { createLogger } from "../logging.js";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { type HarEntry, type PendingHarEntry, processNetworkEvent } from "../har.js";
import { createTargetRegistry, type TargetInfo } from "../relay-registry.js";
import { loadOrCreateToken } from "../auth.js";
import { loadPolicy, checkNavigation, checkCdpMethod } from "../policy.js";
import type {
  DialogPolicy,
  RelayOptions,
  DownloadRecord,
  ExtensionBrowserInfo,
  ConsoleMessage,
  ChildTarget,
} from "./types.js";

export function createRelayContext(options: RelayOptions) {
  const port = options.port ?? 9224;
  const host = options.host ?? "127.0.0.1";
  const requireAuth = options.requireAuth ?? true;
  const token = options.token ?? (requireAuth ? loadOrCreateToken() : "");
  const policy = options.policy ?? loadPolicy();
  const dialogPolicy: DialogPolicy =
    options.dialogPolicy ??
    (process.env.DEV_BROWSER_DIALOG_POLICY as DialogPolicy | undefined) ??
    "dismiss";
  const startedAt = Date.now();

  // State — all page/session/target tracking is in the registry
  const registry = createTargetRegistry();
  // Read-only Map references for lookups (mutations go through registry methods)
  const { targets: connectedTargets, namedPages, sessions } = registry;
  const childTargets = new Map<string, ChildTarget>();
  /**
   * Per-session handling for the next "Leave site?" (beforeunload) dialogs,
   * set by DevBrowser.setBeforeUnloadPolicy around a navigation. Without an
   * entry, beforeunload follows the dialog policy like any other dialog.
   */
  const beforeUnloadPolicies = new Map<
    string,
    { accept: boolean; until: number; dialogs: number }
  >();
  // Waiters for target attachment (event-driven replacement for sleep after createTarget)
  const pendingTargetWaiters = new Map<string, { resolve: () => void }>();
  // State that changes over the relay's life, shared with every route module
  const live: {
    extensionWs: WSContext | null;
    isRecovering: boolean; // True during extension reconnect recovery
    extensionBrowser: ExtensionBrowserInfo | null;
    persistedPages: PersistedPage[];
    extensionMessageId: number;
  } = {
    extensionWs: null,
    isRecovering: false,
    extensionBrowser: null,
    persistedPages: [],
    extensionMessageId: 0,
  };
  // Which browser the connected extension runs in (parity P1 #10b)
  // Downloads reported by the extension, newest-insertion-last (parity P1 #8).
  // Metadata survives extension reconnects — the files live on disk regardless.
  const downloads = new Map<number, DownloadRecord>();
  const DOWNLOADS_MAX = 100;

  // Logging
  const { log, logFile } = createLogger("relay", { stdout: true });

  // Idle timeout: close ANONYMOUS targets (tabs with no named page) after
  // 60 seconds of no CDP activity. Named pages are never idle-closed — the
  // tool's core promise is that a named page survives between script runs,
  // and named tabs are already capped by the per-session TAB_LIMIT and
  // cleaned up explicitly (close/closeAll/session end). Override via
  // DEV_BROWSER_IDLE_TIMEOUT_MS env var.
  const IDLE_TIMEOUT_MS = parseInt(process.env.DEV_BROWSER_IDLE_TIMEOUT_MS ?? "", 10) || 60 * 1000;
  // Check every 5 seconds (or faster when the timeout itself is shorter, e.g. in tests)
  const IDLE_CHECK_INTERVAL_MS = Math.min(5 * 1000, IDLE_TIMEOUT_MS);

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

  interface RelayHarState {
    cdpSessionId: string;
    pending: Map<string, PendingHarEntry>;
    completed: HarEntry[];
  }

  const harRecorders = new Map<string, RelayHarState>(); // pageKey -> state

  // ---- Server-side console capture ----
  // Buffers console events per CDP session. Events only flow once the
  // Runtime/Log domains are enabled (POST /console/enable does that); the
  // buffer survives across client connections like the HAR recorders do.
  const CONSOLE_BUFFER_MAX = 1000;
  const consoleBuffers = new Map<string, ConsoleMessage[]>(); // cdpSessionId -> messages
  const consoleEnabled = new Set<string>(); // cdpSessionIds with Runtime/Log enabled

  function pushConsoleMessage(cdpSessionId: string, msg: ConsoleMessage): void {
    let buffer = consoleBuffers.get(cdpSessionId);
    if (!buffer) {
      buffer = [];
      consoleBuffers.set(cdpSessionId, buffer);
    }
    buffer.push(msg);
    if (buffer.length > CONSOLE_BUFFER_MAX) {
      buffer.splice(0, buffer.length - CONSOLE_BUFFER_MAX);
    }
  }

  /** Format a CDP RemoteObject into readable text. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function remoteObjectText(obj: any): string {
    if (obj == null) return "";
    if (obj.value !== undefined) {
      return typeof obj.value === "string" ? obj.value : JSON.stringify(obj.value);
    }
    return obj.description ?? obj.unserializableValue ?? `[${obj.type}]`;
  }

  /** Handle a CDP Network event for HAR recording */
  function handleHarNetworkEvent(
    state: RelayHarState,
    method: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: Record<string, any>
  ): void {
    processNetworkEvent(state.pending, state.completed, method, params, async (requestId) => {
      const result = await sendToExtension({
        method: "forwardCDPCommand",
        params: {
          sessionId: state.cdpSessionId,
          method: "Network.getResponseBody",
          params: { requestId },
        },
      });
      return result as { body?: string; base64Encoded?: boolean } | null;
    });
  }

  // Idle page cleanup — close ANONYMOUS targets with no activity.
  // Named pages are never idle-closed (see IDLE_TIMEOUT_MS comment above);
  // pinned targets are also exempt (human collaboration).
  async function cleanupIdlePages(): Promise<void> {
    const now = Date.now();
    const idleThreshold = now - IDLE_TIMEOUT_MS;

    for (const [cdpSessionId, target] of connectedTargets) {
      if (target.pinned) continue; // Pinned pages are exempt (human collaboration)
      if (registry.getPageKeyByTargetId(target.targetId)) continue; // Named pages are exempt
      if (target.lastActivity < idleThreshold) {
        log(
          `Idle timeout: closing anonymous target ${target.targetId} (inactive for ${Math.round((now - target.lastActivity) / 1000)}s)`
        );

        // Close the tab via extension
        if (live.extensionWs) {
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

        // Clean up mapping (the Target.detachedFromTarget event will also fire)
        registry.removeUnnamedTarget(cdpSessionId);
      }
    }
  }

  const idleCleanupInterval = setInterval(cleanupIdlePages, IDLE_CHECK_INTERVAL_MS);

  // Persistence for page mappings (survives extension disconnects)
  live.persistedPages = loadPersistedPages();
  log(`Loaded ${live.persistedPages.length} persisted page mappings`);
  const debouncedSave = createDebouncedSave(() => live.persistedPages);

  // Pending requests to extension
  const extensionPendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  // ============================================================================
  // Helper Functions
  // ============================================================================

  // Aliases for registry helpers (used throughout the code)
  const getOrCreateSession = registry.getOrCreateSession;
  const isTargetOwnedBySession = registry.isOwnedBySession;
  const getSessionTargets = registry.getSessionTargetIds;

  function isChildOf(child: ChildTarget, rootSessionId: string): boolean {
    let current: ChildTarget | undefined = child;
    const visited = new Set<string>();
    while (current && !visited.has(current.sessionId)) {
      if (current.parentSessionId === rootSessionId) return true;
      visited.add(current.sessionId);
      current = childTargets.get(current.parentSessionId);
    }
    return false;
  }

  function removeChildTargetTree(parentSessionId: string): void {
    for (const child of Array.from(childTargets.values())) {
      if (child.parentSessionId === parentSessionId) {
        removeChildTargetTree(child.sessionId);
        childTargets.delete(child.sessionId);
      }
    }
  }

  // Recover persisted pages by re-attaching to existing tabs
  async function recoverPersistedPages(): Promise<void> {
    if (live.persistedPages.length === 0) {
      log("No persisted pages to recover");
      live.isRecovering = false;
      return;
    }

    log(`Attempting to recover ${live.persistedPages.length} persisted pages...`);

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
      live.isRecovering = false;
      return;
    }

    log(`Found ${availableTargets.length} available targets`);

    // Build lookups for matching. tabId is the reliable key — Chrome tab IDs
    // are stable across debugger detach/reattach and relay restarts (the
    // extension's getAvailableTargets only reports placeholder targetIds).
    // URL is the fallback, but never match on about:blank — any blank tab
    // would bind, which is exactly the rebind-to-blank bug.
    const targetsByTabId = new Map<number, (typeof availableTargets)[0]>();
    const targetsByUrl = new Map<string, (typeof availableTargets)[0]>();
    for (const target of availableTargets) {
      targetsByTabId.set(target.tabId, target);
      targetsByUrl.set(target.url, target);
    }

    const recovered: string[] = [];
    const stale: string[] = [];

    for (const persisted of live.persistedPages) {
      // Match by tabId first, then by last-known URL
      const matchingTarget =
        targetsByTabId.get(persisted.tabId) ??
        (persisted.url && persisted.url !== "about:blank"
          ? targetsByUrl.get(persisted.url)
          : undefined);

      if (matchingTarget) {
        try {
          // Ask extension to attach debugger to this tab
          const attachResult = (await sendToExtension({
            method: "attachToTab",
            params: { tabId: matchingTarget.tabId },
          })) as { sessionId: string; targetInfo: TargetInfo };

          const cdpSessionId = attachResult.sessionId;

          // Rebuild in-memory mappings (preserve the persisted pinned flag)
          registry.addTarget(cdpSessionId, {
            sessionId: cdpSessionId,
            targetId: attachResult.targetInfo.targetId,
            targetInfo: attachResult.targetInfo,
            lastActivity: Date.now(),
            pinned: persisted.pinned ?? false,
            state: "attached",
          });

          // Parse session and page name from key
          const colonIdx = persisted.key.indexOf(":");
          const agentSession = persisted.key.slice(0, colonIdx);
          const pageName = persisted.key.slice(colonIdx + 1);

          registry.nameTarget(
            persisted.key,
            pageName,
            cdpSessionId,
            attachResult.targetInfo.targetId,
            agentSession
          );

          // Update persisted entry with new targetId and current URL
          persisted.targetId = attachResult.targetInfo.targetId;
          persisted.tabId = matchingTarget.tabId;
          persisted.url = attachResult.targetInfo.url || persisted.url;
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
      live.persistedPages = live.persistedPages.filter((p) => !stale.includes(p.key));
      savePersistedPages(live.persistedPages);
    } else if (recovered.length > 0) {
      // Save updated entries
      savePersistedPages(live.persistedPages);
    }

    log(`Recovery complete: ${recovered.length} recovered, ${stale.length} stale`);
    live.isRecovering = false;
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
    if (!live.extensionWs) {
      throw new Error("Extension not connected");
    }

    const id = ++live.extensionMessageId;
    const message = { id, method, params };

    live.extensionWs.send(JSON.stringify(message));

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

      case "DevBrowser.setBeforeUnloadPolicy": {
        // Accept or dismiss "Leave site?" dialogs for the next 30 s
        if (!sessionId) return {};
        beforeUnloadPolicies.set(sessionId, {
          accept: params?.accept === true,
          until: Date.now() + 30000,
          dialogs: 0,
        });
        return {};
      }

      case "DevBrowser.takeBeforeUnloadDialogs": {
        // How many "Leave site?" dialogs appeared since setBeforeUnloadPolicy; clears the policy
        if (!sessionId) return { dialogs: 0 };
        const entry = beforeUnloadPolicies.get(sessionId);
        beforeUnloadPolicies.delete(sessionId);
        return { dialogs: entry?.dialogs ?? 0 };
      }

      case "DevBrowser.getChildTargets": {
        if (!sessionId) return { targetInfos: [] };
        return {
          targetInfos: Array.from(childTargets.values())
            .filter((child) => isChildOf(child, sessionId))
            .map((child) => child.targetInfo),
        };
      }

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
            const owner = registry.getOwner(cdpSessionId);
            // Allow if owned by this session OR unclaimed (for new page creation)
            if (!owner || owner === agentSession) {
              // Claim unclaimed targets
              if (!owner) {
                registry.claimTarget(cdpSessionId, agentSession);
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
              const owner = registry.getOwner(cdpSessionId);
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
            const owner = registry.getOwner(sessionId);
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
      registry.updateActivity(sessionId);
    }

    return result;
  }

  function originOfSession(cdpSessionId: string): string | undefined {
    const target = connectedTargets.get(cdpSessionId);
    if (!target) return undefined;
    try {
      return new URL(target.targetInfo.url).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * Policy gate for a CDP command about to be routed for an agent session.
   * Returns an error string when blocked, null when allowed.
   */
  function policyBlocks(
    agentSession: string,
    method: string,
    params: Record<string, unknown> | undefined,
    cdpSessionId: string | undefined
  ): string | null {
    if (method === "Page.navigate") {
      const url = String(params?.url ?? "");
      const nav = checkNavigation(policy, agentSession, url);
      if (!nav.allowed) return nav.reason ?? "navigation blocked by policy";
      return null;
    }
    const origin = cdpSessionId ? originOfSession(cdpSessionId) : undefined;
    const decision = checkCdpMethod(policy, agentSession, method, origin);
    if (!decision.allowed) return decision.reason ?? "CDP method blocked by policy";
    return null;
  }

  return {
    port,
    host,
    requireAuth,
    token,
    policy,
    dialogPolicy,
    startedAt,
    registry,
    childTargets,
    beforeUnloadPolicies,
    pendingTargetWaiters,
    live,
    downloads,
    DOWNLOADS_MAX,
    IDLE_TIMEOUT_MS,
    IDLE_CHECK_INTERVAL_MS,
    pdfDir,
    pdfFiles,
    PDF_MAX_AGE_MS,
    cleanupOldPdfs,
    pdfCleanupInterval,
    harRecorders,
    CONSOLE_BUFFER_MAX,
    consoleBuffers,
    consoleEnabled,
    pushConsoleMessage,
    remoteObjectText,
    handleHarNetworkEvent,
    cleanupIdlePages,
    idleCleanupInterval,
    debouncedSave,
    extensionPendingRequests,
    getOrCreateSession,
    isTargetOwnedBySession,
    getSessionTargets,
    isChildOf,
    removeChildTargetTree,
    recoverPersistedPages,
    sendToExtension,
    routeCdpCommand,
    originOfSession,
    policyBlocks,
    connectedTargets,
    namedPages,
    sessions,
    log,
    logFile,
    options,
  };
}

export type RelayContext = ReturnType<typeof createRelayContext>;
