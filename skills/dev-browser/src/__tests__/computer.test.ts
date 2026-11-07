/**
 * Runs every computer action in real Chromium through both Page
 * implementations: Playwright's Page (standalone) and CDPPage (extension),
 * whose relay RPC is routed straight to a CDP session on the same browser.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { chromium } from "patchright";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  Page as PwPage,
} from "patchright";
import { CDPPage } from "../cdp-page.js";
import { computerAction, normalizeKeyCombo, type CdpSend } from "../computer.js";
import type { Page } from "../page.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;

const RELAY_URL = "http://relay.test:9224";

const FIXTURE = `<!doctype html>
<style>
  html, body { margin: 0; }
  #red { position: absolute; left: 0; top: 0; width: 100px; height: 100px; background: #f00; }
  #blue { position: absolute; left: 0; top: 1000px; width: 100px; height: 100px; background: #00f; }
  #btn { position: absolute; left: 200px; top: 20px; width: 100px; height: 40px; }
  #hov { position: absolute; left: 320px; top: 20px; width: 60px; height: 40px; }
  #area { position: absolute; left: 200px; top: 80px; width: 300px; height: 60px; }
  #para { position: absolute; left: 200px; top: 160px; width: 300px; margin: 0; }
  #track { position: absolute; left: 200px; top: 220px; width: 300px; height: 40px; background: #ddd; }
  #far { position: absolute; left: 20px; top: 2000px; width: 80px; height: 30px; }
  #spacer { position: absolute; top: 3000px; width: 2000px; height: 1px; }
</style>
<div id="red"></div><div id="blue"></div>
<button id="btn">Go</button><div id="hov">hover</div>
<textarea id="area"></textarea>
<p id="para">one two three</p>
<div id="track"></div>
<button id="far">Far</button><div id="spacer"></div>
<script>
  window.log = [];
  const rec = (e) => window.log.push({
    type: e.type, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons,
    detail: e.detail, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
    target: e.target.id,
  });
  for (const t of ["click", "dblclick", "contextmenu", "mouseover"]) document.addEventListener(t, rec);
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  window.drag = [];
  const track = document.getElementById("track");
  track.addEventListener("mousedown", (e) => {
    const move = (m) => window.drag.push({ x: m.clientX, buttons: m.buttons });
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", () => document.removeEventListener("mousemove", move), { once: true });
  });
</script>`;

/** Serve the relay's /cdp endpoint from a real CDP session. */
function routeRelayToCdp(session: CDPSession): void {
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    if (!String(url).endsWith("/cdp")) throw new Error(`Unexpected relay call: ${url}`);
    const { method, params } = JSON.parse(init.body);
    try {
      const result = await session.send(method, params);
      return new Response(JSON.stringify({ result }));
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: String(err) } }));
    }
  });
}

async function pixelAt(probe: PwPage, image: Buffer, x: number, y: number): Promise<number[]> {
  return probe.evaluate(
    async ({ src, x, y }) => {
      const img = new (window as any).Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return [img.width, img.height, ...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    },
    { src: `data:image/png;base64,${image.toString("base64")}`, x, y }
  );
}

let browser: Browser;
let hidpiBrowser: Browser;
let probe: PwPage;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  // A true 2x display: Chrome sizes captures differently than under emulation.
  hidpiBrowser = await chromium.launch({
    headless: true,
    args: ["--force-device-scale-factor=2"],
  });
  probe = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
  await hidpiBrowser.close();
});

describe.each(["standalone", "extension"] as const)("computer tool (%s)", (mode) => {
  let context: BrowserContext;
  let pw: PwPage;
  let page: Page;

  async function open(
    from: Browser = browser,
    options: BrowserContextOptions = { viewport: { width: 800, height: 600 } }
  ): Promise<void> {
    context = await from.newContext(options);
    pw = await context.newPage();
    await pw.setContent(FIXTURE);
    if (mode === "standalone") {
      page = pw as unknown as Page;
    } else {
      routeRelayToCdp(await context.newCDPSession(pw));
      page = new CDPPage(RELAY_URL, "test", "session") as unknown as Page;
    }
  }

  // Patchright evaluates in an isolated world by default. The fixture's own
  // script records events in the main world, so read them there.
  const events = (type: string): Promise<any[]> =>
    pw.evaluate((t) => window.log.filter((e: any) => e.type === t), type, false);

  // Put snapshot refs in the world the Page under test reads them from:
  // isolated for patchright's Page, main for CDPPage.
  const setRefs = (id?: string): Promise<void> =>
    pw.evaluate(
      (refId) => {
        (globalThis as any).__devBrowserRefs = refId ? { e1: document.getElementById(refId) } : {};
      },
      id,
      mode === "standalone"
    );

  afterEach(async () => {
    vi.unstubAllGlobals();
    await context.close();
  });

  test("left_click lands on the coordinate", async () => {
    await open();
    await computerAction(page, { action: "left_click", coordinate: [250, 40] });
    const [click] = await events("click");
    expect(click).toMatchObject({ target: "btn", x: 250, y: 40, button: 0 });
  });

  test("left_click by ref scrolls the element into view first", async () => {
    await open();
    await setRefs("far");
    await computerAction(page, { action: "left_click", ref: "e1" });
    expect((await events("click"))[0]).toMatchObject({ target: "far" });
  });

  test("an unknown ref reports an error", async () => {
    await open();
    await setRefs();
    await expect(computerAction(page, { action: "left_click", ref: "e9" })).rejects.toThrow(
      /not found/
    );
  });

  test("right_click fires contextmenu with the right button", async () => {
    await open();
    await computerAction(page, { action: "right_click", coordinate: [250, 40] });
    const [menu] = await events("contextmenu");
    expect(menu).toMatchObject({ target: "btn", button: 2, buttons: 2 });
  });

  test("double_click fires dblclick", async () => {
    await open();
    await computerAction(page, { action: "double_click", coordinate: [250, 40] });
    expect(await events("dblclick")).toHaveLength(1);
  });

  test("triple_click selects the paragraph", async () => {
    await open();
    await computerAction(page, { action: "triple_click", coordinate: [230, 168] });
    const selected = await pw.evaluate(() => window.getSelection().toString());
    expect(selected).toContain("one two three");
  });

  test("click modifiers reach the page and are released", async () => {
    await open();
    await computerAction(page, {
      action: "left_click",
      coordinate: [250, 40],
      modifiers: "alt+shift",
    });
    await computerAction(page, { action: "left_click", coordinate: [250, 40] });
    const [modified, plain] = await events("click");
    expect(modified).toMatchObject({ shift: true, alt: true });
    expect(plain).toMatchObject({ shift: false, alt: false });
  });

  test("hover moves without clicking", async () => {
    await open();
    await computerAction(page, { action: "hover", coordinate: [340, 40] });
    const hovered = await events("mouseover");
    expect(hovered.at(-1)).toMatchObject({ target: "hov" });
    expect(await events("click")).toHaveLength(0);
  });

  test("type enters text, newlines, and non-BMP characters", async () => {
    await open();
    await computerAction(page, { action: "left_click", coordinate: [350, 110] });
    await computerAction(page, { action: "type", text: "a+b\ncd 😀" });
    expect(await pw.inputValue("#area")).toBe("a+b\ncd 😀");
  });

  test("key handles sequences, repeat, and aliases", async () => {
    await open();
    await computerAction(page, { action: "left_click", coordinate: [350, 110] });
    await computerAction(page, { action: "type", text: "abcd" });
    await computerAction(page, { action: "key", text: "BackSpace", repeat: 2 });
    await computerAction(page, { action: "key", text: "left x" });
    expect(await pw.inputValue("#area")).toBe("axb");
  });

  test("a key combo doesn't type its letter", async () => {
    await open();
    await computerAction(page, { action: "left_click", coordinate: [350, 110] });
    await computerAction(page, { action: "type", text: "ab" });
    await computerAction(page, { action: "key", text: "ctrl+b" });
    expect(await pw.inputValue("#area")).toBe("ab");
  });

  test("cmd+a selects the field", async () => {
    await open();
    await computerAction(page, { action: "left_click", coordinate: [350, 110] });
    await computerAction(page, { action: "type", text: "abc" });
    await computerAction(page, { action: "key", text: "cmd+a" });
    const selected = await pw.evaluate(() => {
      const area = document.getElementById("area");
      return area.value.slice(area.selectionStart, area.selectionEnd);
    });
    expect(selected).toBe("abc");
  });

  test("scroll moves the page", async () => {
    await open();
    await computerAction(page, {
      action: "scroll",
      coordinate: [600, 300],
      scroll_direction: "down",
      scroll_amount: 5,
    });
    await pw.waitForFunction(() => window.scrollY === 500);
  });

  test("scroll_to brings a ref into view", async () => {
    await open();
    await setRefs("far");
    await computerAction(page, { action: "scroll_to", ref: "e1" });
    expect(await pw.evaluate(() => window.scrollY)).toBeGreaterThan(1500);
  });

  test("left_click_drag holds the button through the move", async () => {
    await open();
    await computerAction(page, {
      action: "left_click_drag",
      start_coordinate: [220, 240],
      coordinate: [420, 240],
    });
    const moves = await pw.evaluate(() => window.drag, undefined, false);
    expect(moves.length).toBeGreaterThan(1);
    expect(moves.at(-1).x).toBe(420);
    expect(moves.every((m: any) => m.buttons === 1)).toBe(true);
  });

  // The standalone server always emulates a fixed viewport, so only extension
  // mode ever runs on a true 2x display.
  test.each([
    ...(mode === "extension" ? [["display", () => hidpiBrowser, { viewport: null }] as const] : []),
    [
      "emulated",
      () => browser,
      { viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 },
    ] as const,
  ])("screenshot pixels match click coordinates at 2x (%s)", async (_, from, options) => {
    await open(from(), options);
    expect(await pw.evaluate(() => window.devicePixelRatio)).toBe(2);
    const { image, message } = await computerAction(page, { action: "screenshot" });
    expect(message).toContain("800x600");
    const [width, height, r, g, b] = await pixelAt(probe, image!, 50, 50);
    expect([width, height]).toEqual([800, 600]);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  test("screenshot at 2x captures the scrolled viewport", async () => {
    await open(hidpiBrowser, { viewport: null });
    await pw.evaluate(() => window.scrollTo(0, 1000));
    const { image } = await computerAction(page, { action: "screenshot" });
    const [, , r, g, b] = await pixelAt(probe, image!, 50, 50);
    expect([r, g, b]).toEqual([0, 0, 255]);
  });

  test("zoom crops the viewport, including after scrolling", async () => {
    await open();
    await pw.evaluate(() => window.scrollTo(0, 1000));
    const { image } = await computerAction(page, { action: "zoom", region: [0, 0, 50, 50] });
    const [width, height, r, g, b] = await pixelAt(probe, image!, 25, 25);
    expect([width, height]).toEqual([50, 50]);
    expect([r, g, b]).toEqual([0, 0, 255]);
  });

  const cdpFor = async (): Promise<CdpSend> => {
    const session = await context.newCDPSession(pw);
    return (method, params) => session.send(method as any, params) as any;
  };

  test.each([
    ["1x", () => browser, undefined],
    ["2x display", () => hidpiBrowser, { viewport: null }],
  ] as const)("zoom with CDP magnifies the region (%s)", async (_, from, options) => {
    await open(from(), options);
    await pw.evaluate(() => window.scrollTo(0, 1000));
    const { image, message } = await computerAction(
      page,
      { action: "zoom", region: [0, 0, 50, 50] },
      await cdpFor()
    );
    expect(message).toContain("at 4x");
    const [width, height, r, g, b] = await pixelAt(probe, image!, 100, 100);
    expect([width, height]).toEqual([200, 200]);
    expect([r, g, b]).toEqual([0, 0, 255]);
  });

  test("screenshot scale shrinks the image", async () => {
    await open();
    const { image, message } = await computerAction(
      page,
      { action: "screenshot", scale: 0.5 },
      await cdpFor()
    );
    const [width, height, r, g, b] = await pixelAt(probe, image!, 25, 25);
    expect([width, height]).toEqual([400, 300]);
    expect([r, g, b]).toEqual([255, 0, 0]);
    expect(message).toContain("divide image pixels by 0.5");
  });

  test("wait pauses and rejects long durations", async () => {
    await open();
    const started = Date.now();
    await computerAction(page, { action: "wait", duration: 0.2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    await expect(computerAction(page, { action: "wait", duration: 11 })).rejects.toThrow(
      /duration/
    );
  });
});

describe("normalizeKeyCombo", () => {
  test.each([
    ["cmd+a", "Meta+a"],
    ["ctrl+shift+Return", "Control+Shift+Enter"],
    ["ctrl++", "Control++"],
    ["esc", "Escape"],
    ["f5", "F5"],
    ["a", "a"],
    ["+", "+"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeKeyCombo(input)).toBe(expected);
  });
});
