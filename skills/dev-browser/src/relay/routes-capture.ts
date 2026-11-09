/**
 * Relay routes for console capture and server-side HAR recording.
 */

import type { Hono } from "hono";
import { getAgentSession } from "../types.js";
import type { RelayContext } from "./context.js";

export function registerCaptureRoutes(app: Hono, ctx: RelayContext): void {
  const { live, harRecorders, consoleBuffers, consoleEnabled, sendToExtension, namedPages, log } =
    ctx;

  // ============================================================================
  // Console Capture Endpoints
  // ============================================================================

  /**
   * POST /console/enable — enable Runtime + Log domains so console events flow.
   * Body: { page: string }. Idempotent.
   */
  app.post("/console/enable", async (c) => {
    if (!live.extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }
    const agentSession = getAgentSession(c);
    const { page: pageName } = (await c.req.json()) as { page: string };
    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);
    if (!cdpSessionId) {
      return c.json({ error: `Page "${pageName}" not found` }, 404);
    }
    if (!consoleEnabled.has(cdpSessionId)) {
      await sendToExtension({
        method: "forwardCDPCommand",
        params: { sessionId: cdpSessionId, method: "Runtime.enable", params: {} },
      });
      await sendToExtension({
        method: "forwardCDPCommand",
        params: { sessionId: cdpSessionId, method: "Log.enable", params: {} },
      });
      consoleEnabled.add(cdpSessionId);
    }
    return c.json({ success: true });
  });

  /**
   * GET /console — read buffered console messages for a page.
   * Query: page (required), pattern (optional regex), since (optional index).
   */
  app.get("/console", (c) => {
    const agentSession = getAgentSession(c);
    const pageName = c.req.query("page");
    if (!pageName) {
      return c.json({ error: "page query param required" }, 400);
    }
    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);
    if (!cdpSessionId) {
      return c.json({ error: `Page "${pageName}" not found` }, 404);
    }

    const buffer = consoleBuffers.get(cdpSessionId) ?? [];
    const sinceRaw = c.req.query("since");
    const parsed = sinceRaw ? Number(sinceRaw) : 0;
    const since = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;

    let messages = buffer.slice(since);
    const pattern = c.req.query("pattern");
    if (pattern) {
      try {
        const regex = new RegExp(pattern);
        messages = messages.filter((m) => regex.test(m.text));
      } catch {
        return c.json({ error: `Invalid pattern: ${pattern}` }, 400);
      }
    }

    return c.json({ messages, total: buffer.length });
  });

  // ============================================================================
  // Server-side HAR Recording Endpoints
  // ============================================================================

  /**
   * POST /har/start — Enable Network domain and start buffering events.
   * Body: { page: string }
   */
  app.post("/har/start", async (c) => {
    if (!live.extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const agentSession = getAgentSession(c);
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
    const agentSession = getAgentSession(c);
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
   * GET /har/entries — Peek at completed HAR entries without stopping the recorder.
   * Query: page (required), since (optional non-negative entry index, default 0).
   */
  app.get("/har/entries", (c) => {
    const agentSession = getAgentSession(c);
    const pageName = c.req.query("page");
    if (!pageName) {
      return c.json({ error: "page query param required" }, 400);
    }
    const pageKey = `${agentSession}:${pageName}`;
    const state = harRecorders.get(pageKey);

    if (!state) {
      return c.json({ error: `No HAR recording active for "${pageName}"` }, 404);
    }

    const sinceRaw = c.req.query("since");
    const parsed = sinceRaw ? Number(sinceRaw) : 0;
    const since = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;

    return c.json({
      recording: true,
      total: state.completed.length,
      entries: state.completed.slice(since),
    });
  });

  /**
   * GET /har/status — Check if HAR recording is active for a page.
   */
  app.get("/har/status", (c) => {
    const agentSession = getAgentSession(c);
    const pageName = c.req.query("page");
    if (!pageName) {
      return c.json({ error: "page query param required" }, 400);
    }
    const pageKey = `${agentSession}:${pageName}`;
    const state = harRecorders.get(pageKey);
    if (state) {
      return c.json({ recording: true, entries: state.completed.length });
    }
    return c.json({ recording: false });
  });
}
