/**
 * Helpers shared by the extension and standalone clients: server HTTP calls,
 * page text and Markdown, snapshot search, origin state, and downloads.
 */

import type { Page } from "../page.js";
import { writeFile } from "node:fs/promises";
import { authHeaders } from "../auth.js";
import TurndownService from "turndown";
import type { ConsoleMessage, DownloadRecord } from "../relay.js";
import type { HarEntry } from "../har.js";
import type {
  NetworkRequest,
  FindMatch,
  OriginState,
  ServerInfo,
  BrowserTarget,
} from "../client.js";

// ============================================================================
// Shared HTTP helpers used by both extension and standalone modes
// ============================================================================

export async function fetchServerInfo(
  serverUrl: string,
  defaultMode: "launch" | "extension"
): Promise<ServerInfo> {
  const res = await fetch(serverUrl, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}: ${await res.text()}`);
  }
  const info = (await res.json()) as {
    wsEndpoint: string;
    mode?: string;
    extensionConnected?: boolean;
  };
  return {
    wsEndpoint: info.wsEndpoint,
    mode: (info.mode as "launch" | "extension") ?? defaultMode,
    extensionConnected: info.extensionConnected,
  };
}

export async function fetchAllTargets(
  serverUrl: string,
  sessionHeaders: Record<string, string>
): Promise<BrowserTarget[]> {
  const res = await fetch(`${serverUrl}/all-targets`, {
    headers: sessionHeaders,
  });
  const data = (await res.json()) as { error?: string; targets?: BrowserTarget[] };
  if (data.error) throw new Error(data.error);
  return data.targets ?? [];
}

export async function fetchCloseTarget(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  tabId: number
): Promise<void> {
  const res = await fetch(`${serverUrl}/close-target`, {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ tabId }),
  });
  const data = (await res.json()) as { error?: string; success?: boolean };
  if (data.error) throw new Error(data.error);
}

export async function fetchCleanup(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  pattern: string
): Promise<{ closed: number; urls: string[] }> {
  const res = await fetch(`${serverUrl}/cleanup`, {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ pattern }),
  });
  const data = (await res.json()) as { error?: string; closed?: number; urls?: string[] };
  if (data.error) throw new Error(data.error);
  return { closed: data.closed ?? 0, urls: data.urls ?? [] };
}

export async function fetchPin(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  name: string,
  pinned: boolean
): Promise<void> {
  const res = await fetch(`${serverUrl}/pages/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...sessionHeaders },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) {
    throw new Error(`Failed to ${pinned ? "pin" : "unpin"} page: ${await res.text()}`);
  }
}

export async function deleteSessionPages(
  serverUrl: string,
  sessionHeaders: Record<string, string>,
  session: string
): Promise<{ closed: number; pages: string[] }> {
  const res = await fetch(`${serverUrl}/sessions/${encodeURIComponent(session)}`, {
    method: "DELETE",
    headers: sessionHeaders,
  });
  const data = (await res.json()) as { error?: string; closed?: number; pages?: string[] };
  if (data.error) throw new Error(data.error);
  return { closed: data.closed ?? 0, pages: data.pages ?? [] };
}

// ============================================================================
// Shared feature helpers (mode-agnostic, operate on Page / HAR entries)
// ============================================================================

/** document.body.innerText of a page. */
export function pageInnerText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    return (g.document?.body?.innerText as string) ?? "";
  });
}

/** Rendered DOM converted to Markdown. */
export async function pageMarkdown(page: Page): Promise<string> {
  const html = await page.content();
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.remove(["script", "style", "noscript"]);
  return turndown.turndown(html);
}

/** Filter snapshot lines for find(). */
export function findInSnapshot(snapshot: string, query: string): FindMatch[] {
  const q = query.toLowerCase();
  const matches: FindMatch[] = [];
  for (const line of snapshot.split("\n")) {
    if (line.toLowerCase().includes(q)) {
      const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
      matches.push({ ref, line: line.trim() });
      if (matches.length >= 20) break;
    }
  }
  return matches;
}

/** Fill several fields sequentially. */
export async function fillFormFields(page: Page, fields: Record<string, string>): Promise<void> {
  for (const [selector, value] of Object.entries(fields)) {
    await page.fill(selector, value);
  }
}

/** Map HAR entries to the live network-log shape, with regex URL filter. */
export function harToNetworkRequests(
  entries: HarEntry[],
  pattern?: string,
  offset = 0
): NetworkRequest[] {
  const regex = pattern ? new RegExp(pattern) : null;
  const requests: NetworkRequest[] = [];
  for (const [i, entry] of entries.entries()) {
    if (regex && !regex.test(entry.request.url)) continue;
    requests.push({
      id: offset + i,
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      statusText: entry.response.statusText,
      mimeType: entry.response.content?.mimeType,
      startedDateTime: entry.startedDateTime,
      timeMs: entry.time,
    });
  }
  return requests;
}

/** Filter console messages by regex and since-index. */
export function filterConsoleMessages(
  buffer: ConsoleMessage[],
  options?: { pattern?: string; since?: number }
): { messages: ConsoleMessage[]; total: number } {
  const since = options?.since && options.since > 0 ? Math.floor(options.since) : 0;
  let messages = buffer.slice(since);
  if (options?.pattern) {
    const regex = new RegExp(options.pattern);
    messages = messages.filter((m) => regex.test(m.text));
  }
  return { messages, total: buffer.length };
}

/** Read an origin's cookies + localStorage via a raw-CDP sender and the page. */
export async function exportOriginStateImpl(
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  page: Page,
  origin: string
): Promise<OriginState> {
  const cookieResult = (await sendCdp("Network.getCookies", {
    urls: [origin],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as { cookies: any[] };

  const localStorageData = await page.evaluate((targetOrigin: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g.location?.origin !== targetOrigin) return {};
    const out: Record<string, string> = {};
    const storage = g.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) out[key] = storage.getItem(key) ?? "";
    }
    return out;
  }, origin);

  return { origin, cookies: cookieResult.cookies ?? [], localStorage: localStorageData };
}

/** Write an origin's cookies + localStorage back. */
export async function importOriginStateImpl(
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  page: Page,
  state: OriginState
): Promise<void> {
  for (const cookie of state.cookies) {
    await sendCdp("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires,
    });
  }
  if (Object.keys(state.localStorage).length > 0) {
    // Single argument object: Playwright's evaluate only forwards one arg
    await page.evaluate(
      (arg: { targetOrigin: string; items: Record<string, string> }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = globalThis as any;
        if (g.location?.origin !== arg.targetOrigin) {
          throw new Error(
            `Page must be on ${arg.targetOrigin} to import localStorage (currently ${g.location?.origin})`
          );
        }
        for (const [key, value] of Object.entries(arg.items)) {
          g.localStorage.setItem(key, value);
        }
      },
      { targetOrigin: state.origin, items: state.localStorage }
    );
  }
}

/** Clear browsing data via raw CDP. */
/**
 * Poll a download source until a matching download completes.
 * Shared by both modes; `fetchSince` returns downloads with startedAt >= since.
 */
export async function pollForDownload(
  fetchSince: (since: number) => Promise<DownloadRecord[]>,
  options?: { since?: number; timeoutMs?: number }
): Promise<DownloadRecord> {
  // Default window reaches 60s back so the call works after the triggering click
  const since = options?.since ?? Date.now() - 60_000;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await fetchSince(since);
    const done = records.find((d) => d.state === "completed");
    if (done) return done;
    const failed = records.find((d) => d.state === "interrupted");
    if (failed) {
      throw new Error(`Download interrupted: ${failed.url}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a download after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** GET /downloads from a dev-browser server (either mode). */
export async function fetchDownloadsHttp(
  serverUrl: string,
  headers: Record<string, string>,
  since?: number
): Promise<DownloadRecord[]> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set("since", String(since));
  const res = await fetch(`${serverUrl}/downloads?${params}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get downloads: ${await res.text()}`);
  }
  const data = (await res.json()) as { downloads: DownloadRecord[] };
  return data.downloads;
}

/**
 * Stream a completed download's bytes from the server to a local file.
 * This is how downloads reach the agent when the browser runs on another
 * machine; `record.path` is a path on the server.
 */
export async function saveDownloadHttp(
  serverUrl: string,
  headers: Record<string, string>,
  id: number,
  destPath: string
): Promise<string> {
  const res = await fetch(`${serverUrl}/download/${id}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch download ${id}: ${await res.text()}`);
  }
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  return destPath;
}

export async function clearBrowsingDataImpl(
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  options?: { origin?: string }
): Promise<void> {
  if (options?.origin) {
    await sendCdp("Storage.clearDataForOrigin", {
      origin: options.origin,
      storageTypes: "cookies,local_storage,session_storage,indexeddb,cache_storage",
    });
    return;
  }
  await sendCdp("Network.clearBrowserCookies");
  await sendCdp("Network.clearBrowserCache");
}
