/**
 * Relay routes for named pages: list, get or create, close, and pin.
 */

import type { Hono } from "hono";
import { savePersistedPages } from "../persistence.js";
import type { TargetInfo } from "../relay-registry.js";
import { getAgentSession, validatePageName, TAB_WARNING_THRESHOLD, TAB_LIMIT } from "../types.js";
import type { RelayContext } from "./context.js";

export function registerPageRoutes(app: Hono, ctx: RelayContext): void {
  const {
    port,
    host,
    registry,
    pendingTargetWaiters,
    live,
    debouncedSave,
    getOrCreateSession,
    sendToExtension,
    connectedTargets,
    namedPages,
    sessions,
    log,
  } = ctx;

  // List named pages (filtered by session)
  app.get("/pages", (c) => {
    const agentSession = getAgentSession(c);
    const sessionState = sessions.get(agentSession);

    if (!sessionState) {
      return c.json({ pages: [] });
    }

    // Return only this session's page names (without session prefix)
    return c.json({
      pages: Array.from(sessionState.pageNames),
    });
  });

  // Close orphaned about:blank tabs — tabs Chrome created but the relay never
  // registered (e.g. after a Target.createTarget timeout). Called fire-and-forget
  // after a createTarget failure to prevent resource exhaustion feedback loops.
  async function closeOrphanTabs(): Promise<void> {
    const result = (await sendToExtension({
      method: "getAvailableTargets",
      params: {},
    })) as { targets: Array<{ tabId: number; targetId: string; url: string }> };

    const registeredIds = new Set<string>();
    for (const [, t] of connectedTargets) {
      registeredIds.add(t.targetId);
    }

    const orphans = result.targets.filter(
      (t) => t.url === "about:blank" && !registeredIds.has(t.targetId)
    );

    for (const orphan of orphans) {
      try {
        await sendToExtension({
          method: "forwardCDPCommand",
          params: { method: "Target.closeTarget", params: { targetId: orphan.targetId } },
          timeout: 5000,
        });
      } catch {
        // Ignore individual close failures — best effort
      }
    }

    if (orphans.length > 0) {
      log(`Orphan cleanup: closed ${orphans.length} unregistered about:blank tab(s)`);
    }
  }

  // Get or create a named page (namespaced by session)
  app.post("/pages", async (c) => {
    // Block requests during extension reconnect recovery
    if (live.isRecovering) {
      return c.json({ error: "Extension reconnecting, please retry" }, 503);
    }

    const agentSession = getAgentSession(c);
    const body = await c.req.json();
    const name = body.name as string;
    const pinned = body.pinned === true; // Pinned pages are exempt from idle cleanup
    const adoptTabId = typeof body.tabId === "number" ? (body.tabId as number) : undefined;

    const nameError = validatePageName(name);
    if (nameError) return c.json({ error: nameError }, 400);

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
      const boundTabId = live.persistedPages.find((p) => p.key === pageKey)?.tabId;
      if (target && adoptTabId !== undefined && boundTabId !== adoptTabId) {
        // Explicit adoption of a different tab: drop the old binding (that tab
        // stays open, unnamed) and fall through to attach the requested tab.
        log(
          `POST /pages session=${agentSession} name=${name} action=unbind-for-adopt tabId=${adoptTabId}`
        );
        registry.removeStalePageName(pageKey, name, agentSession);
      } else if (target) {
        // Update pinned flag if explicitly set on reuse
        if (pinned && !target.pinned) {
          target.pinned = true;
          const persistedEntry = live.persistedPages.find((p) => p.key === pageKey);
          if (persistedEntry) {
            persistedEntry.pinned = true;
            debouncedSave();
          }
        }
        // Return existing page without activating (use page.bringToFront() if needed)
        log(
          `POST /pages session=${agentSession} name=${name} action=reused pinned=${target.pinned} total=${namedPages.size} sessionTotal=${sessionPageCount}`
        );
        return c.json({
          wsEndpoint: `ws://${host}:${port}/cdp`,
          name, // Return without session prefix
          targetId: target.targetId,
          url: target.targetInfo.url,
          pinned: target.pinned,
        });
      } else {
        // CDP session no longer valid, clean up
        log(`POST /pages session=${agentSession} name=${name} action=stale-cleanup`);
        registry.removeStalePageName(pageKey, name, agentSession);
      }
    }

    // Check tab limits before creating
    if (sessionPageCount >= TAB_LIMIT) {
      log(
        `POST /pages session=${agentSession} name=${name} action=rejected-limit total=${namedPages.size} sessionTotal=${sessionPageCount}`
      );
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
      log(
        `POST /pages session=${agentSession} name=${name} warning=approaching-limit sessionTotal=${sessionPageCount}`
      );
    }

    if (!live.extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    // Before creating a fresh blank tab, try to rebind to a surviving Chrome
    // tab recorded in persistence (e.g. the CDP session died or the extension
    // reconnected, but the tab itself is still open). This prevents orphan
    // tabs from accumulating and preserves the page's navigation state.
    const persistedEntry = live.persistedPages.find((p) => p.key === pageKey);
    if (persistedEntry || adoptTabId !== undefined) {
      try {
        const avail = (await sendToExtension({
          method: "getAvailableTargets",
          params: {},
        })) as { targets: Array<{ tabId: number; targetId: string; url: string }> };

        // An explicit tabId must match exactly. Otherwise match the persisted
        // tabId first, then the last-known URL (never about:blank).
        const match =
          adoptTabId !== undefined
            ? avail.targets.find((t) => t.tabId === adoptTabId)
            : (avail.targets.find((t) => t.tabId === persistedEntry!.tabId) ??
              (persistedEntry!.url && persistedEntry!.url !== "about:blank"
                ? avail.targets.find((t) => t.url === persistedEntry!.url)
                : undefined));

        if (!match && adoptTabId !== undefined) {
          return c.json({ error: `No open tab with tabId ${adoptTabId}` }, 404);
        }

        if (match) {
          const attachResult = (await sendToExtension({
            method: "attachToTab",
            params: { tabId: match.tabId },
          })) as { sessionId: string; targetInfo: TargetInfo };

          const cdpSessionId = attachResult.sessionId;
          const rebindPinned = pinned || (persistedEntry?.pinned ?? false);

          registry.addTarget(cdpSessionId, {
            sessionId: cdpSessionId,
            targetId: attachResult.targetInfo.targetId,
            targetInfo: attachResult.targetInfo,
            lastActivity: Date.now(),
            pinned: rebindPinned,
            state: "attached",
          });
          registry.nameTarget(
            pageKey,
            name,
            cdpSessionId,
            attachResult.targetInfo.targetId,
            agentSession
          );

          const entry =
            persistedEntry ??
            (() => {
              const fresh = {
                key: pageKey,
                targetId: "",
                tabId: match.tabId,
                url: "",
                lastSeen: 0,
                pinned: false,
              };
              live.persistedPages.push(fresh);
              return fresh;
            })();
          entry.targetId = attachResult.targetInfo.targetId;
          entry.tabId = match.tabId;
          entry.url = attachResult.targetInfo.url || entry.url;
          entry.pinned = rebindPinned;
          entry.lastSeen = Date.now();
          savePersistedPages(live.persistedPages);

          log(
            `POST /pages session=${agentSession} name=${name} action=${adoptTabId !== undefined ? "adopted" : "rebound"} tabId=${match.tabId} url=${entry.url} pinned=${rebindPinned}`
          );

          const response: {
            wsEndpoint: string;
            name: string;
            targetId: string;
            url: string;
            pinned: boolean;
            warning?: string;
          } = {
            wsEndpoint: `ws://${host}:${port}/cdp`,
            name,
            targetId: attachResult.targetInfo.targetId,
            url: attachResult.targetInfo.url,
            pinned: rebindPinned,
          };
          if (warning) {
            response.warning = warning;
          }
          return c.json(response);
        }
      } catch (err) {
        if (adoptTabId !== undefined) {
          log(`Adopt failed for ${pageKey} tabId=${adoptTabId}: ${err}`);
          return c.json(
            { error: `Could not attach to tab ${adoptTabId}: ${(err as Error).message}` },
            500
          );
        }
        log(`Rebind failed for ${pageKey}, falling back to new tab: ${err}`);
      }
    }

    // Create a new tab
    try {
      const result = (await sendToExtension({
        method: "forwardCDPCommand",
        params: { method: "Target.createTarget", params: { url: "about:blank" } },
        timeout: 60000,
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

          // Register with namespaced key (atomic across all Maps)
          registry.nameTarget(pageKey, name, cdpSessionId, target.targetId, agentSession);

          // Persist the page mapping
          live.persistedPages = live.persistedPages.filter((p) => p.key !== pageKey);
          live.persistedPages.push({
            key: pageKey,
            targetId: target.targetId,
            tabId: result.tabId,
            url: target.targetInfo.url,
            lastSeen: Date.now(),
            pinned,
          });
          savePersistedPages(live.persistedPages);

          log(
            `POST /pages session=${agentSession} name=${name} action=created pinned=${pinned} total=${namedPages.size} sessionTotal=${sessionState.pageNames.size}`
          );

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
      const isTimeout = (err as Error).message?.includes("timeout");
      if (isTimeout) {
        closeOrphanTabs().catch((e) => log("Orphan cleanup error:", e));
      }
      const message = isTimeout
        ? `Chrome tab creation timed out — browser may be under heavy load. ` +
          `Close unused tabs and retry. (${(err as Error).message})`
        : (err as Error).message;
      log("Error creating tab:", err);
      return c.json({ error: message }, 500);
    }
  });

  // Delete a named page (filtered by session)
  app.delete("/pages/:name", async (c) => {
    const agentSession = getAgentSession(c);
    const name = c.req.param("name");
    const pageKey = `${agentSession}:${name}`;

    const cdpSessionId = namedPages.get(pageKey);
    if (!cdpSessionId) {
      log(`DELETE /pages session=${agentSession} name=${name} action=not-found`);
      return c.json({ error: "Page not found" }, 404);
    }

    if (!live.extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const persistedEntry = live.persistedPages.find((p) => p.key === pageKey);
    if (!persistedEntry) {
      return c.json({ error: "Page tab mapping not found" }, 409);
    }

    try {
      const result = (await sendToExtension({
        method: "closeTab",
        params: { tabId: persistedEntry.tabId },
        timeout: 5000,
      })) as { success?: boolean };

      if (result.success !== true) {
        throw new Error(`Chrome did not close tab ${persistedEntry.tabId}`);
      }
    } catch (err) {
      log(`DELETE /pages session=${agentSession} name=${name} action=close-failed error=${err}`);
      return c.json({ error: String(err) }, 502);
    }

    // Clean up mappings (atomic across all Maps)
    registry.removeNamedPage(pageKey);

    // Remove from persistence
    live.persistedPages = live.persistedPages.filter((p) => p.key !== pageKey);
    savePersistedPages(live.persistedPages);

    log(
      `DELETE /pages session=${agentSession} name=${name} action=deleted total=${namedPages.size}`
    );
    return c.json({ success: true });
  });

  // Pin/unpin a page (pinned pages are exempt from idle cleanup)
  app.patch("/pages/:name", async (c) => {
    const agentSession = getAgentSession(c);
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
      // Persist so pinning survives extension reconnects and relay restarts
      const persistedEntry = live.persistedPages.find((p) => p.key === pageKey);
      if (persistedEntry) {
        persistedEntry.pinned = target.pinned;
        debouncedSave();
      }
      log(`PATCH /pages session=${agentSession} name=${name} pinned=${target.pinned}`);
    }

    return c.json({ name, pinned: target.pinned });
  });
}
