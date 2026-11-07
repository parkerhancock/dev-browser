/**
 * Bot-challenge detection and navigation error classification.
 *
 * Ported from stealth-browser's detect.py. The rules are conservative: missing
 * a challenge is acceptable, flagging a readable page is not. Detection reads
 * page signals with one evaluate (the DOM and the navigation timing entry), so
 * it works in both modes. Response headers sharpen it when the caller has
 * them; extension-mode goto() returns no response, so there it runs without.
 */

import type { Page } from "./page.js";

export type ChallengeVendor =
  | "cloudflare"
  | "datadome"
  | "hcaptcha"
  | "turnstile"
  | "recaptcha"
  | "unknown";

export interface Challenge {
  vendor: ChallengeVendor;
  /** What matched, for logs and error messages. */
  reason: string;
  /** HTTP status of the main document, when known. */
  status?: number;
}

/** What detection reads from the page. */
export interface PageSignals {
  /** Main document HTTP status from the navigation timing entry (0 if unknown). */
  status: number;
  title: string;
  /** iframe src URLs. */
  frames: string[];
  /** Length of the body's visible text, trimmed. */
  textLength: number;
  /** Length of the serialized document. */
  htmlLength: number;
}

/** Statuses challenge pages are served with. */
const BLOCK_STATUSES = new Set([403, 429, 503]);

const SIGNALS_SCRIPT = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    status: (nav && nav.responseStatus) || 0,
    title: document.title || "",
    frames: Array.from(document.querySelectorAll("iframe"), (f) => f.src || "").filter(Boolean).slice(0, 100),
    textLength: ((document.body && document.body.innerText) || "").trim().length,
    htmlLength: document.documentElement ? document.documentElement.outerHTML.length : 0,
  };
})()`;

export async function readPageSignals(page: Page): Promise<PageSignals> {
  return page.evaluate<PageSignals>(SIGNALS_SCRIPT);
}

/** The first iframe src containing any needle, without its query string. */
const frameMatch = (frames: string[], ...needles: string[]): string | undefined => {
  const src = frames.find((f) => needles.some((n) => f.includes(n)));
  return src?.split(/[?#]/)[0];
};

/**
 * Decide whether page signals describe a challenge or block page.
 * `headers` are the main document's response headers, lowercased, if known.
 */
export function detectChallengeFromSignals(
  signals: PageSignals,
  headers: Record<string, string> = {}
): Challenge | null {
  const status = signals.status || undefined;
  const blockStatus = status !== undefined && BLOCK_STATUSES.has(status);
  const found = (vendor: ChallengeVendor, reason: string): Challenge => ({ vendor, reason, status });

  // Cloudflare: the cf-mitigated header is definitive; the interstitial title
  // counts only on a challenge status.
  if (headers["cf-mitigated"] === "challenge") return found("cloudflare", "cf-mitigated: challenge");
  if ((status === 403 || status === 503) && /just a moment|attention required/i.test(signals.title)) {
    return found("cloudflare", `challenge page title "${signals.title}"`);
  }

  // DataDome: its header on a block status, or its captcha iframe.
  if (Object.keys(headers).some((k) => k.startsWith("x-datadome")) && (status === 403 || status === 429)) {
    return found("datadome", "x-datadome header on a block status");
  }
  const dd = frameMatch(signals.frames, "captcha-delivery.com", "datadome");
  if (dd) return found("datadome", `captcha iframe ${dd}`);

  // Visible challenge widgets block outright.
  const visible: [ChallengeVendor, string[]][] = [
    ["hcaptcha", ["hcaptcha.com"]],
    ["turnstile", ["challenges.cloudflare.com"]],
    ["recaptcha", ["recaptcha/api2/bframe", "recaptcha/enterprise/bframe"]],
  ];
  for (const [vendor, needles] of visible) {
    const src = frameMatch(signals.frames, ...needles);
    if (src) return found(vendor, `challenge iframe ${src}`);
  }

  // A bare reCAPTCHA anchor is on many normal pages (invisible v3 scoring).
  // It blocks only when there's no real content behind it.
  const anchor = frameMatch(signals.frames, "recaptcha/api2/anchor", "recaptcha/enterprise/anchor");
  if (anchor && (blockStatus || signals.textLength < 500)) {
    return found("recaptcha", "reCAPTCHA gating a page with no content");
  }

  // A short 403 is a block page, not a real error page with content.
  if (status === 403 && signals.htmlLength < 5000) return found("unknown", "HTTP 403 with a short body");

  return null;
}

/** Minimal shape of a Playwright Response. */
interface ResponseLike {
  headers(): Record<string, string>;
}

/**
 * Check the current page for a bot challenge. Pass the navigation response
 * when you have one (standalone goto() returns it) for header-based checks.
 */
export async function detectChallenge(
  page: Page,
  response?: ResponseLike | null
): Promise<Challenge | null> {
  const signals = await readPageSignals(page);
  return detectChallengeFromSignals(signals, response?.headers() ?? {});
}

export type NavigationErrorKind = "timeout" | "dns" | "tls" | "connection" | "other";

/** Classify a navigation error message from Playwright or CDP. */
export function classifyNavigationError(message: string): NavigationErrorKind {
  const msg = message.toLowerCase();
  if (/timeout \d+ms exceeded|timed out after/.test(msg)) return "timeout";
  if (/err_name_not_resolved|err_name_resolution_failed|getaddrinfo|enotfound/.test(msg)) return "dns";
  if (/err_cert_|err_ssl_|ssl_protocol|certificate/.test(msg)) return "tls";
  if (
    /err_connection_|err_address_unreachable|err_internet_disconnected|err_empty_response|err_timed_out|econnrefused|econnreset/.test(
      msg
    )
  ) {
    return "connection";
  }
  return "other";
}
