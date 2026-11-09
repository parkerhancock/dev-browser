/**
 * Relay routes for status, browsers, downloads, stats, and generated PDFs.
 */

import type { Hono } from "hono";
import { unlinkSync, readFileSync } from "fs";
import { TAB_WARNING_THRESHOLD, TAB_LIMIT } from "../types.js";
import type { RelayContext } from "./context.js";

export function registerStatusRoutes(app: Hono, ctx: RelayContext): void {
  const {
    port,
    host,
    policy,
    startedAt,
    registry,
    live,
    downloads,
    pdfFiles,
    harRecorders,
    connectedTargets,
    namedPages,
    sessions,
  } = ctx;

  // Health check / server info
  app.get("/", (c) => {
    return c.json({
      wsEndpoint: `ws://${host}:${port}/cdp`,
      extensionConnected: live.extensionWs !== null,
      mode: "extension",
    });
  });

  // Health probe — richer than GET / (uptime, counts)
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      mode: "extension",
      extensionConnected: live.extensionWs !== null,
      browser: live.extensionBrowser?.browser ?? null,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      namedPages: namedPages.size,
      sessions: sessions.size,
      permissionMode: policy.defaultMode,
    });
  });

  // Which browser is connected via the extension (parity P1 #10b).
  // The relay holds one extension connection at a time, so this lists 0 or 1.
  app.get("/browsers", (c) => {
    if (!live.extensionWs) {
      return c.json({ browsers: [] });
    }
    return c.json({
      browsers: [
        {
          browser: live.extensionBrowser?.browser ?? "unknown",
          version: live.extensionBrowser?.version,
          userAgent: live.extensionBrowser?.userAgent,
          connected: true,
        },
      ],
    });
  });

  // Downloads reported by the extension (parity P1 #8)
  app.get("/downloads", (c) => {
    const sinceRaw = c.req.query("since");
    const since = sinceRaw === undefined ? NaN : parseInt(sinceRaw, 10);
    let list = Array.from(downloads.values());
    if (!Number.isNaN(since)) {
      list = list.filter((d) => d.startedAt >= since);
    }
    return c.json({ downloads: list });
  });

  // Serve a completed download's bytes. The file stays in place — it belongs
  // to the user's Downloads folder, so the relay never deletes it.
  app.get("/download/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const record = downloads.get(id);
    if (!record) {
      return c.json({ error: "Download not found" }, 404);
    }
    if (record.state !== "completed" || !record.path) {
      return c.json({ error: `Download not complete (state: ${record.state})` }, 409);
    }
    try {
      const data = readFileSync(record.path);
      const basename = record.path.split("/").pop() ?? `download-${id}`;
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": record.mime ?? "application/octet-stream",
          "Content-Disposition": `attachment; filename="${basename}"`,
        },
      });
    } catch {
      return c.json({ error: "Download file not found on disk" }, 404);
    }
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
      pageKeyByTargetId: registry.pageKeyByTargetId.size,
      detaching: registry.countDetaching(),
      connectedTargets: connectedTargets.size,
      sessions: sessions.size,
      persistedPages: live.persistedPages.length,
      extensionConnected: !!live.extensionWs,
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
}
