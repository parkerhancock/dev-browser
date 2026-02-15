import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CDPPage, CDPLocator } from "../cdp-page.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================================
// Mock Relay Infrastructure
// ============================================================================

const RELAY_URL = "http://test-relay:9224";
const PAGE_NAME = "test-page";
const SESSION = "test-session";

interface CdpCall {
  method: string;
  params?: Record<string, any>;
}

function runtimeResult(value: any) {
  return {
    result: {
      type: value === null ? "object" : typeof value,
      value,
    },
  };
}

function runtimeError(message: string) {
  return {
    result: { type: "undefined", value: undefined },
    exceptionDetails: {
      text: "Error",
      exception: { description: message },
    },
  };
}

function createMockRelay() {
  const cdpCalls: CdpCall[] = [];
  const cdpHandlers = new Map<string, (params?: any) => any>();

  // Default CDP handlers
  cdpHandlers.set("Runtime.evaluate", (params) => {
    const expr: string = params?.expression ?? "";
    if (expr === "document.readyState") return runtimeResult("complete");
    if (expr === "location.href") return runtimeResult("about:blank");
    if (expr === "document.title") return runtimeResult("Test Page");
    if (expr === "document.documentElement.outerHTML")
      return runtimeResult("<html><body>test</body></html>");
    // Element center resolution
    if (expr.includes("getBoundingClientRect"))
      return runtimeResult({ x: 100, y: 200 });
    // Selector existence checks
    if (expr.includes("document.querySelector"))
      return runtimeResult(true);
    return runtimeResult(undefined);
  });
  cdpHandlers.set("Page.navigate", () => ({ frameId: "main" }));
  cdpHandlers.set("Page.reload", () => ({}));
  cdpHandlers.set("Page.captureScreenshot", () => ({ data: "AQID" })); // base64 for [1,2,3]
  cdpHandlers.set("Page.printToPDF", () => ({ data: "BAUG" }));
  cdpHandlers.set("Input.dispatchMouseEvent", () => ({}));
  cdpHandlers.set("Input.dispatchKeyEvent", () => ({}));
  cdpHandlers.set("Input.insertText", () => ({}));
  cdpHandlers.set("Emulation.setDeviceMetricsOverride", () => ({}));

  const endpointResponses = new Map<string, any>();
  endpointResponses.set("/snapshot", { snapshot: "- button: Click me [ref=e1]" });
  endpointResponses.set("/ref-action", { success: true });

  const originalFetch = globalThis.fetch;

  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const httpMethod = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      // CDP endpoint
      if (url === `${RELAY_URL}/cdp` && body) {
        cdpCalls.push({ method: body.method, params: body.params });
        const handler = cdpHandlers.get(body.method);
        if (!handler) {
          return new Response(
            JSON.stringify({ error: { message: `Unknown CDP method: ${body.method}` } }),
            { status: 400 }
          );
        }
        return new Response(JSON.stringify({ result: handler(body.params) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Page deletion
      if (url.startsWith(`${RELAY_URL}/pages/`) && httpMethod === "DELETE") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      // Named endpoints (snapshot, ref-action)
      for (const [path, response] of endpointResponses) {
        if (url === `${RELAY_URL}${path}`) {
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      return new Response("{}", { status: 200 });
    }
  ) as any;

  return {
    cdpCalls,
    onCdp(method: string, handler: (params?: any) => any) {
      cdpHandlers.set(method, handler);
    },
    onEndpoint(path: string, response: any) {
      endpointResponses.set(path, response);
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
    reset() {
      cdpCalls.length = 0;
    },
    /** Get all calls for a specific CDP method */
    callsFor(method: string) {
      return cdpCalls.filter((c) => c.method === method);
    },
    /** Get the last call for a specific CDP method */
    lastCall(method: string) {
      const calls = this.callsFor(method);
      return calls[calls.length - 1];
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("CDPPage", () => {
  let relay: ReturnType<typeof createMockRelay>;
  let page: CDPPage;

  beforeEach(() => {
    relay = createMockRelay();
    page = new CDPPage(RELAY_URL, PAGE_NAME, SESSION, "https://initial.test");
  });

  afterEach(() => {
    relay.restore();
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  describe("navigation", () => {
    it("goto sends Page.navigate and polls readyState", async () => {
      await page.goto("https://example.com");

      const navCalls = relay.callsFor("Page.navigate");
      expect(navCalls).toHaveLength(1);
      expect(navCalls[0]!.params?.url).toBe("https://example.com");

      // Should have polled readyState
      const evalCalls = relay.callsFor("Runtime.evaluate");
      const readyStatePolls = evalCalls.filter(
        (c) => c.params?.expression === "document.readyState"
      );
      expect(readyStatePolls.length).toBeGreaterThanOrEqual(1);
    });

    it("goto with waitUntil=commit skips readyState polling", async () => {
      await page.goto("https://example.com", { waitUntil: "commit" });

      expect(relay.callsFor("Page.navigate")).toHaveLength(1);

      // Should still syncUrl but not poll readyState
      const evalCalls = relay.callsFor("Runtime.evaluate");
      const readyStatePolls = evalCalls.filter(
        (c) => c.params?.expression === "document.readyState"
      );
      expect(readyStatePolls).toHaveLength(0);
    });

    it("goto throws on navigation error", async () => {
      relay.onCdp("Page.navigate", () => ({
        frameId: "main",
        errorText: "net::ERR_NAME_NOT_RESOLVED",
      }));
      await expect(page.goto("https://bad.example")).rejects.toThrow(
        "Navigation failed"
      );
    });

    it("goto syncs cached URL after navigation", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression === "location.href")
          return runtimeResult("https://example.com/landed");
        if (params?.expression === "document.readyState")
          return runtimeResult("complete");
        return runtimeResult(undefined);
      });

      await page.goto("https://example.com");
      expect(page.url()).toBe("https://example.com/landed");
    });

    it("goBack sends history.back() and polls readyState", async () => {
      await page.goBack();

      const evalCalls = relay.callsFor("Runtime.evaluate");
      const historyCall = evalCalls.find((c) =>
        c.params?.expression?.includes("history.back()")
      );
      expect(historyCall).toBeDefined();
    });

    it("goForward sends history.forward()", async () => {
      await page.goForward();

      const evalCalls = relay.callsFor("Runtime.evaluate");
      const historyCall = evalCalls.find((c) =>
        c.params?.expression?.includes("history.forward()")
      );
      expect(historyCall).toBeDefined();
    });

    it("reload sends Page.reload CDP command", async () => {
      await page.reload();
      expect(relay.callsFor("Page.reload")).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Content
  // ==========================================================================

  describe("content", () => {
    it("url() returns cached URL (sync)", () => {
      expect(page.url()).toBe("https://initial.test");
    });

    it("title() evaluates document.title", async () => {
      const title = await page.title();
      expect(title).toBe("Test Page");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toBe("document.title");
    });

    it("content() evaluates document.documentElement.outerHTML", async () => {
      const html = await page.content();
      expect(html).toBe("<html><body>test</body></html>");
    });

    it("setContent() sets innerHTML via evaluate", async () => {
      await page.setContent("<p>new content</p>");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain(
        'document.documentElement.innerHTML = "<p>new content</p>"'
      );
    });

    it("innerHTML() queries selector and returns innerHTML", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("innerHTML"))
          return runtimeResult("<span>inner</span>");
        return runtimeResult("complete");
      });

      const html = await page.innerHTML("div.content");
      expect(html).toBe("<span>inner</span>");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("div.content");
      expect(call?.params?.expression).toContain(".innerHTML");
    });

    it("innerText() queries selector and returns innerText", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("innerText"))
          return runtimeResult("Hello World");
        return runtimeResult("complete");
      });

      const text = await page.innerText("h1");
      expect(text).toBe("Hello World");
    });

    it("textContent() returns null when element not found", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("textContent"))
          return runtimeResult(null);
        return runtimeResult("complete");
      });

      const text = await page.textContent(".nonexistent");
      expect(text).toBeNull();
    });
  });

  // ==========================================================================
  // Evaluation
  // ==========================================================================

  describe("evaluate", () => {
    it("evaluate with string expression", async () => {
      relay.onCdp("Runtime.evaluate", () => runtimeResult(42));

      const result = await page.evaluate("1 + 1");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toBe("1 + 1");
      expect(call?.params?.returnByValue).toBe(true);
      expect(call?.params?.awaitPromise).toBe(true);
      expect(result).toBe(42);
    });

    it("evaluate with function serializes to IIFE", async () => {
      relay.onCdp("Runtime.evaluate", () => runtimeResult("result"));

      await page.evaluate(() => "hello");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("() => ");
      expect(call?.params?.expression).toMatch(/^\(.*\)\(\)$/);
    });

    it("evaluate with function and args serializes args", async () => {
      relay.onCdp("Runtime.evaluate", () => runtimeResult("ok"));

      await page.evaluate((x: number, y: string) => `${x}-${y}`, 5, "test");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("5");
      expect(call?.params?.expression).toContain('"test"');
    });

    it("evaluate throws on CDP exception details", async () => {
      relay.onCdp("Runtime.evaluate", () =>
        runtimeError("ReferenceError: foo is not defined")
      );

      await expect(page.evaluate("foo()")).rejects.toThrow(
        "ReferenceError: foo is not defined"
      );
    });

    it("evaluate throws for non-string/function pageFunction", async () => {
      await expect(page.evaluate(42 as any)).rejects.toThrow(
        "pageFunction must be a string or function"
      );
    });

    it("evaluateHandle sends with returnByValue:false", async () => {
      relay.onCdp("Runtime.evaluate", () => ({
        result: { type: "object", objectId: "obj-123" },
      }));

      const result = await page.evaluateHandle("document.body");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.returnByValue).toBe(false);
      expect(result).toMatchObject({ type: "object", objectId: "obj-123" });
    });
  });

  // ==========================================================================
  // Interaction
  // ==========================================================================

  describe("interaction", () => {
    it("click resolves element center then dispatches mouse events", async () => {
      await page.click("button.submit");

      // Should evaluate to get element center
      const evalCalls = relay.callsFor("Runtime.evaluate");
      const centerCall = evalCalls.find(
        (c) =>
          c.params?.expression?.includes("button.submit") &&
          c.params?.expression?.includes("getBoundingClientRect")
      );
      expect(centerCall).toBeDefined();

      // Should dispatch mouseMoved, mousePressed, mouseReleased
      const mouseCalls = relay.callsFor("Input.dispatchMouseEvent");
      expect(mouseCalls).toHaveLength(3);
      expect(mouseCalls[0]!.params?.type).toBe("mouseMoved");
      expect(mouseCalls[1]!.params?.type).toBe("mousePressed");
      expect(mouseCalls[2]!.params?.type).toBe("mouseReleased");

      // All at the resolved coordinates
      expect(mouseCalls[1]!.params?.x).toBe(100);
      expect(mouseCalls[1]!.params?.y).toBe(200);
    });

    it("dblclick dispatches four mouse events (two click cycles)", async () => {
      await page.dblclick("button");

      const mouseCalls = relay.callsFor("Input.dispatchMouseEvent");
      // move + press + release + press(clickCount:2) + release(clickCount:2) = 5
      expect(mouseCalls).toHaveLength(5);
      expect(mouseCalls[3]!.params?.clickCount).toBe(2);
    });

    it("fill focuses element, sets value, and dispatches events", async () => {
      await page.fill("input#email", "test@example.com");

      const call = relay.lastCall("Runtime.evaluate");
      const expr = call?.params?.expression ?? "";
      expect(expr).toContain('input#email');
      expect(expr).toContain(".focus()");
      expect(expr).toContain('.value = "test@example.com"');
      expect(expr).toContain("input");
      expect(expr).toContain("change");
    });

    it("type focuses element then dispatches key events per character", async () => {
      await page.type("input", "ab");

      // Should focus first
      const evalCalls = relay.callsFor("Runtime.evaluate");
      const focusCall = evalCalls.find((c) =>
        c.params?.expression?.includes(".focus()")
      );
      expect(focusCall).toBeDefined();

      // Then dispatch key events: for each char (keyDown, char, keyUp) × 2 chars = 6
      const keyCalls = relay.callsFor("Input.dispatchKeyEvent");
      expect(keyCalls.length).toBeGreaterThanOrEqual(4); // at least down+up per char
    });

    it("hover moves mouse to element center", async () => {
      await page.hover(".tooltip-trigger");

      const mouseCalls = relay.callsFor("Input.dispatchMouseEvent");
      expect(mouseCalls).toHaveLength(1);
      expect(mouseCalls[0]!.params?.type).toBe("mouseMoved");
      expect(mouseCalls[0]!.params?.x).toBe(100);
      expect(mouseCalls[0]!.params?.y).toBe(200);
    });

    it("check clicks unchecked checkbox", async () => {
      await page.check("input[type=checkbox]");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("input[type=checkbox]");
      expect(call?.params?.expression).toContain("!el.checked");
      expect(call?.params?.expression).toContain("el.click()");
    });

    it("uncheck clicks checked checkbox", async () => {
      await page.uncheck("input[type=checkbox]");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("el.checked");
      expect(call?.params?.expression).toContain("el.click()");
    });

    it("selectOption evaluates in-browser selection logic", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("opt.selected"))
          return runtimeResult(["opt1", "opt2"]);
        return runtimeResult("complete");
      });

      const selected = await page.selectOption("select#country", ["opt1", "opt2"]);
      expect(selected).toEqual(["opt1", "opt2"]);
    });

    it("press focuses element then sends keyboard press", async () => {
      await page.press("input", "Enter");

      // Focus via evaluate
      const evalCalls = relay.callsFor("Runtime.evaluate");
      expect(evalCalls.some((c) => c.params?.expression?.includes(".focus()"))).toBe(true);

      // Key events
      const keyCalls = relay.callsFor("Input.dispatchKeyEvent");
      const enterDown = keyCalls.find(
        (c) => c.params?.type === "keyDown" && c.params?.key === "Enter"
      );
      const enterUp = keyCalls.find(
        (c) => c.params?.type === "keyUp" && c.params?.key === "Enter"
      );
      expect(enterDown).toBeDefined();
      expect(enterUp).toBeDefined();
    });

    it("focus evaluates el.focus() with correct selector", async () => {
      await page.focus("input#name");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("input#name");
      expect(call?.params?.expression).toContain(".focus()");
    });
  });

  // ==========================================================================
  // Waiting
  // ==========================================================================

  describe("waiting", () => {
    it("waitForSelector polls until element found", async () => {
      let callCount = 0;
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("offsetParent")) {
          callCount++;
          return runtimeResult(callCount >= 2); // found on second poll
        }
        return runtimeResult("complete");
      });

      await page.waitForSelector(".lazy-loaded");
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it("waitForSelector throws on timeout", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("offsetParent"))
          return runtimeResult(false); // never found
        return runtimeResult("complete");
      });

      await expect(
        page.waitForSelector(".never", { timeout: 300 })
      ).rejects.toThrow("not found after 300ms");
    });

    it("waitForLoadState resolves when readyState is complete", async () => {
      await page.waitForLoadState("load");
      // Should have checked readyState
      const call = relay.callsFor("Runtime.evaluate").find(
        (c) => c.params?.expression === "document.readyState"
      );
      expect(call).toBeDefined();
    });

    it("waitForTimeout waits the specified duration", async () => {
      const start = Date.now();
      await page.waitForTimeout(150);
      expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    });

    it("waitForURL resolves when URL matches string", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression === "location.href")
          return runtimeResult("https://example.com/target");
        return runtimeResult("complete");
      });

      await page.waitForURL("https://example.com/target");
      expect(page.url()).toBe("https://example.com/target");
    });

    it("waitForURL resolves when URL matches RegExp", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression === "location.href")
          return runtimeResult("https://example.com/item/123");
        return runtimeResult("complete");
      });

      await page.waitForURL(/\/item\/\d+$/);
    });

    it("waitForFunction polls until truthy", async () => {
      let callCount = 0;
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("window.ready")) {
          callCount++;
          return runtimeResult(callCount >= 3 ? true : false);
        }
        return runtimeResult("complete");
      });

      const result = await page.waitForFunction("window.ready");
      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it("waitForFunction throws on timeout", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("neverTrue"))
          return runtimeResult(false);
        return runtimeResult("complete");
      });

      await expect(
        page.waitForFunction("neverTrue", undefined, { timeout: 300 })
      ).rejects.toThrow("timed out after 300ms");
    });
  });

  // ==========================================================================
  // Screenshots / PDF
  // ==========================================================================

  describe("screenshots and PDF", () => {
    it("screenshot sends Page.captureScreenshot and returns Buffer", async () => {
      const buf = await page.screenshot();

      expect(relay.callsFor("Page.captureScreenshot")).toHaveLength(1);
      expect(Buffer.isBuffer(buf)).toBe(true);
    });

    it("screenshot with type=jpeg sets format", async () => {
      await page.screenshot({ type: "jpeg" });

      const call = relay.lastCall("Page.captureScreenshot");
      expect(call?.params?.format).toBe("jpeg");
    });

    it("screenshot fullPage measures page dimensions first", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("scrollWidth"))
          return runtimeResult(JSON.stringify({ width: 1920, height: 5000 }));
        return runtimeResult("complete");
      });

      await page.screenshot({ fullPage: true });

      const call = relay.lastCall("Page.captureScreenshot");
      expect(call?.params?.clip).toMatchObject({
        x: 0, y: 0, width: 1920, height: 5000,
      });
    });

    it("screenshot with clip passes clip directly", async () => {
      await page.screenshot({ clip: { x: 10, y: 20, width: 300, height: 400 } });

      const call = relay.lastCall("Page.captureScreenshot");
      expect(call?.params?.clip).toMatchObject({ x: 10, y: 20, width: 300, height: 400 });
    });

    it("pdf sends Page.printToPDF and returns Buffer", async () => {
      const buf = await page.pdf();

      expect(relay.callsFor("Page.printToPDF")).toHaveLength(1);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(relay.lastCall("Page.printToPDF")?.params?.printBackground).toBe(true);
    });

    it("pdf with Letter format sets paper dimensions", async () => {
      await page.pdf({ format: "Letter" });

      const call = relay.lastCall("Page.printToPDF");
      expect(call?.params?.paperWidth).toBe(8.5);
      expect(call?.params?.paperHeight).toBe(11);
    });
  });

  // ==========================================================================
  // State
  // ==========================================================================

  describe("state", () => {
    it("close() sends DELETE to relay and marks page closed", async () => {
      expect(page.isClosed()).toBe(false);

      await page.close();

      expect(page.isClosed()).toBe(true);

      // Should have sent DELETE /pages/<name>
      const deleteFetch = (globalThis.fetch as any).mock.calls.find(
        (c: any[]) =>
          String(c[0]).includes("/pages/") && c[1]?.method === "DELETE"
      );
      expect(deleteFetch).toBeDefined();
    });

    it("close() is idempotent", async () => {
      await page.close();
      await page.close(); // should not throw
      expect(page.isClosed()).toBe(true);
    });

    it("methods throw after close", async () => {
      await page.close();
      await expect(page.goto("https://example.com")).rejects.toThrow("is closed");
      await expect(page.title()).rejects.toThrow("is closed");
    });

    it("setViewportSize sends Emulation.setDeviceMetricsOverride", async () => {
      await page.setViewportSize({ width: 1024, height: 768 });

      const call = relay.lastCall("Emulation.setDeviceMetricsOverride");
      expect(call?.params).toMatchObject({
        width: 1024, height: 768, deviceScaleFactor: 1, mobile: false,
      });
      expect(page.viewportSize()).toEqual({ width: 1024, height: 768 });
    });

    it("viewportSize() returns null initially", () => {
      expect(page.viewportSize()).toBeNull();
    });

    it("syncUrl() updates cached URL from page", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression === "location.href")
          return runtimeResult("https://redirected.test");
        return runtimeResult("complete");
      });

      const url = await page.syncUrl();
      expect(url).toBe("https://redirected.test");
      expect(page.url()).toBe("https://redirected.test");
    });
  });

  // ==========================================================================
  // Extension-mode Extras
  // ==========================================================================

  describe("extension extras", () => {
    it("snapshot() calls relay /snapshot endpoint", async () => {
      const snap = await page.snapshot();
      expect(snap).toBe("- button: Click me [ref=e1]");

      const snapFetch = (globalThis.fetch as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("/snapshot")
      );
      expect(snapFetch).toBeDefined();
    });

    it("clickRef() calls relay /ref-action with click action", async () => {
      await page.clickRef("e1");

      const refFetch = (globalThis.fetch as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("/ref-action")
      );
      const body = JSON.parse(refFetch[1].body);
      expect(body).toMatchObject({ action: "click", ref: "e1" });
    });

    it("fillRef() calls relay /ref-action with fill action and value", async () => {
      await page.fillRef("e2", "hello");

      const refFetch = (globalThis.fetch as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("/ref-action")
      );
      const body = JSON.parse(refFetch[1].body);
      expect(body).toMatchObject({ action: "fill", ref: "e2", value: "hello" });
    });

    it("cdp() is public for escape hatch", async () => {
      relay.onCdp("DOM.getDocument", () => ({ root: { nodeId: 1 } }));

      const result = await page.cdp<{ root: { nodeId: number } }>(
        "DOM.getDocument"
      );
      expect(result.root.nodeId).toBe(1);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe("error handling", () => {
    it("cdp() throws on HTTP error", async () => {
      (globalThis.fetch as any).mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Target not found" } }),
            { status: 500 }
          )
      );

      await expect(page.cdp("Page.navigate", { url: "x" })).rejects.toThrow(
        "Target not found"
      );
    });

    it("snapshot throws on relay error", async () => {
      relay.onEndpoint("/snapshot", null);
      (globalThis.fetch as any).mockImplementationOnce(
        async () => new Response("Internal error", { status: 500 })
      );

      await expect(page.snapshot()).rejects.toThrow();
    });
  });
});

// ============================================================================
// CDPKeyboard
// ============================================================================

describe("CDPKeyboard", () => {
  let relay: ReturnType<typeof createMockRelay>;
  let page: CDPPage;

  beforeEach(() => {
    relay = createMockRelay();
    page = new CDPPage(RELAY_URL, PAGE_NAME, SESSION);
  });

  afterEach(() => {
    relay.restore();
  });

  it("press dispatches keyDown, char (if text), and keyUp", async () => {
    await page.keyboard.press("a");

    const keyCalls = relay.callsFor("Input.dispatchKeyEvent");
    expect(keyCalls.length).toBeGreaterThanOrEqual(2);

    const down = keyCalls.find((c) => c.params?.type === "keyDown");
    const up = keyCalls.find((c) => c.params?.type === "keyUp");
    expect(down?.params?.key).toBe("a");
    expect(down?.params?.code).toBe("KeyA");
    expect(up?.params?.key).toBe("a");
  });

  it("press with named key sends correct keyCode", async () => {
    await page.keyboard.press("Enter");

    const down = relay
      .callsFor("Input.dispatchKeyEvent")
      .find((c) => c.params?.type === "keyDown");
    expect(down?.params?.key).toBe("Enter");
    expect(down?.params?.windowsVirtualKeyCode).toBe(13);
  });

  it("press with compound key (Control+a) presses modifier first", async () => {
    await page.keyboard.press("Control+a");

    const keyCalls = relay.callsFor("Input.dispatchKeyEvent");
    const types = keyCalls.map((c) => `${c.params?.type}:${c.params?.key}`);

    // Should be: Control down, a down, a char(?), a up, Control up
    expect(types[0]).toBe("keyDown:Control");
    expect(types[types.length - 1]).toBe("keyUp:Control");
    expect(types.some((t) => t.includes(":a"))).toBe(true);
  });

  it("type dispatches events for each character", async () => {
    await page.keyboard.type("hi");

    const keyCalls = relay.callsFor("Input.dispatchKeyEvent");
    // At least keyDown+keyUp per char = 4 calls minimum
    expect(keyCalls.length).toBeGreaterThanOrEqual(4);

    const hDown = keyCalls.find(
      (c) => c.params?.type === "keyDown" && c.params?.key === "h"
    );
    const iDown = keyCalls.find(
      (c) => c.params?.type === "keyDown" && c.params?.key === "i"
    );
    expect(hDown).toBeDefined();
    expect(iDown).toBeDefined();
  });

  it("insertText sends Input.insertText CDP command", async () => {
    await page.keyboard.insertText("pasted text");

    const call = relay.lastCall("Input.insertText");
    expect(call?.params?.text).toBe("pasted text");
  });

  it("down/up track modifier state", async () => {
    await page.keyboard.down("Shift");
    await page.keyboard.press("a");
    await page.keyboard.up("Shift");

    const keyCalls = relay.callsFor("Input.dispatchKeyEvent");
    // The 'a' press should have Shift modifier bit (8)
    const aDown = keyCalls.find(
      (c) => c.params?.type === "keyDown" && c.params?.key === "a"
    );
    expect(aDown?.params?.modifiers).toBe(8);
  });
});

// ============================================================================
// CDPMouse
// ============================================================================

describe("CDPMouse", () => {
  let relay: ReturnType<typeof createMockRelay>;
  let page: CDPPage;

  beforeEach(() => {
    relay = createMockRelay();
    page = new CDPPage(RELAY_URL, PAGE_NAME, SESSION);
  });

  afterEach(() => {
    relay.restore();
  });

  it("click dispatches mouseMoved, mousePressed, mouseReleased", async () => {
    await page.mouse.click(50, 100);

    const calls = relay.callsFor("Input.dispatchMouseEvent");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.params?.type).toBe("mouseMoved");
    expect(calls[1]!.params?.type).toBe("mousePressed");
    expect(calls[2]!.params?.type).toBe("mouseReleased");
    expect(calls[1]!.params?.x).toBe(50);
    expect(calls[1]!.params?.y).toBe(100);
  });

  it("click with right button sends correct button", async () => {
    await page.mouse.click(0, 0, { button: "right" });

    const pressed = relay
      .callsFor("Input.dispatchMouseEvent")
      .find((c) => c.params?.type === "mousePressed");
    expect(pressed?.params?.button).toBe("right");
  });

  it("dblclick sends two click cycles with clickCount 1 and 2", async () => {
    await page.mouse.dblclick(50, 50);

    const calls = relay.callsFor("Input.dispatchMouseEvent");
    // move + press(1) + release(1) + press(2) + release(2) = 5
    expect(calls).toHaveLength(5);
    expect(calls[1]!.params?.clickCount).toBe(1);
    expect(calls[3]!.params?.clickCount).toBe(2);
  });

  it("move with steps interpolates positions", async () => {
    await page.mouse.move(100, 200, { steps: 4 });

    const calls = relay.callsFor("Input.dispatchMouseEvent");
    expect(calls).toHaveLength(4);
    // All should be mouseMoved
    expect(calls.every((c) => c.params?.type === "mouseMoved")).toBe(true);
    // Last call should be at target
    expect(calls[3]!.params?.x).toBe(100);
    expect(calls[3]!.params?.y).toBe(200);
  });

  it("wheel dispatches mouseWheel event", async () => {
    // Move first so coordinates are set
    await page.mouse.move(50, 50);
    relay.reset();

    await page.mouse.wheel(0, 100);

    const call = relay.lastCall("Input.dispatchMouseEvent");
    expect(call?.params?.type).toBe("mouseWheel");
    expect(call?.params?.deltaX).toBe(0);
    expect(call?.params?.deltaY).toBe(100);
  });
});

// ============================================================================
// CDPLocator
// ============================================================================

describe("CDPLocator", () => {
  let relay: ReturnType<typeof createMockRelay>;
  let page: CDPPage;

  beforeEach(() => {
    relay = createMockRelay();
    page = new CDPPage(RELAY_URL, PAGE_NAME, SESSION);
  });

  afterEach(() => {
    relay.restore();
  });

  describe("CSS locator", () => {
    it("locator().click() delegates to page.click with CSS selector", async () => {
      await page.locator("button.submit").click();

      // Should use the fast path (page.click with CSS selector)
      const evalCalls = relay.callsFor("Runtime.evaluate");
      const centerCall = evalCalls.find(
        (c) => c.params?.expression?.includes("button.submit") &&
               c.params?.expression?.includes("getBoundingClientRect")
      );
      expect(centerCall).toBeDefined();
    });

    it("locator().fill() delegates to page.fill", async () => {
      await page.locator("input#email").fill("test@test.com");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("input#email");
      expect(call?.params?.expression).toContain("test@test.com");
    });

    it("locator().textContent() returns element text", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("textContent"))
          return runtimeResult("Hello");
        return runtimeResult("complete");
      });

      const text = await page.locator("h1").textContent();
      expect(text).toBe("Hello");
    });

    it("locator().count() returns number of matches", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("querySelectorAll") && params?.expression?.includes(".length"))
          return runtimeResult(5);
        return runtimeResult("complete");
      });

      const count = await page.locator("li").count();
      expect(count).toBe(5);
    });

    it("locator().isVisible() returns boolean", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("offsetParent"))
          return runtimeResult(true);
        return runtimeResult("complete");
      });

      expect(await page.locator("div").isVisible()).toBe(true);
    });

    it("first() returns locator with nth=0", async () => {
      const loc = page.locator("li").first();

      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("els[0]"))
          return runtimeResult("first item");
        return runtimeResult("complete");
      });

      const text = await loc.textContent();
      expect(text).toBe("first item");
    });

    it("last() returns locator with nth=-1", async () => {
      const loc = page.locator("li").last();

      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("els[els.length - 1]"))
          return runtimeResult("last item");
        return runtimeResult("complete");
      });

      const text = await loc.textContent();
      expect(text).toBe("last item");
    });

    it("nth(n) returns locator with specific index", async () => {
      const loc = page.locator("li").nth(3);

      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("els[3]"))
          return runtimeResult("fourth item");
        return runtimeResult("complete");
      });

      const text = await loc.textContent();
      expect(text).toBe("fourth item");
    });
  });

  describe("getByTestId", () => {
    it("generates data-testid CSS selector", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("data-testid"))
          return runtimeResult("test content");
        return runtimeResult("complete");
      });

      const text = await page.getByTestId("login-btn").textContent();
      expect(text).toBe("test content");

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("data-testid");
      expect(call?.params?.expression).toContain("login-btn");
    });
  });

  describe("getByRole", () => {
    it("generates role selector with name filter", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        const expr = params?.expression ?? "";
        // Expression contains JSON-escaped quotes: [role=\"button\"]
        if (expr.includes("role=") && expr.includes("button") && expr.includes("Submit"))
          return runtimeResult("Submit");
        if (expr.includes("getBoundingClientRect"))
          return runtimeResult({ x: 50, y: 50 });
        return runtimeResult("complete");
      });

      const text = await page
        .getByRole("button", { name: "Submit" })
        .textContent();
      expect(text).toBe("Submit");
    });

    it("role without name generates simple role selector", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        // Expression contains JSON-escaped quotes in the role selector
        if (params?.expression?.includes("role=") && params?.expression?.includes("navigation"))
          return runtimeResult(2);
        return runtimeResult("complete");
      });

      const count = await page.getByRole("navigation").count();
      expect(count).toBe(2);
    });

    it("role with exact name uses strict equality", async () => {
      const loc = page.getByRole("button", { name: "OK", exact: true });

      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("=== ")) return runtimeResult("OK");
        return runtimeResult("complete");
      });

      const text = await loc.textContent();
      expect(text).toBe("OK");

      // Verify the expression uses === instead of includes
      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("=== ");
      expect(call?.params?.expression).not.toContain(".includes(");
    });
  });

  describe("getByText", () => {
    it("generates text content filter", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes(".includes(") && params?.expression?.includes("Welcome"))
          return runtimeResult("Welcome back!");
        return runtimeResult("complete");
      });

      const text = await page.getByText("Welcome").textContent();
      expect(text).toBe("Welcome back!");
    });

    it("exact mode uses strict equality", async () => {
      const loc = page.getByText("Hello", { exact: true });

      relay.onCdp("Runtime.evaluate", () => runtimeResult("Hello"));

      await loc.textContent();

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("=== ");
    });

    it("RegExp generates pattern matching", async () => {
      const loc = page.getByText(/welcome/i);

      relay.onCdp("Runtime.evaluate", () => runtimeResult("Welcome!"));

      await loc.textContent();

      const call = relay.lastCall("Runtime.evaluate");
      expect(call?.params?.expression).toContain("RegExp");
      expect(call?.params?.expression).toContain("welcome");
    });
  });

  describe("getByLabel", () => {
    it("generates label-based element resolution", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("querySelectorAll('label')"))
          return runtimeResult("Email value");
        return runtimeResult("complete");
      });

      const value = await page.getByLabel("Email").textContent();
      expect(value).toBe("Email value");

      const call = relay.lastCall("Runtime.evaluate");
      const expr = call?.params?.expression ?? "";
      expect(expr).toContain("label");
      expect(expr).toContain("htmlFor");
      expect(expr).toContain("getElementById");
    });
  });

  describe("getByPlaceholder", () => {
    it("string generates CSS attribute selector", async () => {
      const loc = page.getByPlaceholder("Enter email");

      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes("Enter email"))
          return runtimeResult("user@test.com");
        return runtimeResult("complete");
      });

      const value = await loc.inputValue();
      expect(value).toBe("user@test.com");
    });
  });

  describe("locator waitFor", () => {
    it("waitFor resolves when element becomes visible", async () => {
      let callCount = 0;
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes(".length")) {
          callCount++;
          return runtimeResult(callCount >= 2 ? 1 : 0);
        }
        if (params?.expression?.includes("offsetParent"))
          return runtimeResult(true);
        return runtimeResult("complete");
      });

      await page.locator(".modal").waitFor({ state: "visible", timeout: 5000 });
    });

    it("waitFor throws on timeout", async () => {
      relay.onCdp("Runtime.evaluate", (params) => {
        if (params?.expression?.includes(".length"))
          return runtimeResult(0);
        return runtimeResult("complete");
      });

      await expect(
        page.locator(".never").waitFor({ timeout: 300 })
      ).rejects.toThrow('timed out after 300ms');
    });
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any */
