/**
 * Relay routes for managing tabs across sessions: all targets, close, session end, and cleanup.
 */

import type { Hono } from "hono";
import { cleanGroupTitle } from "../types.js";
import type { RelayContext } from "./context.js";

export function registerTabRoutes(app: Hono, ctx: RelayContext): void {
  const { live, sendToExtension, sessions, getOrCreateSession, endSession, log } = ctx;

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

  // End a session: close its pages (client closeAll, and the plugin's
  // SessionEnd hook). ?releasePinned=1 leaves pinned tabs open for the person.
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

    const releasePinned = c.req.query("releasePinned") === "1";
    const { closed, released, errors } = await endSession(sessionId, { releasePinned });

    log(
      `DELETE /sessions/${sessionId} - closed ${closed.length} pages: ${closed.join(", ")}` +
        (released.length > 0 ? `; released ${released.join(", ")}` : "")
    );
    return c.json({
      closed: closed.length,
      pages: closed,
      released: released.length > 0 ? released : undefined,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  // Name (or rename) a session's tab group. New tabs take the name; an
  // existing group is renamed in place.
  app.put("/sessions/:sessionId/group", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" ? cleanGroupTitle(body.title) : undefined;
    if (!title) return c.json({ error: "title must be a non-empty string" }, 400);

    const sessionState = getOrCreateSession(sessionId);
    sessionState.groupName = title;

    if (live.extensionWs && sessionState.pageNames.size > 0) {
      try {
        await sendToExtension({
          method: "renameGroup",
          params: { key: sessionId, title },
          timeout: 5000,
        });
      } catch (err) {
        log(`Failed to rename tab group for ${sessionId}: ${err}`);
      }
    }

    log(`PUT /sessions/${sessionId}/group - ${title}`);
    return c.json({ title });
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
