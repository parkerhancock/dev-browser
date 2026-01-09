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
  attached: boolean;
}

interface ConnectedTarget {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
}

interface PlaywrightClient {
  id: string;
  ws: WSContext;
  knownTargets: Set<string>; // targetIds this client has received attachedToTarget for
  session: string; // agent session for multi-agent isolation
}

// Session state for multi-agent isolation
interface SessionState {
  id: string;
  clientIds: Set<string>; // WebSocket client IDs in this session
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

// CDP message types
interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CDPResponse {
  id: number;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}

interface CDPEvent {
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

// ============================================================================
// Relay Server Implementation
// ============================================================================

export async function serveRelay(options: RelayOptions = {}): Promise<RelayServer> {
  const port = options.port ?? 9224;
  const host = options.host ?? "127.0.0.1";

  // State
  const connectedTargets = new Map<string, ConnectedTarget>();
  const namedPages = new Map<string, string>(); // "session:name" -> CDP sessionId
  const playwrightClients = new Map<string, PlaywrightClient>();
  let extensionWs: WSContext | null = null;

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

  function log(...args: unknown[]) {
    console.log("[relay]", ...args);
  }

  // Helper to get or create a session
  function getOrCreateSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        clientIds: new Set(),
        pageNames: new Set(),
        targetSessions: new Set(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  }

  // Recover persisted pages by re-attaching to existing tabs
  async function recoverPersistedPages(): Promise<void> {
    if (persistedPages.length === 0) {
      log("No persisted pages to recover");
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
          });
          namedPages.set(persisted.key, cdpSessionId);

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
  }

  function sendToPlaywright(
    message: CDPResponse | CDPEvent,
    options?: { clientId?: string; session?: string }
  ) {
    const messageStr = JSON.stringify(message);

    if (options?.clientId) {
      // Send to specific client
      const client = playwrightClients.get(options.clientId);
      if (client) {
        client.ws.send(messageStr);
      }
    } else if (options?.session) {
      // Send to all clients in this agent session
      const sessionState = sessions.get(options.session);
      if (sessionState) {
        for (const clientId of sessionState.clientIds) {
          const client = playwrightClients.get(clientId);
          client?.ws.send(messageStr);
        }
      }
    } else {
      // Broadcast to all clients
      for (const client of playwrightClients.values()) {
        client.ws.send(messageStr);
      }
    }
  }

  /**
   * Send Target.attachedToTarget event with deduplication.
   * Tracks which targets each client has seen to prevent "Duplicate target" errors.
   */
  function sendAttachedToTarget(
    target: ConnectedTarget,
    options?: { clientId?: string; session?: string },
    waitingForDebugger = false
  ) {
    const event: CDPEvent = {
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.sessionId,
        targetInfo: { ...target.targetInfo, attached: true },
        waitingForDebugger,
      },
    };
    const eventStr = JSON.stringify(event);

    if (options?.clientId) {
      const client = playwrightClients.get(options.clientId);
      if (client && !client.knownTargets.has(target.targetId)) {
        client.knownTargets.add(target.targetId);
        client.ws.send(eventStr);
      }
    } else if (options?.session) {
      // Send to all clients in this agent session that don't know about this target
      const sessionState = sessions.get(options.session);
      if (sessionState) {
        for (const clientId of sessionState.clientIds) {
          const client = playwrightClients.get(clientId);
          if (client && !client.knownTargets.has(target.targetId)) {
            client.knownTargets.add(target.targetId);
            client.ws.send(eventStr);
          }
        }
      }
    } else {
      // Broadcast to all clients that don't know about this target yet
      for (const client of playwrightClients.values()) {
        if (!client.knownTargets.has(target.targetId)) {
          client.knownTargets.add(target.targetId);
          client.ws.send(eventStr);
        }
      }
    }
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
  }: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
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

        for (const target of connectedTargets.values()) {
          if (target.targetId === targetId) {
            return { sessionId: target.sessionId };
          }
        }

        throw new Error(`Target ${targetId} not found in connected targets`);
      }

      case "Target.getTargetInfo": {
        const targetId = params?.targetId as string;

        if (targetId) {
          for (const target of connectedTargets.values()) {
            if (target.targetId === targetId) {
              return { targetInfo: target.targetInfo };
            }
          }
        }

        if (sessionId) {
          const target = connectedTargets.get(sessionId);
          if (target) {
            return { targetInfo: target.targetInfo };
          }
        }

        // Return first target if no specific one requested
        const firstTarget = Array.from(connectedTargets.values())[0];
        return { targetInfo: firstTarget?.targetInfo };
      }

      case "Target.getTargets":
        return {
          targetInfos: Array.from(connectedTargets.values()).map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        };

      case "Target.createTarget":
      case "Target.closeTarget":
        // Forward to extension
        return await sendToExtension({
          method: "forwardCDPCommand",
          params: { method, params },
        });
    }

    // Forward all other commands to extension
    return await sendToExtension({
      method: "forwardCDPCommand",
      params: { sessionId, method, params },
    });
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
    const agentSession = c.req.header("X-DevBrowser-Session") ?? "default";
    const body = await c.req.json();
    const name = body.name as string;

    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    // Internal key includes session prefix for isolation
    const pageKey = `${agentSession}:${name}`;

    // Ensure session exists
    const sessionState = getOrCreateSession(agentSession);

    // Check if page already exists for THIS session
    const existingCdpSessionId = namedPages.get(pageKey);
    if (existingCdpSessionId) {
      const target = connectedTargets.get(existingCdpSessionId);
      if (target) {
        // Activate the tab so it becomes the active tab
        await sendToExtension({
          method: "forwardCDPCommand",
          params: {
            method: "Target.activateTarget",
            params: { targetId: target.targetId },
          },
        });
        return c.json({
          wsEndpoint: `ws://${host}:${port}/cdp`,
          name, // Return without session prefix
          targetId: target.targetId,
          url: target.targetInfo.url,
        });
      }
      // CDP session no longer valid, clean up
      namedPages.delete(pageKey);
      sessionState.pageNames.delete(name);
    }

    // Create a new tab
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    try {
      const result = (await sendToExtension({
        method: "forwardCDPCommand",
        params: { method: "Target.createTarget", params: { url: "about:blank" } },
      })) as { targetId: string };

      // Wait for Target.attachedToTarget event to register the new target
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Find and name the new target
      for (const [cdpSessionId, target] of connectedTargets) {
        if (target.targetId === result.targetId) {
          // Register with namespaced key
          namedPages.set(pageKey, cdpSessionId);
          sessionState.pageNames.add(name);

          // Track reverse mapping for event routing
          targetToAgentSession.set(cdpSessionId, agentSession);
          sessionState.targetSessions.add(cdpSessionId);

          // Persist the page mapping
          persistedPages = persistedPages.filter((p) => p.key !== pageKey);
          persistedPages.push({
            key: pageKey,
            targetId: target.targetId,
            tabId: 0, // Will be updated when we get tabId from extension
            url: target.targetInfo.url,
            lastSeen: Date.now(),
          });
          savePersistedPages(persistedPages);

          // Activate the tab so it becomes the active tab
          await sendToExtension({
            method: "forwardCDPCommand",
            params: {
              method: "Target.activateTarget",
              params: { targetId: target.targetId },
            },
          });
          return c.json({
            wsEndpoint: `ws://${host}:${port}/cdp`,
            name, // Return without session prefix
            targetId: target.targetId,
            url: target.targetInfo.url,
          });
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
      return c.json({ error: "Page not found" }, 404);
    }

    // Clean up mappings
    namedPages.delete(pageKey);
    const sessionState = sessions.get(agentSession);
    if (sessionState) {
      sessionState.pageNames.delete(name);
      sessionState.targetSessions.delete(cdpSessionId);
    }
    targetToAgentSession.delete(cdpSessionId);

    // Remove from persistence
    persistedPages = persistedPages.filter((p) => p.key !== pageKey);
    savePersistedPages(persistedPages);

    return c.json({ success: true });
  });

  // ============================================================================
  // Playwright Client WebSocket
  // ============================================================================

  app.get(
    "/cdp/:session?/:clientId?",
    upgradeWebSocket((c) => {
      const clientId =
        c.req.param("clientId") || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Get agent session from URL path (preferred) or header for multi-agent isolation
      // URL path is needed because Playwright's connectOverCDP can't send custom headers
      const agentSession =
        c.req.param("session") || c.req.header("X-DevBrowser-Session") || "default";

      return {
        onOpen(_event, ws) {
          if (playwrightClients.has(clientId)) {
            log(`Rejecting duplicate client ID: ${clientId}`);
            ws.close(1000, "Client ID already connected");
            return;
          }

          // Register client with session tracking
          const sessionState = getOrCreateSession(agentSession);
          sessionState.clientIds.add(clientId);

          playwrightClients.set(clientId, {
            id: clientId,
            ws,
            knownTargets: new Set(),
            session: agentSession,
          });
          log(`Playwright client connected: ${clientId} (session: ${agentSession})`);
        },

        async onMessage(event, _ws) {
          let message: CDPCommand;

          try {
            message = JSON.parse(event.data.toString());
          } catch {
            return;
          }

          const { id, sessionId, method, params } = message;

          if (!extensionWs) {
            sendToPlaywright(
              {
                id,
                sessionId,
                error: { message: "Extension not connected" },
              },
              { clientId }
            );
            return;
          }

          try {
            const result = await routeCdpCommand({ method, params, sessionId });

            // After Target.setAutoAttach, send attachedToTarget for existing targets
            // Uses deduplication to prevent "Duplicate target" errors
            if (method === "Target.setAutoAttach" && !sessionId) {
              for (const target of connectedTargets.values()) {
                sendAttachedToTarget(target, { clientId });
              }
            }

            // After Target.setDiscoverTargets, send targetCreated events
            if (
              method === "Target.setDiscoverTargets" &&
              (params as { discover?: boolean })?.discover
            ) {
              for (const target of connectedTargets.values()) {
                sendToPlaywright(
                  {
                    method: "Target.targetCreated",
                    params: {
                      targetInfo: { ...target.targetInfo, attached: true },
                    },
                  },
                  { clientId }
                );
              }
            }

            // After Target.attachToTarget, send attachedToTarget event (with deduplication)
            if (
              method === "Target.attachToTarget" &&
              (result as { sessionId?: string })?.sessionId
            ) {
              const targetId = params?.targetId as string;
              const target = Array.from(connectedTargets.values()).find(
                (t) => t.targetId === targetId
              );
              if (target) {
                sendAttachedToTarget(target, { clientId });
              }
            }

            sendToPlaywright({ id, sessionId, result }, { clientId });
          } catch (e) {
            log("Error handling CDP command:", method, e);
            sendToPlaywright(
              {
                id,
                sessionId,
                error: { message: (e as Error).message },
              },
              { clientId }
            );
          }
        },

        onClose() {
          const client = playwrightClients.get(clientId);
          if (client) {
            // Remove client from session
            const sessionState = sessions.get(client.session);
            sessionState?.clientIds.delete(clientId);
          }
          playwrightClients.delete(clientId);
          log(`Playwright client disconnected: ${clientId}`);
        },

        onError(event) {
          log(`Playwright WebSocket error [${clientId}]:`, event);
        },
      };
    })
  );

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

            // Clear in-memory state (but NOT persistedPages)
            connectedTargets.clear();
            namedPages.clear();
            sessions.clear();
            targetToAgentSession.clear();
            for (const pending of extensionPendingRequests.values()) {
              pending.reject(new Error("Extension connection replaced"));
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

              const target: ConnectedTarget = {
                sessionId: targetParams.sessionId,
                targetId: targetParams.targetInfo.targetId,
                targetInfo: targetParams.targetInfo,
              };
              connectedTargets.set(targetParams.sessionId, target);

              log(`Target attached: ${targetParams.targetInfo.url} (${targetParams.sessionId})`);

              // Route to session that owns this target, or broadcast if unknown
              const agentSession = targetToAgentSession.get(targetParams.sessionId);
              if (agentSession) {
                sendAttachedToTarget(target, { session: agentSession });
              } else {
                // Target not yet claimed by any session - broadcast to all
                sendAttachedToTarget(target);
              }
            } else if (method === "Target.detachedFromTarget") {
              const detachParams = params as { sessionId: string };
              const cdpSessionId = detachParams.sessionId;

              // Find the owning agent session before cleanup
              const agentSession = targetToAgentSession.get(cdpSessionId);

              connectedTargets.delete(cdpSessionId);

              // Clean up name mappings and session state
              for (const [pageKey, sid] of namedPages) {
                if (sid === cdpSessionId) {
                  namedPages.delete(pageKey);
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
                  break;
                }
              }
              targetToAgentSession.delete(cdpSessionId);

              log(`Target detached: ${cdpSessionId}`);

              // Route to owning session, or broadcast if unknown
              if (agentSession) {
                sendToPlaywright(
                  { method: "Target.detachedFromTarget", params: detachParams },
                  { session: agentSession }
                );
              } else {
                sendToPlaywright({
                  method: "Target.detachedFromTarget",
                  params: detachParams,
                });
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

              // Route to owning session, or broadcast if unknown
              if (agentSession) {
                sendToPlaywright(
                  { method: "Target.targetInfoChanged", params: infoParams },
                  { session: agentSession }
                );
              } else {
                sendToPlaywright({
                  method: "Target.targetInfoChanged",
                  params: infoParams,
                });
              }
            } else {
              // Forward other CDP events to Playwright
              // Route to owning session based on CDP sessionId
              const agentSession = sessionId
                ? targetToAgentSession.get(sessionId)
                : undefined;

              if (agentSession) {
                sendToPlaywright({ sessionId, method, params }, { session: agentSession });
              } else {
                // Unknown session - broadcast to all
                sendToPlaywright({ sessionId, method, params });
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
          sessions.clear();
          targetToAgentSession.clear();

          // Close all Playwright clients (they'll need to reconnect)
          for (const client of playwrightClients.values()) {
            client.ws.close(1000, "Extension disconnected");
          }
          playwrightClients.clear();
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
  log("");
  log("Waiting for extension to connect...");

  return {
    wsEndpoint,
    port,
    async stop() {
      for (const client of playwrightClients.values()) {
        client.ws.close(1000, "Server stopped");
      }
      playwrightClients.clear();
      extensionWs?.close(1000, "Server stopped");
      server.close();
    },
  };
}
