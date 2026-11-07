/**
 * The HTTP tier: fetch a URL without a browser, presenting Chrome's TLS and
 * HTTP/2 fingerprint (impit). Much faster than a page load for pages that
 * don't need JavaScript, and it returns the same result shape as fetchPage.
 */

import { Impit } from "impit";
import { classifyNavigationError, detectChallengeFromHttp } from "./challenge.js";
import type { FetchPageResult } from "./fetch.js";
import { htmlTitle, htmlToText, toMarkdown } from "./markdown.js";

export interface HttpFetchOptions {
  /** Request budget in ms (default 30000). */
  timeout?: number;
  /** Proxy URL, e.g. "http://user:pass@host:8080" or "socks5://host:1080". */
  proxyUrl?: string;
  /** Content to return (default "markdown"). Non-HTML responses come back as their text. */
  format?: "markdown" | "html" | "text";
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<FetchPageResult> {
  const format = options.format ?? "markdown";
  const base = { url, format, engine: "http" as const, screenshotPath: undefined, waczPath: undefined };
  const impit = new Impit({ browser: "chrome", proxyUrl: options.proxyUrl, timeout: options.timeout ?? 30000 });

  let response;
  let body: string;
  try {
    response = await impit.fetch(url);
    body = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      finalUrl: url,
      title: "",
      challenge: null,
      error: { kind: classifyNavigationError(message), message },
      textLength: 0,
      content: "",
    };
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const contentType = headers["content-type"] ?? "";
  const isHtml = /html/i.test(contentType) || (!contentType && /^\s*</.test(body));
  const finalUrl = response.url || url;

  if (!isHtml) {
    return {
      ...base,
      finalUrl,
      title: "",
      status: response.status,
      challenge: null,
      textLength: body.length,
      content: body,
      contentType,
    };
  }

  const text = htmlToText(body);
  return {
    ...base,
    finalUrl,
    title: htmlTitle(body),
    status: response.status,
    challenge: detectChallengeFromHttp(response.status, headers, body),
    textLength: text.length,
    content: format === "html" ? body : format === "text" ? text : toMarkdown(body, finalUrl),
    contentType,
  };
}
