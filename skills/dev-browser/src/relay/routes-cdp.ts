/**
 * Relay routes for CDP over HTTP: single commands (/cdp) and batches (/batch).
 */

import type { Hono } from "hono";
import { getAgentSession } from "../types.js";
import type { RelayContext } from "./context.js";

export function registerCdpRoutes(app: Hono, ctx: RelayContext): void {
  const {
    childTargets,
    live,
    isChildOf,
    routeCdpCommand,
    policyBlocks,
    namedPages,
    log,
  } = ctx;

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
    if (!live.extensionWs) {
      return c.json({ error: { message: "Extension not connected" } }, 503);
    }

    const agentSession = getAgentSession(c);
    const body = await c.req.json();
    const { page: pageName, method, params, targetId } = body as {
      page: string;
      method: string;
      params?: Record<string, unknown>;
      targetId?: string;
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

    let routedSessionId = cdpSessionId;
    if (targetId) {
      const child = Array.from(childTargets.values()).find(
        (candidate) => candidate.targetInfo.targetId === targetId
      );
      if (!child || !isChildOf(child, cdpSessionId)) {
        return c.json(
          {
            error: {
              message: `Child target "${targetId}" is not owned by page "${pageName}"`,
            },
          },
          403
        );
      }
      routedSessionId = child.sessionId;
    }

    const blocked = policyBlocks(agentSession, method, params, routedSessionId);
    if (blocked) {
      log(`POST /cdp policy-blocked: ${method} for ${pageName}: ${blocked}`);
      return c.json({ error: { message: `Blocked by policy: ${blocked}` } }, 403);
    }

    try {
      const result = await routeCdpCommand({
        method,
        params,
        sessionId: routedSessionId,
        agentSession,
      });

      return c.json({ result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`POST /cdp error: ${method} for ${pageName}: ${msg}`);
      return c.json({ error: { message: msg } }, 500);
    }
  });

  /**
   * POST /batch — execute several CDP commands sequentially in one call.
   *
   * Body: { page: string, ops: Array<{ method: string, params?: object }> }
   * Response: { results: Array<{ result?: unknown, error?: string }>, completed: number }
   *
   * Stops on the first error (remaining ops are not executed), mirroring the
   * vendor browser_batch semantics.
   */
  app.post("/batch", async (c) => {
    if (!live.extensionWs) {
      return c.json({ error: { message: "Extension not connected" } }, 503);
    }

    const agentSession = getAgentSession(c);
    const body = await c.req.json();
    const { page: pageName, ops } = body as {
      page: string;
      ops: Array<{ method: string; params?: Record<string, unknown> }>;
    };

    if (!pageName || !Array.isArray(ops)) {
      return c.json({ error: { message: "page and ops[] are required" } }, 400);
    }

    const pageKey = `${agentSession}:${pageName}`;
    const cdpSessionId = namedPages.get(pageKey);
    if (!cdpSessionId) {
      return c.json(
        { error: { message: `Page "${pageName}" not found in session "${agentSession}"` } },
        404
      );
    }

    const results: Array<{ result?: unknown; error?: string }> = [];
    for (const op of ops) {
      if (!op?.method) {
        results.push({ error: "op.method is required" });
        break;
      }
      // Re-resolve each iteration: a navigate can swap the CDP session
      const currentSessionId = namedPages.get(pageKey) ?? cdpSessionId;
      const blocked = policyBlocks(agentSession, op.method, op.params, currentSessionId);
      if (blocked) {
        results.push({ error: `Blocked by policy: ${blocked}` });
        break;
      }
      try {
        const result = await routeCdpCommand({
          method: op.method,
          params: op.params,
          sessionId: currentSessionId,
          agentSession,
        });
        results.push({ result });
      } catch (err) {
        results.push({ error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }

    return c.json({ results, completed: results.filter((r) => !r.error).length });
  });
}
