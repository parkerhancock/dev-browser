import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser } from "patchright";
import {
  classifyNavigationError,
  detectChallenge,
  detectChallengeFromSignals,
  type PageSignals,
} from "../challenge.js";
import type { Page } from "../page.js";

const page = (over: Partial<PageSignals> = {}): PageSignals => ({
  status: 200,
  title: "Example",
  frames: [],
  textLength: 5000,
  htmlLength: 50000,
  ...over,
});

describe("detectChallengeFromSignals", () => {
  test("a normal page is not a challenge", () => {
    expect(detectChallengeFromSignals(page())).toBeNull();
  });

  test("Cloudflare by header or by interstitial title on a challenge status", () => {
    expect(detectChallengeFromSignals(page(), { "cf-mitigated": "challenge" })?.vendor).toBe(
      "cloudflare"
    );
    expect(
      detectChallengeFromSignals(page({ status: 403, title: "Just a moment..." }))?.vendor
    ).toBe("cloudflare");
    // The same title on a 200 is an ordinary page
    expect(detectChallengeFromSignals(page({ title: "Just a moment..." }))).toBeNull();
  });

  test("DataDome by header on a block status or by its captcha iframe", () => {
    expect(
      detectChallengeFromSignals(page({ status: 403 }), { "x-datadome": "protected" })?.vendor
    ).toBe("datadome");
    expect(detectChallengeFromSignals(page(), { "x-datadome": "protected" })).toBeNull();
    expect(
      detectChallengeFromSignals(
        page({ frames: ["https://geo.captcha-delivery.com/captcha/?x=1"] })
      )?.vendor
    ).toBe("datadome");
  });

  test("visible captcha widgets block outright", () => {
    const vendor = (src: string) => detectChallengeFromSignals(page({ frames: [src] }))?.vendor;
    expect(vendor("https://newassets.hcaptcha.com/captcha/v1/x")).toBe("hcaptcha");
    expect(vendor("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x")).toBe(
      "turnstile"
    );
    expect(vendor("https://www.google.com/recaptcha/api2/bframe?k=1")).toBe("recaptcha");
  });

  test("a reCAPTCHA anchor blocks only a page without content", () => {
    const anchor = ["https://www.google.com/recaptcha/enterprise/anchor?k=1"];
    expect(detectChallengeFromSignals(page({ frames: anchor }))).toBeNull();
    expect(detectChallengeFromSignals(page({ frames: anchor, textLength: 40 }))?.vendor).toBe(
      "recaptcha"
    );
    expect(detectChallengeFromSignals(page({ frames: anchor, status: 429 }))?.vendor).toBe(
      "recaptcha"
    );
  });

  test("a short 403 is a generic block, a long one is not", () => {
    expect(detectChallengeFromSignals(page({ status: 403, htmlLength: 800 }))?.vendor).toBe(
      "unknown"
    );
    expect(detectChallengeFromSignals(page({ status: 403 }))).toBeNull();
  });
});

describe("classifyNavigationError", () => {
  test.each([
    ["page.goto: Timeout 15000ms exceeded.", "timeout"],
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/", "dns"],
    ["Navigation failed: net::ERR_CERT_AUTHORITY_INVALID", "tls"],
    ["page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://x/", "tls"],
    ["page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1/", "connection"],
    ["page.goto: net::ERR_ABORTED", "other"],
    ["Request timeout (3000 ms) exceeded.", "timeout"],
    [
      'Failed to connect to the server.\nReason: ConnectError("tcp connect error", kind: ConnectionRefused)',
      "connection",
    ],
    ["Failed to connect to the server.\nReason: InvalidCertificate(Expired)", "tls"],
  ])("%s → %s", (message, kind) => {
    expect(classifyNavigationError(message)).toBe(kind);
  });
});

describe("detectChallenge in a browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  test("reads the status from the page and headers from the response", async () => {
    const pw = await browser.newPage();
    await pw.route("https://blocked.test/", (route) =>
      route.fulfill({
        status: 503,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        body: "<title>Just a moment...</title><p>Checking your browser</p>",
      })
    );
    const response = await pw.goto("https://blocked.test/");
    const page = pw as unknown as Page;
    expect(await detectChallenge(page)).toMatchObject({ vendor: "cloudflare", status: 503 });
    expect((await detectChallenge(page, response))?.reason).toBe("cf-mitigated: challenge");
    await pw.close();
  });
});
