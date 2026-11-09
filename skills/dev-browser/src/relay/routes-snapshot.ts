/**
 * Relay routes for ARIA snapshots and ref-based actions.
 */

import type { Hono } from "hono";
import { getSnapshotScript } from "../snapshot/browser-script.js";
import { getAgentSession } from "../types.js";
import type { RelayContext } from "./context.js";

export function registerSnapshotRoutes(app: Hono, ctx: RelayContext): void {
  const { live, sendToExtension, namedPages } = ctx;

  // ============================================================================
  // ARIA Snapshot & Ref-based Interaction Endpoints
  // ============================================================================

  /**
   * POST /snapshot — Get ARIA snapshot for a page.
   * Body: { page: string }
   * Response: { snapshot: string }
   */
  app.post("/snapshot", async (c) => {
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
    if (!live.extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    const agentSession = getAgentSession(c);
    const {
      page: pageName,
      action,
      ref,
      value,
    } = (await c.req.json()) as {
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
}
