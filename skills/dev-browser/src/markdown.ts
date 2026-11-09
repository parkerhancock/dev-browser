/** HTML to Markdown and plain text, for fetch results. */

import TurndownService from "turndown";

/** Markdown with absolute links; drops scripts, styles, frames, and page chrome. */
export function toMarkdown(html: string, baseUrl: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.remove(["script", "style", "noscript", "iframe", "nav", "footer", "aside"]);
  turndown.addRule("absoluteLinks", {
    filter: "a",
    replacement: (content, node) => {
      const href = node.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return content;
      try {
        return `[${content}](${new URL(href, baseUrl).href})`;
      } catch {
        return `[${content}](${href})`;
      }
    },
  });
  return turndown.turndown(html);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Approximate visible text of an HTML document, without a browser. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n =
          code[1] === "x" || code[1] === "X"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();
}

/** The document's <title>, or "". */
export function htmlTitle(html: string): string {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return htmlToText(raw);
}
