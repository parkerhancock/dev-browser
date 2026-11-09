/**
 * Relay routes for managing tabs across sessions: all targets, close, session end, and cleanup.
 */

import type { Hono } from "hono";
import { savePersistedPages } from "../persistence.js";
import type { RelayContext } from "./context.js";

export function registerTabRoutes(app: Hono, ctx: RelayContext): void {
  const {
    registry,
    live,
    sendToExtension,
    sessions,
    log,
  } = ctx;

  // ============================================================================
  // Tab Management Endpoints (bypass session isolation for management)
  // ============================================================================

  // List all browser tabs (not just session-scoped ones)
  app.get("/all-targets", async (c) => {
    if (!live.extensionWs) {
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
    if (!live.extensionWs) {
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

    if (!live.extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    // Atomically remove all pages from registry (returns info for tab closing)
    const evicted = registry.evictSession(sessionId);

    const closedPages: string[] = [];
    const errors: string[] = [];

    // Close each tab via extension
    for (const { pageName, target } of evicted) {
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
      }
    }

    // Remove persistence entries for this session
    live.persistedPages = live.persistedPages.filter((p) => !p.key.startsWith(`${sessionId}:`));
    savePersistedPages(live.persistedPages);

    log(`DELETE /sessions/${sessionId} - closed ${closedPages.length} pages: ${closedPages.join(", ")}`);
    return c.json({ closed: closedPages.length, pages: closedPages, errors: errors.length > 0 ? errors : undefined });
  });

  // Close all tabs matching a URL pattern
  app.post("/cleanup", async (c) => {
    if (!live.extensionWs) {
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
}
