import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { detectChallengeFromHttp, signalsFromHtml } from "../challenge.js";
import { needsBrowser } from "../fetch.js";
import { httpFetch } from "../http-fetch.js";
import { htmlTitle, htmlToText } from "../markdown.js";

describe("HTML helpers", () => {
  test("htmlToText keeps visible text and drops scripts and styles", () => {
    const html = `<head><title>T</title><style>p{}</style></head><body><script>var x</script><p>One &amp; two</p><div>Three&#33;</div></body>`;
    expect(htmlToText(html)).toBe("One & two\nThree!");
    expect(htmlTitle(html)).toBe("T");
  });

  test("signalsFromHtml finds iframes", () => {
    const s = signalsFromHtml(
      200,
      `<iframe src="https://geo.captcha-delivery.com/captcha/?x"></iframe>`
    );
    expect(s.frames).toEqual(["https://geo.captcha-delivery.com/captcha/?x"]);
  });
});

describe("detectChallengeFromHttp", () => {
  const page = `<title>Real</title>${"<p>content</p>".repeat(2000)}`;

  test("a real page is not a challenge, even with a reCAPTCHA script", () => {
    expect(
      detectChallengeFromHttp(
        200,
        {},
        `${page}<script src="https://www.google.com/recaptcha/api.js"></script>`
      )
    ).toBeNull();
  });

  test("body-only signals", () => {
    expect(
      detectChallengeFromHttp(200, {}, `<script src="https://js.datado.me/x.js"></script>`)?.vendor
    ).toBe("datadome");
    expect(
      detectChallengeFromHttp(
        429,
        {},
        `<div class="h-captcha" data-src="https://hcaptcha.com/1"></div>`
      )?.vendor
    ).toBe("hcaptcha");
    expect(detectChallengeFromHttp(403, { "cf-mitigated": "challenge" }, page)?.vendor).toBe(
      "cloudflare"
    );
  });
});

describe("httpFetch", () => {
  let site: Server;
  let origin = "";
  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } else if (req.url === "/shell") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<title>App</title><div id="root"></div><script src="/app.js"></script>');
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<title>Doc</title><h1>Heading</h1><p>${"Words here. ".repeat(30)}<a href="/x">x</a></p>`
        );
      }
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });
  afterAll(() => {
    site.close();
  });

  test("returns Markdown for HTML", async () => {
    const r = await httpFetch(`${origin}/doc`);
    expect(r).toMatchObject({ status: 200, title: "Doc", engine: "http", challenge: null });
    expect(r.content).toContain("# Heading");
    expect(r.content).toContain(`[x](${origin}/x)`);
    expect(needsBrowser(r)).toBe(false);
  });

  test("returns non-HTML bodies as they are", async () => {
    const r = await httpFetch(`${origin}/json`);
    expect(r).toMatchObject({ content: '{"ok":true}', contentType: "application/json" });
    expect(needsBrowser(r)).toBe(false);
  });

  test("flags an app shell for the browser", async () => {
    expect(needsBrowser(await httpFetch(`${origin}/shell`))).toBe(true);
  });

  test("reports connection failures", async () => {
    const r = await httpFetch("http://127.0.0.1:1/");
    expect(r.error?.kind).toBe("connection");
    expect(needsBrowser(r)).toBe(true);
  });
});
