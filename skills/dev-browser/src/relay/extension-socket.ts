/**
 * The extension's WebSocket: connection, page recovery, and forwarded CDP events.
 */

import type { NodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import type { TargetInfo, ConnectedTarget } from "../relay-registry.js";
import type { ExtensionResponseMessage, ExtensionEventMessage, ExtensionMessage } from "./types.js";
import type { RelayContext } from "./context.js";

type UpgradeWebSocket = NodeWebSocket["upgradeWebSocket"];

export function registerExtensionSocket(app: Hono, upgradeWebSocket: UpgradeWebSocket, ctx: RelayContext): void {
  const {
    dialogPolicy,
    registry,
    childTargets,
    beforeUnloadPolicies,
    pendingTargetWaiters,
    live,
    downloads,
    DOWNLOADS_MAX,
    harRecorders,
    consoleBuffers,
    consoleEnabled,
    pushConsoleMessage,
    remoteObjectText,
    handleHarNetworkEvent,
    debouncedSave,
    extensionPendingRequests,
    removeChildTargetTree,
    recoverPersistedPages,
    sendToExtension,
    connectedTargets,
    namedPages,
    log,
  } = ctx;

  // ============================================================================
  // Extension WebSocket
  // ============================================================================

  app.get(
    "/extension",
    upgradeWebSocket(() => {
      return {
        onOpen(_event, ws) {
          if (live.extensionWs) {
            log("Closing existing extension connection");
            live.extensionWs.close(4001, "Extension Replaced");

            // Clear CDP session state but preserve namedPages/sessions for recovery
            registry.clearTargetsOnly();
            childTargets.clear();
            consoleBuffers.clear();
            consoleEnabled.clear();
            live.extensionBrowser = null; // The new connection sends its own browserInfo
            live.isRecovering = true;
            for (const pending of extensionPendingRequests.values()) {
              pending.reject(new Error("Extension reconnecting, please retry"));
            }
            extensionPendingRequests.clear();
          }

          live.extensionWs = ws;
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

          // Browser identification (sent once after connect)
          if ("method" in message && message.method === "browserInfo") {
            live.extensionBrowser = message.params;
            log(
              `Extension browser: ${live.extensionBrowser.browser}${live.extensionBrowser.version ? ` ${live.extensionBrowser.version}` : ""}`
            );
            return;
          }

          // Download lifecycle events from chrome.downloads
          if ("method" in message && message.method === "downloadEvent") {
            const p = message.params;
            const existing = downloads.get(p.id);
            const parsedStart = p.startTime ? Date.parse(p.startTime) : NaN;
            const startedAt =
              existing?.startedAt ??
              (Number.isNaN(parsedStart) ? Date.now() : parsedStart);
            downloads.set(p.id, {
              id: p.id,
              url: p.url,
              path: p.filename ?? existing?.path,
              state: p.state,
              startedAt,
              updatedAt: Date.now(),
              fileSize: p.fileSize ?? existing?.fileSize,
              mime: p.mime ?? existing?.mime,
            });
            // Cap: drop the oldest-inserted record
            if (downloads.size > DOWNLOADS_MAX) {
              const oldest = downloads.keys().next().value;
              if (oldest !== undefined) downloads.delete(oldest);
            }
            log(`Download ${p.id} ${p.state}: ${p.filename ?? p.url}`);
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

              // Page targets belong to the normal registry. OOPIF targets keep
              // their parent relationship so /cdp can enforce page ownership.
              const targetType = targetParams.targetInfo.type;
              if (targetType !== "page") {
                if (targetType === "iframe" && sessionId) {
                  childTargets.set(targetParams.sessionId, {
                    sessionId: targetParams.sessionId,
                    parentSessionId: sessionId,
                    targetInfo: targetParams.targetInfo,
                  });
                  log(`Child target attached: ${targetParams.targetInfo.url} (${targetParams.sessionId})`);
                } else {
                  log(`Ignoring non-page target: ${targetType} ${targetParams.targetInfo.url}`);
                }
                return;
              }

              const target: ConnectedTarget = {
                sessionId: targetParams.sessionId,
                targetId: targetParams.targetInfo.targetId,
                targetInfo: targetParams.targetInfo,
                lastActivity: Date.now(),
                pinned: false,
                state: "attached",
              };
              registry.addTarget(targetParams.sessionId, target);

              // Resolve any pending waiter for this targetId (from POST /pages)
              const waiter = pendingTargetWaiters.get(targetParams.targetInfo.targetId);
              if (waiter) {
                pendingTargetWaiters.delete(targetParams.targetInfo.targetId);
                waiter.resolve();
              }

              log(`Target attached: ${targetParams.targetInfo.url} (${targetParams.sessionId})`);

              // Check if this is a reattachment after cross-origin navigation
              const pageKey = registry.getPageKeyByTargetId(targetParams.targetInfo.targetId);

              // Cancel any pending detach for this targetId
              const cancelledOldSession = registry.cancelPendingDetach(targetParams.targetInfo.targetId);
              if (cancelledOldSession) {
                log(`Cancelled pending detach for ${cancelledOldSession} - target ${targetParams.targetInfo.targetId} reattached as ${targetParams.sessionId}`);
                registry.removeTarget(cancelledOldSession);
              }

              if (pageKey) {
                // Update all mappings atomically to point to the new CDP sessionId
                const oldCdpSessionId = namedPages.get(pageKey);
                if (oldCdpSessionId && oldCdpSessionId !== targetParams.sessionId) {
                  const colonIdx = pageKey.indexOf(":");
                  const owningSession = colonIdx > 0 ? pageKey.slice(0, colonIdx) : "default";
                  registry.reattachTarget(pageKey, oldCdpSessionId, targetParams.sessionId, owningSession);
                  log(`Updated mappings for ${pageKey}: ${oldCdpSessionId} -> ${targetParams.sessionId} (cross-origin navigation)`);
                }
              }

              // No need to forward to Playwright — CDPPage uses HTTP RPC
            } else if (method === "Target.detachedFromTarget") {
              const detachParams = params as { sessionId: string };
              const cdpSessionId = detachParams.sessionId;

              if (childTargets.has(cdpSessionId)) {
                removeChildTargetTree(cdpSessionId);
                childTargets.delete(cdpSessionId);
                log(`Child target detached: ${cdpSessionId}`);
                return;
              }

              removeChildTargetTree(cdpSessionId);

              // Console buffers are keyed by CDP session, which is now dead
              // (a reattachment gets a fresh sessionId and a fresh buffer)
              consoleBuffers.delete(cdpSessionId);
              consoleEnabled.delete(cdpSessionId);

              // Get target info BEFORE cleanup (needed to check for reattachment)
              const target = connectedTargets.get(cdpSessionId);
              const targetId = target?.targetId;

              // Find the owning agent session before cleanup
              const agentSession = registry.getOwner(cdpSessionId);

              // DON'T delete from connectedTargets immediately!
              // Keep it so reattachment logic can find the old session info.
              // It will be deleted either:
              // 1. In the deferred cleanup timeout (if no reattachment)
              // 2. In the reattachment handler (when new session takes over)

              // Check if this session owns a named page
              const ownedPageKey = registry.getPageKeyByCdpSession(cdpSessionId);

              // If this session owns a named page, defer cleanup to allow for reattachment
              // during cross-origin navigation (new session may attach with same targetId)
              if (ownedPageKey && targetId) {
                log(`Target detached: ${cdpSessionId} (targetId=${targetId}) - deferring cleanup for potential reattachment`);

                registry.deferDetach(cdpSessionId, targetId, () => {
                  // Check if a new session has taken over this page
                  const currentSessionId = namedPages.get(ownedPageKey!);
                  if (currentSessionId && currentSessionId !== cdpSessionId) {
                    log(`Skipping cleanup for ${cdpSessionId} - page ${ownedPageKey} now owned by ${currentSessionId}`);
                    return;
                  }

                  // No reattachment happened - do the full cleanup
                  log(`Cleanup timeout fired for ${cdpSessionId} - no reattachment, cleaning up`);
                  registry.removeNamedPage(ownedPageKey!);
                }, 500);
              } else {
                // No named page - clean up immediately
                registry.removeUnnamedTarget(cdpSessionId);
                log(`Target detached: ${cdpSessionId} (no named page - immediate cleanup)`);
              }
            } else if (method === "Target.targetInfoChanged") {
              const infoParams = params as { targetInfo: TargetInfo };
              let agentSession: string | undefined;

              for (const target of connectedTargets.values()) {
                if (target.targetId === infoParams.targetInfo.targetId) {
                  target.targetInfo = infoParams.targetInfo;
                  agentSession = registry.getOwner(target.sessionId);
                  break;
                }
              }

              // Update persisted URL (debounced to avoid excessive writes)
              const persistedEntry = live.persistedPages.find(
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
                  const pageKey = registry.getPageKeyByTargetId(target.targetId);
                  if (pageKey) {
                    const persistedEntry = live.persistedPages.find((p) => p.key === pageKey);
                    if (persistedEntry) {
                      persistedEntry.url = frameParams.frame.url;
                      persistedEntry.lastSeen = Date.now();
                      debouncedSave();
                    }
                  }
                }
              }

            } else if (method === "Page.javascriptDialogOpening") {
              // Auto-handle JS dialogs so they never wedge automation
              const dialogParams = params as { message?: string; type?: string };
              const leave =
                dialogParams.type === "beforeunload" && sessionId ? beforeUnloadPolicies.get(sessionId) : undefined;
              const pending = leave && Date.now() < leave.until ? leave : undefined;
              if (pending) pending.dialogs++;
              if ((pending || dialogPolicy !== "ignore") && sessionId) {
                const accept = pending ? pending.accept : dialogPolicy === "accept";
                log(`Auto-${accept ? "accepting" : "dismissing"} ${dialogParams.type ?? "dialog"}: ${dialogParams.message ?? ""}`);
                sendToExtension({
                  method: "forwardCDPCommand",
                  params: {
                    sessionId,
                    method: "Page.handleJavaScriptDialog",
                    params: { accept },
                  },
                  timeout: 5000,
                }).catch((err) => log(`Failed to handle JS dialog: ${err}`));
              }
            } else if (method === "Runtime.consoleAPICalled" && sessionId) {
              const consoleParams = params as {
                type: string;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                args: any[];
                timestamp: number;
              };
              pushConsoleMessage(sessionId, {
                level: consoleParams.type,
                text: (consoleParams.args ?? []).map(remoteObjectText).join(" "),
                source: "console",
                timestamp: consoleParams.timestamp ?? Date.now(),
              });
              registry.updateActivity(sessionId);
            } else if (method === "Runtime.exceptionThrown" && sessionId) {
              const exceptionParams = params as {
                timestamp: number;
                exceptionDetails: {
                  text: string;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  exception?: any;
                  url?: string;
                  lineNumber?: number;
                };
              };
              const details = exceptionParams.exceptionDetails;
              pushConsoleMessage(sessionId, {
                level: "error",
                text: details.exception?.description ?? details.text,
                source: "exception",
                timestamp: exceptionParams.timestamp ?? Date.now(),
                url: details.url,
                line: details.lineNumber,
              });
              registry.updateActivity(sessionId);
            } else if (method === "Log.entryAdded" && sessionId) {
              const logParams = params as {
                entry: {
                  source: string;
                  level: string;
                  text: string;
                  timestamp: number;
                  url?: string;
                  lineNumber?: number;
                };
              };
              pushConsoleMessage(sessionId, {
                level: logParams.entry.level,
                text: logParams.entry.text,
                source: "log",
                timestamp: logParams.entry.timestamp ?? Date.now(),
                url: logParams.entry.url,
                line: logParams.entry.lineNumber,
              });
              registry.updateActivity(sessionId);
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
                registry.updateActivity(sessionId);
              }
            }
          }
        },

        onClose(_event, ws) {
          if (live.extensionWs && live.extensionWs !== ws) {
            log("Old extension connection closed");
            return;
          }

          log("Extension disconnected");

          for (const pending of extensionPendingRequests.values()) {
            pending.reject(new Error("Extension connection closed"));
          }
          extensionPendingRequests.clear();

          live.extensionWs = null;
          live.extensionBrowser = null;

          // Clear in-memory state but PRESERVE live.persistedPages for recovery
          // (downloads metadata also survives — the files live on disk)
          registry.clear();
          childTargets.clear();
          harRecorders.clear();
          consoleBuffers.clear();
          consoleEnabled.clear();
        },

        onError(event) {
          log("Extension WebSocket error:", event);
        },
      };
    })
  );
}
