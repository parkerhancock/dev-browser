/**
 * One-shot page fetch: open a page, load a URL, report what loaded, and return
 * its content as Markdown, HTML, or text, optionally with a screenshot and a
 * WACZ archive. Backs scripts/fetch.ts and the webfetch agent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page as PlaywrightPage } from "patchright";
import {
  detectChallengeFromSignals,
  readPageSignals,
  type Challenge,
  type NavigationErrorKind,
} from "./challenge.js";
import { navigateTo, saveWacz, type DevBrowserClient } from "./client.js";
import { toMarkdown } from "./markdown.js";
import type { Page } from "./page.js";

export interface FetchPageOptions {
  /** Overall navigation and load budget in ms (default 30000). */
  timeout?: number;
  /** Visible text below this many characters counts as not rendered yet (default 200). */
  minText?: number;
  /** How long to wait for an unrendered page to fill in, in ms (default 5000). */
  renderWait?: number;
  /** How long to let an automatic challenge (Cloudflare's "Just a moment") clear on its own, in ms (default 10000). */
  challengeWait?: number;
  /** Content to return (default "markdown"). */
  format?: "markdown" | "html" | "text";
  /** Save a full-page screenshot to this path. */
  screenshotPath?: string;
  /** Save a WACZ web archive of the page load to this path. */
  waczPath?: string;
}

export interface FetchPageResult {
  url: string;
  finalUrl: string;
  title: string;
  status?: number;
  /** A bot challenge or block page still showing when the fetch finished. */
  challenge: Challenge | null;
  /** Why navigation failed, when it did. Content is empty then. */
  error?: { kind: NavigationErrorKind; message: string };
  /** Visible text length; near zero means a block or an app shell that never rendered. */
  textLength: number;
  format: "markdown" | "html" | "text";
  content: string;
  screenshotPath?: string;
  waczPath?: string;
  /** Which tier produced the result: a browser page, or a plain HTTP request. */
  engine: "browser" | "http";
  /** The response's Content-Type, when known (HTTP tier). */
  contentType?: string;
}

/**
 * Whether an HTTP-tier result should be retried in a browser: it failed, hit
 * a challenge, or is HTML with too little text to be the rendered page.
 */
export function needsBrowser(result: FetchPageResult, minText = 200): boolean {
  if (result.error || result.challenge) return true;
  const html = !result.contentType || /html/i.test(result.contentType);
  return html && result.textLength < minText;
}

const POLL_MS = 500;

/** The page's main content element's HTML: article, main, [role=main], else body. */
const MAIN_HTML_SCRIPT = `(() => {
  for (const sel of ["article", "main", '[role="main"]']) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) return el.innerHTML;
  }
  return document.body ? document.body.innerHTML : "";
})()`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll page signals until `done` holds or `ms` passes; returns the last reading. */
async function pollSignals(
  page: Page,
  ms: number,
  done: (s: Awaited<ReturnType<typeof readPageSignals>>) => boolean
): Promise<Awaited<ReturnType<typeof readPageSignals>> | undefined> {
  const deadline = Date.now() + ms;
  let last;
  while (true) {
    try {
      last = await readPageSignals(page);
      if (done(last)) return last;
    } catch {
      // The page may be mid-navigation (a challenge redirecting); try again
    }
    if (Date.now() >= deadline) return last;
    await sleep(POLL_MS);
  }
}

/**
 * Fetch a URL with a fresh page from `client`, then close that page.
 * Navigation errors and challenges come back in the result, not as throws.
 */
export async function fetchPage(
  client: DevBrowserClient,
  url: string,
  options: FetchPageOptions = {}
): Promise<FetchPageResult> {
  const format = options.format ?? "markdown";
  const minText = options.minText ?? 200;
  const name = `fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const page = await client.page(name, { record: options.waczPath !== undefined });

  try {
    const nav = await navigateTo(page as unknown as PlaywrightPage, url, {
      timeout: options.timeout ?? 30000,
    });
    const base = { url, finalUrl: nav.url, format, status: nav.status, engine: "browser" as const };
    if (nav.error && nav.error.kind !== "timeout") {
      return { ...base, title: "", challenge: null, error: nav.error, textLength: 0, content: "" };
    }

    let challenge = nav.challenge ?? null;
    let status = nav.status;
    let textLength = nav.textLength ?? 0;
    // Let an automatic challenge finish, as a person's browser would. Interactive
    // captchas don't clear on their own and stay reported.
    if (challenge) {
      const cleared = await pollSignals(
        page,
        options.challengeWait ?? 10000,
        (s) => detectChallengeFromSignals(s) === null && s.textLength >= minText
      );
      if (cleared) {
        challenge = detectChallengeFromSignals(cleared);
        textLength = cleared.textLength;
        // The page that replaced the challenge has its own status
        if (!challenge && cleared.status) status = cleared.status;
      }
    }

    // Give a client-rendered app a moment to fill in.
    if (!challenge && textLength < minText) {
      const filled = await pollSignals(
        page,
        options.renderWait ?? 5000,
        (s) => s.textLength >= minText
      );
      textLength = filled?.textLength ?? textLength;
    }

    const html = format === "text" ? "" : await page.content();
    const content =
      format === "html"
        ? html
        : format === "text"
          ? await page.evaluate<string>("document.body ? document.body.innerText : ''")
          : toMarkdown(await page.evaluate<string>(MAIN_HTML_SCRIPT), page.url());

    let screenshotPath: string | undefined;
    if (options.screenshotPath) {
      mkdirSync(dirname(options.screenshotPath), { recursive: true });
      writeFileSync(options.screenshotPath, await page.screenshot({ fullPage: true }));
      screenshotPath = options.screenshotPath;
    }
    let waczPath: string | undefined;
    if (options.waczPath) {
      waczPath = await saveWacz(client, name, {
        outputPath: options.waczPath,
        title: await page.title(),
      });
    }

    return {
      ...base,
      status,
      finalUrl: page.url(),
      title: await page.title(),
      challenge,
      ...(nav.error ? { error: nav.error } : {}),
      textLength,
      content,
      screenshotPath,
      waczPath,
    };
  } finally {
    await client.close(name).catch(() => {});
  }
}
