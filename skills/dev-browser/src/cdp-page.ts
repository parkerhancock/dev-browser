/**
 * CDPPage — Page implementation for Chrome extension mode via HTTP RPC.
 *
 * Each method maps to CDP commands forwarded through the relay's /cdp endpoint.
 * Replaces ExtensionPage with the full Playwright-compatible Page interface.
 */

import type { Page, Locator, Keyboard, Mouse } from "./page.js";
import {
  resolveKey,
  parseKeyCombo,
  computeModifiers,
  elementCenterExpression,
  mouseButton,
} from "./cdp-helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================================
// Internal Types
// ============================================================================

interface RuntimeEvaluateResult {
  result: {
    type: string;
    value?: any;
    description?: string;
    subtype?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

// ============================================================================
// CDPPage
// ============================================================================

export class CDPPage implements Page {
  private relayUrl: string;
  private pageName: string;
  private session: string;
  private _url: string;
  private _closed = false;
  private _viewport: { width: number; height: number } | null = null;

  readonly keyboard: CDPKeyboard;
  readonly mouse: CDPMouse;

  constructor(
    relayUrl: string,
    pageName: string,
    session: string,
    initialUrl?: string
  ) {
    this.relayUrl = relayUrl;
    this.pageName = pageName;
    this.session = session;
    this._url = initialUrl ?? "about:blank";
    this.keyboard = new CDPKeyboard(this);
    this.mouse = new CDPMouse(this);
  }

  // ---- CDP transport (public for escape hatch) ----

  async cdp<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (this._closed) throw new Error(`Page "${this.pageName}" is closed`);

    const res = await fetch(`${this.relayUrl}/cdp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DevBrowser-Session": this.session,
      },
      body: JSON.stringify({ page: this.pageName, method, params }),
    });

    const data = (await res.json()) as {
      result?: T;
      error?: { message: string };
    };

    if (!res.ok || data.error) {
      throw new Error(
        data.error?.message ?? `CDP ${method} failed (${res.status})`
      );
    }

    return data.result as T;
  }

  // Internal evaluate helper (returns raw CDP result)
  private async evalRaw(
    expression: string,
    returnByValue = true
  ): Promise<RuntimeEvaluateResult> {
    return this.cdp<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      returnByValue,
      awaitPromise: true,
    });
  }

  // Internal evaluate helper that throws on exception
  private async evalValue<T = any>(expression: string): Promise<T> {
    const result = await this.evalRaw(expression);
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${desc}`);
    }
    return result.result.value as T;
  }

  // ======================================================================
  // Navigation
  // ======================================================================

  async goto(
    url: string,
    options?: { timeout?: number; waitUntil?: string }
  ): Promise<any> {
    const result = await this.cdp<{ frameId: string; errorText?: string }>(
      "Page.navigate",
      { url }
    );
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }

    if (options?.waitUntil !== "commit") {
      await this.pollReadyState(options?.timeout ?? 15000);
    }

    await this.syncUrl();
    return null;
  }

  async goBack(
    options?: { timeout?: number; waitUntil?: string }
  ): Promise<any> {
    await this.evalValue("history.back()");
    await this.pollReadyState(options?.timeout ?? 15000);
    await this.syncUrl();
    return null;
  }

  async goForward(
    options?: { timeout?: number; waitUntil?: string }
  ): Promise<any> {
    await this.evalValue("history.forward()");
    await this.pollReadyState(options?.timeout ?? 15000);
    await this.syncUrl();
    return null;
  }

  async reload(
    options?: { timeout?: number; waitUntil?: string }
  ): Promise<any> {
    await this.cdp("Page.reload");
    await this.pollReadyState(options?.timeout ?? 15000);
    await this.syncUrl();
    return null;
  }

  // ======================================================================
  // Content
  // ======================================================================

  url(): string {
    return this._url;
  }

  async title(): Promise<string> {
    return this.evalValue<string>("document.title");
  }

  async content(): Promise<string> {
    return this.evalValue<string>("document.documentElement.outerHTML");
  }

  async setContent(
    html: string,
    _options?: { timeout?: number; waitUntil?: string }
  ): Promise<void> {
    const escaped = JSON.stringify(html);
    await this.evalValue(`document.documentElement.innerHTML = ${escaped}`);
  }

  async innerHTML(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<string> {
    const sel = JSON.stringify(selector);
    return this.evalValue<string>(
      `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('Element not found: ' + ${sel}); return el.innerHTML; })()`
    );
  }

  async innerText(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<string> {
    const sel = JSON.stringify(selector);
    return this.evalValue<string>(
      `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('Element not found: ' + ${sel}); return el.innerText; })()`
    );
  }

  async textContent(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<string | null> {
    const sel = JSON.stringify(selector);
    return this.evalValue<string | null>(
      `(() => { const el = document.querySelector(${sel}); return el ? el.textContent : null; })()`
    );
  }

  // ======================================================================
  // Evaluation
  // ======================================================================

  async evaluate<R = any>(
    pageFunction: string | ((...args: any[]) => R | Promise<R>),
    ...args: any[]
  ): Promise<R> {
    let expression: string;
    if (typeof pageFunction === "string") {
      expression = pageFunction;
    } else if (typeof pageFunction === "function") {
      const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
      expression = `(${pageFunction.toString()})(${serializedArgs})`;
    } else {
      throw new Error("pageFunction must be a string or function");
    }

    return this.evalValue<R>(expression);
  }

  async evaluateHandle(
    pageFunction: string | ((...args: any[]) => any),
    ...args: any[]
  ): Promise<any> {
    // In extension mode, we can't hold remote object handles across HTTP calls.
    // Return the value directly (same as evaluate).
    let expression: string;
    if (typeof pageFunction === "string") {
      expression = pageFunction;
    } else if (typeof pageFunction === "function") {
      const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
      expression = `(${pageFunction.toString()})(${serializedArgs})`;
    } else {
      throw new Error("pageFunction must be a string or function");
    }

    const result = await this.evalRaw(expression, false);
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${desc}`);
    }
    return result.result.value ?? result.result;
  }

  // ======================================================================
  // Interaction
  // ======================================================================

  async click(
    selector: string,
    options?: {
      timeout?: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void> {
    const { x, y } = await this.resolveElementCenter(selector);
    await this.mouse.click(x, y, {
      button: options?.button,
      clickCount: options?.clickCount,
      delay: options?.delay,
    });
  }

  async dblclick(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<void> {
    const { x, y } = await this.resolveElementCenter(selector);
    await this.mouse.dblclick(x, y);
  }

  async fill(
    selector: string,
    value: string,
    _options?: { timeout?: number }
  ): Promise<void> {
    const sel = JSON.stringify(selector);
    const val = JSON.stringify(value);
    // Focus, clear existing value, set new value, dispatch events
    await this.evalValue(
      `(() => {
        const el = document.querySelector(${sel});
        if (!el) throw new Error('Element not found: ' + ${sel});
        el.focus();
        el.value = '';
        el.value = ${val};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
    );
  }

  async type(
    selector: string,
    text: string,
    options?: { delay?: number; timeout?: number }
  ): Promise<void> {
    await this.focus(selector);
    await this.keyboard.type(text, { delay: options?.delay });
  }

  async hover(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<void> {
    const { x, y } = await this.resolveElementCenter(selector);
    await this.mouse.move(x, y);
  }

  async selectOption(
    selector: string,
    values: any,
    _options?: { timeout?: number }
  ): Promise<string[]> {
    const sel = JSON.stringify(selector);
    const vals = JSON.stringify(Array.isArray(values) ? values : [values]);
    return this.evalValue<string[]>(
      `(() => {
        const el = document.querySelector(${sel});
        if (!el) throw new Error('Element not found: ' + ${sel});
        const valuesToSelect = ${vals};
        const selected = [];
        for (const opt of el.options) {
          opt.selected = valuesToSelect.some(v =>
            typeof v === 'string' ? opt.value === v :
            (v.value != null && opt.value === v.value) ||
            (v.label != null && opt.label === v.label) ||
            (v.index != null && opt.index === v.index)
          );
          if (opt.selected) selected.push(opt.value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return selected;
      })()`
    );
  }

  async check(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<void> {
    const sel = JSON.stringify(selector);
    await this.evalValue(
      `(() => {
        const el = document.querySelector(${sel});
        if (!el) throw new Error('Element not found: ' + ${sel});
        if (!el.checked) el.click();
      })()`
    );
  }

  async uncheck(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<void> {
    const sel = JSON.stringify(selector);
    await this.evalValue(
      `(() => {
        const el = document.querySelector(${sel});
        if (!el) throw new Error('Element not found: ' + ${sel});
        if (el.checked) el.click();
      })()`
    );
  }

  async press(
    selector: string,
    key: string,
    options?: { delay?: number; timeout?: number }
  ): Promise<void> {
    await this.focus(selector);
    await this.keyboard.press(key, { delay: options?.delay });
  }

  async focus(
    selector: string,
    _options?: { timeout?: number }
  ): Promise<void> {
    const sel = JSON.stringify(selector);
    await this.evalValue(
      `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('Element not found: ' + ${sel}); el.focus(); })()`
    );
  }

  // ======================================================================
  // Locators
  // ======================================================================

  locator(selector: string): Locator {
    return new CDPLocator(this, { type: "css", selector });
  }

  getByRole(
    role: string,
    options?: { name?: string | RegExp; exact?: boolean }
  ): Locator {
    return new CDPLocator(this, {
      type: "role",
      role,
      name: options?.name,
      exact: options?.exact,
    });
  }

  getByText(
    text: string | RegExp,
    options?: { exact?: boolean }
  ): Locator {
    return new CDPLocator(this, { type: "text", text, exact: options?.exact });
  }

  getByTestId(testId: string | RegExp): Locator {
    const selector =
      testId instanceof RegExp
        ? `[data-testid]`
        : `[data-testid="${cssEscape(String(testId))}"]`;
    return new CDPLocator(this, { type: "css", selector, testIdPattern: testId instanceof RegExp ? testId : undefined });
  }

  getByLabel(
    text: string | RegExp,
    options?: { exact?: boolean }
  ): Locator {
    return new CDPLocator(this, { type: "label", text, exact: options?.exact });
  }

  getByPlaceholder(
    text: string | RegExp,
    options?: { exact?: boolean }
  ): Locator {
    if (text instanceof RegExp) {
      return new CDPLocator(this, {
        type: "placeholder",
        text,
        exact: options?.exact,
      });
    }
    const escaped = cssEscape(text);
    const selector = options?.exact
      ? `[placeholder="${escaped}"]`
      : `[placeholder*="${escaped}"]`;
    return new CDPLocator(this, { type: "css", selector });
  }

  // ======================================================================
  // Waiting
  // ======================================================================

  async waitForSelector(
    selector: string,
    options?: { timeout?: number; state?: string }
  ): Promise<any> {
    const timeout = options?.timeout ?? 30000;
    const state = options?.state ?? "visible";
    const start = Date.now();
    const sel = JSON.stringify(selector);

    while (Date.now() - start < timeout) {
      const found = await this.evalValue<boolean>(
        state === "visible"
          ? `(() => { const el = document.querySelector(${sel}); return !!(el && el.offsetParent !== null); })()`
          : state === "hidden"
            ? `(() => { const el = document.querySelector(${sel}); return !el || el.offsetParent === null; })()`
            : `!!document.querySelector(${sel})`
      );
      if (found) return;
      await delay(100);
    }
    throw new Error(
      `waitForSelector: "${selector}" not found after ${timeout}ms`
    );
  }

  async waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number }
  ): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const target = state ?? "load";
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const readyState = await this.evalValue<string>("document.readyState");
      if (target === "domcontentloaded" && readyState !== "loading") return;
      if ((target === "load" || target === "networkidle") && readyState === "complete")
        return;
      await delay(100);
    }
  }

  async waitForFunction(
    pageFunction: string | ((...args: any[]) => any),
    arg?: any,
    options?: { timeout?: number; polling?: number }
  ): Promise<any> {
    const timeout = options?.timeout ?? 30000;
    const polling = options?.polling ?? 100;
    const start = Date.now();

    let expression: string;
    if (typeof pageFunction === "string") {
      expression = pageFunction;
    } else {
      const serializedArg = arg !== undefined ? JSON.stringify(arg) : "";
      expression = `(${pageFunction.toString()})(${serializedArg})`;
    }

    while (Date.now() - start < timeout) {
      const result = await this.evalValue(expression);
      if (result) return result;
      await delay(polling);
    }
    throw new Error(`waitForFunction timed out after ${timeout}ms`);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await delay(ms);
  }

  async waitForURL(
    url: string | RegExp | ((url: URL) => boolean),
    options?: { timeout?: number }
  ): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const current = await this.evalValue<string>("location.href");
      this._url = current;

      if (typeof url === "string" && current === url) return;
      if (url instanceof RegExp && url.test(current)) return;
      if (typeof url === "function" && url(new URL(current))) return;

      await delay(100);
    }
    throw new Error(`waitForURL timed out after ${timeout}ms`);
  }

  // ======================================================================
  // Screenshots / PDF
  // ======================================================================

  async screenshot(options?: {
    fullPage?: boolean;
    type?: "png" | "jpeg";
    path?: string;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer> {
    const captureParams: Record<string, unknown> = {
      format: options?.type === "jpeg" ? "jpeg" : "png",
    };

    if (options?.clip) {
      captureParams.clip = { ...options.clip, scale: 1 };
    } else if (options?.fullPage) {
      const dims = await this.evalValue<{ width: number; height: number }>(
        `JSON.stringify({ width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) })`
      );
      const parsed = typeof dims === "string" ? JSON.parse(dims) : dims;
      captureParams.clip = {
        x: 0,
        y: 0,
        width: parsed.width,
        height: parsed.height,
        scale: 1,
      };
    }

    const result = await this.cdp<{ data: string }>(
      "Page.captureScreenshot",
      captureParams
    );
    return Buffer.from(result.data, "base64");
  }

  async pdf(options?: {
    format?: string;
    printBackground?: boolean;
    path?: string;
  }): Promise<Buffer> {
    const result = await this.cdp<{ data: string }>("Page.printToPDF", {
      printBackground: options?.printBackground ?? true,
      paperWidth: options?.format === "Letter" ? 8.5 : undefined,
      paperHeight: options?.format === "Letter" ? 11 : undefined,
    });
    return Buffer.from(result.data, "base64");
  }

  // ======================================================================
  // State
  // ======================================================================

  async close(_options?: { runBeforeUnload?: boolean }): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await fetch(
      `${this.relayUrl}/pages/${encodeURIComponent(this.pageName)}`,
      {
        method: "DELETE",
        headers: { "X-DevBrowser-Session": this.session },
      }
    );
  }

  isClosed(): boolean {
    return this._closed;
  }

  async setViewportSize(size: {
    width: number;
    height: number;
  }): Promise<void> {
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this._viewport = { ...size };
  }

  viewportSize(): { width: number; height: number } | null {
    return this._viewport;
  }

  // ======================================================================
  // Extension-mode extras (not on Page interface)
  // ======================================================================

  /** Get ARIA snapshot via the relay's /snapshot endpoint. */
  async snapshot(): Promise<string> {
    const res = await fetch(`${this.relayUrl}/snapshot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DevBrowser-Session": this.session,
      },
      body: JSON.stringify({ page: this.pageName }),
    });
    if (!res.ok) throw new Error(`Snapshot failed: ${await res.text()}`);
    const data = (await res.json()) as { snapshot: string };
    return data.snapshot;
  }

  /** Click an element by ARIA snapshot ref (e.g., "e1"). */
  async clickRef(ref: string): Promise<void> {
    await this.refAction("click", ref);
  }

  /** Fill an input by ARIA snapshot ref. */
  async fillRef(ref: string, value: string): Promise<void> {
    await this.refAction("fill", ref, value);
  }

  /** Sync the cached URL from the actual page. */
  async syncUrl(): Promise<string> {
    try {
      this._url = await this.evalValue<string>("location.href");
    } catch {
      // Page may be navigating
    }
    return this._url;
  }

  // ======================================================================
  // Private helpers
  // ======================================================================

  private async refAction(
    action: string,
    ref: string,
    value?: string
  ): Promise<void> {
    const res = await fetch(`${this.relayUrl}/ref-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DevBrowser-Session": this.session,
      },
      body: JSON.stringify({ page: this.pageName, action, ref, value }),
    });
    if (!res.ok) {
      throw new Error(
        `Ref action "${action}" on ${ref} failed: ${await res.text()}`
      );
    }
  }

  private async pollReadyState(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const state = await this.evalValue<string>("document.readyState");
        if (state === "complete") return;
      } catch {
        // Page may be mid-navigation
      }
      await delay(100);
    }
  }

  /** Resolve a CSS selector to its center coordinates. */
  async resolveElementCenter(
    selector: string
  ): Promise<{ x: number; y: number }> {
    return this.evalValue<{ x: number; y: number }>(
      elementCenterExpression(selector)
    );
  }
}

// ============================================================================
// CDPKeyboard
// ============================================================================

export class CDPKeyboard implements Keyboard {
  private page: CDPPage;
  private modifiers = 0;

  constructor(page: CDPPage) {
    this.page = page;
  }

  async down(key: string): Promise<void> {
    const def = resolveKey(key);
    this.modifiers |=
      key === "Shift" ? 8 : key === "Control" ? 2 : key === "Alt" ? 1 : key === "Meta" ? 4 : 0;

    await this.page.cdp("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: this.modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      text: def.text,
    });
  }

  async up(key: string): Promise<void> {
    const def = resolveKey(key);
    this.modifiers &=
      ~(key === "Shift" ? 8 : key === "Control" ? 2 : key === "Alt" ? 1 : key === "Meta" ? 4 : 0);

    await this.page.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: this.modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
    });
  }

  async press(key: string, options?: { delay?: number }): Promise<void> {
    const { modifiers, key: mainKey } = parseKeyCombo(key);

    // Press modifier keys
    for (const mod of modifiers) {
      await this.down(mod);
    }

    const def = resolveKey(mainKey);
    await this.page.cdp("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: this.modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      text: def.text,
    });

    if (def.text) {
      await this.page.cdp("Input.dispatchKeyEvent", {
        type: "char",
        modifiers: this.modifiers,
        key: def.key,
        code: def.code,
        text: def.text,
      });
    }

    if (options?.delay) await delay(options.delay);

    await this.page.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: this.modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
    });

    // Release modifier keys (reverse order)
    for (const mod of modifiers.reverse()) {
      await this.up(mod);
    }
  }

  async type(text: string, options?: { delay?: number }): Promise<void> {
    for (const char of text) {
      await this.press(char);
      if (options?.delay) await delay(options.delay);
    }
  }

  async insertText(text: string): Promise<void> {
    await this.page.cdp("Input.insertText", { text });
  }
}

// ============================================================================
// CDPMouse
// ============================================================================

export class CDPMouse implements Mouse {
  private page: CDPPage;
  private x = 0;
  private y = 0;

  constructor(page: CDPPage) {
    this.page = page;
  }

  async click(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void> {
    await this.move(x, y);
    await this.down({ button: options?.button, clickCount: options?.clickCount ?? 1 });
    if (options?.delay) await delay(options.delay);
    await this.up({ button: options?.button, clickCount: options?.clickCount ?? 1 });
  }

  async dblclick(
    x: number,
    y: number,
    options?: { button?: "left" | "right" | "middle"; delay?: number }
  ): Promise<void> {
    await this.move(x, y);
    await this.down({ button: options?.button, clickCount: 1 });
    await this.up({ button: options?.button, clickCount: 1 });
    if (options?.delay) await delay(options.delay);
    await this.down({ button: options?.button, clickCount: 2 });
    await this.up({ button: options?.button, clickCount: 2 });
  }

  async move(
    x: number,
    y: number,
    options?: { steps?: number }
  ): Promise<void> {
    const steps = options?.steps ?? 1;
    const fromX = this.x;
    const fromY = this.y;

    for (let i = 1; i <= steps; i++) {
      const stepX = fromX + ((x - fromX) * i) / steps;
      const stepY = fromY + ((y - fromY) * i) / steps;
      await this.page.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: stepX,
        y: stepY,
        button: "none",
      });
    }

    this.x = x;
    this.y = y;
  }

  async down(options?: {
    button?: "left" | "right" | "middle";
    clickCount?: number;
  }): Promise<void> {
    await this.page.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: this.x,
      y: this.y,
      button: options?.button ?? "left",
      buttons: 1,
      clickCount: options?.clickCount ?? 1,
    });
  }

  async up(options?: {
    button?: "left" | "right" | "middle";
    clickCount?: number;
  }): Promise<void> {
    await this.page.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: this.x,
      y: this.y,
      button: options?.button ?? "left",
      buttons: 0,
      clickCount: options?.clickCount ?? 1,
    });
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.page.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: this.x,
      y: this.y,
      deltaX,
      deltaY,
    });
  }
}

// ============================================================================
// CDPLocator
// ============================================================================

/** Locator strategy descriptor */
type LocatorStrategy =
  | { type: "css"; selector: string; testIdPattern?: RegExp }
  | { type: "role"; role: string; name?: string | RegExp; exact?: boolean }
  | { type: "text"; text: string | RegExp; exact?: boolean }
  | { type: "label"; text: string | RegExp; exact?: boolean }
  | { type: "placeholder"; text: string | RegExp; exact?: boolean };

export class CDPLocator implements Locator {
  private page: CDPPage;
  private strategy: LocatorStrategy;
  private _nth: number | undefined;

  constructor(page: CDPPage, strategy: LocatorStrategy, nth?: number) {
    this.page = page;
    this.strategy = strategy;
    this._nth = nth;
  }

  // ---- Internal: resolve to CSS selector or evaluate expression ----

  /** Build a JS expression that returns Element[] matching this locator. */
  private matchExpression(): string {
    const s = this.strategy;
    switch (s.type) {
      case "css": {
        const sel = JSON.stringify(s.selector);
        if (s.testIdPattern) {
          const pattern = s.testIdPattern.source;
          const flags = s.testIdPattern.flags;
          return `Array.from(document.querySelectorAll('[data-testid]')).filter(el => new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}).test(el.getAttribute('data-testid') || ''))`;
        }
        return `Array.from(document.querySelectorAll(${sel}))`;
      }
      case "role": {
        const roleSel = JSON.stringify(`[role="${s.role}"]`);
        if (!s.name) {
          return `Array.from(document.querySelectorAll(${roleSel}))`;
        }
        if (s.name instanceof RegExp) {
          const pattern = s.name.source;
          const flags = s.name.flags;
          return `Array.from(document.querySelectorAll(${roleSel})).filter(el => new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}).test((el.getAttribute('aria-label') || el.textContent || '').trim()))`;
        }
        const name = JSON.stringify(s.name);
        if (s.exact) {
          return `Array.from(document.querySelectorAll(${roleSel})).filter(el => (el.getAttribute('aria-label') || el.textContent || '').trim() === ${name})`;
        }
        return `Array.from(document.querySelectorAll(${roleSel})).filter(el => (el.getAttribute('aria-label') || el.textContent || '').trim().includes(${name}))`;
      }
      case "text": {
        if (s.text instanceof RegExp) {
          const pattern = s.text.source;
          const flags = s.text.flags;
          return `Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}).test(el.textContent || ''))`;
        }
        const text = JSON.stringify(s.text);
        if (s.exact) {
          return `Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && (el.textContent || '').trim() === ${text})`;
        }
        return `Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && (el.textContent || '').includes(${text}))`;
      }
      case "label": {
        if (s.text instanceof RegExp) {
          const pattern = s.text.source;
          const flags = s.text.flags;
          return `Array.from(document.querySelectorAll('label')).filter(l => new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}).test(l.textContent || '')).map(l => l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input,textarea,select')).filter(Boolean)`;
        }
        const text = JSON.stringify(s.text);
        const cmp = s.exact
          ? `(l.textContent || '').trim() === ${text}`
          : `(l.textContent || '').includes(${text})`;
        return `Array.from(document.querySelectorAll('label')).filter(l => ${cmp}).map(l => l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input,textarea,select')).filter(Boolean)`;
      }
      case "placeholder": {
        if (s.text instanceof RegExp) {
          const pattern = s.text.source;
          const flags = s.text.flags;
          return `Array.from(document.querySelectorAll('[placeholder]')).filter(el => new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}).test(el.getAttribute('placeholder') || ''))`;
        }
        const text = JSON.stringify(s.text);
        const cmp = s.exact
          ? `(el.getAttribute('placeholder') || '') === ${text}`
          : `(el.getAttribute('placeholder') || '').includes(${text})`;
        return `Array.from(document.querySelectorAll('[placeholder]')).filter(el => ${cmp})`;
      }
    }
  }

  /** Get the nth-resolved element expression. */
  private elementExpression(): string {
    const matchExpr = this.matchExpression();
    const idx = this._nth;
    if (idx === undefined || idx === 0) {
      return `(() => { const els = ${matchExpr}; if (els.length === 0) throw new Error('Locator resolved to 0 elements'); return els[0]; })()`;
    }
    if (idx === -1) {
      return `(() => { const els = ${matchExpr}; if (els.length === 0) throw new Error('Locator resolved to 0 elements'); return els[els.length - 1]; })()`;
    }
    return `(() => { const els = ${matchExpr}; if (els.length <= ${idx}) throw new Error('Locator nth(${idx}): only ' + els.length + ' elements found'); return els[${idx}]; })()`;
  }

  /** CSS selector for simple cases (used by page-level interaction methods). */
  private resolveSelector(): string | null {
    if (this.strategy.type === "css" && !this.strategy.testIdPattern && (this._nth === undefined || this._nth === 0)) {
      return this.strategy.selector;
    }
    return null;
  }

  // ---- Interaction ----

  async click(_options?: { timeout?: number }): Promise<void> {
    const sel = this.resolveSelector();
    if (sel) {
      await this.page.click(sel);
      return;
    }
    const elemExpr = this.elementExpression();
    const { x, y } = await this.page.evaluate(
      `(() => { const el = ${elemExpr}; el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`
    );
    await this.page.mouse.click(x, y);
  }

  async fill(value: string, _options?: { timeout?: number }): Promise<void> {
    const sel = this.resolveSelector();
    if (sel) {
      await this.page.fill(sel, value);
      return;
    }
    const val = JSON.stringify(value);
    await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; el.focus(); el.value = ''; el.value = ${val}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`
    );
  }

  async type(
    text: string,
    options?: { delay?: number; timeout?: number }
  ): Promise<void> {
    // Focus the element first
    await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; el.focus(); })()`
    );
    await this.page.keyboard.type(text, { delay: options?.delay });
  }

  async hover(_options?: { timeout?: number }): Promise<void> {
    const center = await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`
    );
    await this.page.mouse.move(center.x, center.y);
  }

  async check(_options?: { timeout?: number }): Promise<void> {
    await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; if (!el.checked) el.click(); })()`
    );
  }

  async uncheck(_options?: { timeout?: number }): Promise<void> {
    await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; if (el.checked) el.click(); })()`
    );
  }

  async selectOption(
    values: any,
    _options?: { timeout?: number }
  ): Promise<string[]> {
    const vals = JSON.stringify(Array.isArray(values) ? values : [values]);
    return this.page.evaluate(
      `(() => {
        const el = ${this.elementExpression()};
        const valuesToSelect = ${vals};
        const selected = [];
        for (const opt of el.options) {
          opt.selected = valuesToSelect.some(v =>
            typeof v === 'string' ? opt.value === v :
            (v.value != null && opt.value === v.value) ||
            (v.label != null && opt.label === v.label) ||
            (v.index != null && opt.index === v.index)
          );
          if (opt.selected) selected.push(opt.value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return selected;
      })()`
    );
  }

  async press(
    key: string,
    options?: { delay?: number; timeout?: number }
  ): Promise<void> {
    await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; el.focus(); })()`
    );
    await this.page.keyboard.press(key, { delay: options?.delay });
  }

  async focus(_options?: { timeout?: number }): Promise<void> {
    await this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; el.focus(); })()`
    );
  }

  // ---- Content ----

  async textContent(_options?: { timeout?: number }): Promise<string | null> {
    return this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; return el.textContent; })()`
    );
  }

  async innerText(_options?: { timeout?: number }): Promise<string> {
    return this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; return el.innerText; })()`
    );
  }

  async innerHTML(_options?: { timeout?: number }): Promise<string> {
    return this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; return el.innerHTML; })()`
    );
  }

  async getAttribute(
    name: string,
    _options?: { timeout?: number }
  ): Promise<string | null> {
    const attr = JSON.stringify(name);
    return this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; return el.getAttribute(${attr}); })()`
    );
  }

  async isVisible(_options?: { timeout?: number }): Promise<boolean> {
    try {
      return await this.page.evaluate(
        `(() => { const els = ${this.matchExpression()}; const idx = ${this._nth ?? 0}; const el = idx === -1 ? els[els.length - 1] : els[idx]; return !!(el && el.offsetParent !== null); })()`
      );
    } catch {
      return false;
    }
  }

  async isChecked(_options?: { timeout?: number }): Promise<boolean> {
    return this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; return !!el.checked; })()`
    );
  }

  async inputValue(_options?: { timeout?: number }): Promise<string> {
    return this.page.evaluate(
      `(() => { const el = ${this.elementExpression()}; return el.value ?? ''; })()`
    );
  }

  async count(): Promise<number> {
    return this.page.evaluate(
      `(() => { const els = ${this.matchExpression()}; return els.length; })()`
    );
  }

  // ---- Filtering ----

  first(): Locator {
    return new CDPLocator(this.page, this.strategy, 0);
  }

  last(): Locator {
    return new CDPLocator(this.page, this.strategy, -1);
  }

  nth(index: number): Locator {
    return new CDPLocator(this.page, this.strategy, index);
  }

  // ---- Waiting ----

  async waitFor(options?: {
    state?: "attached" | "detached" | "visible" | "hidden";
    timeout?: number;
  }): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const state = options?.state ?? "visible";
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const count = await this.page.evaluate(
        `(() => { const els = ${this.matchExpression()}; return els.length; })()`
      );

      if (state === "attached" && count > 0) return;
      if (state === "detached" && count === 0) return;

      if (state === "visible" || state === "hidden") {
        const visible = await this.isVisible();
        if (state === "visible" && visible) return;
        if (state === "hidden" && !visible) return;
      }

      await delay(100);
    }
    throw new Error(`Locator waitFor("${state}") timed out after ${timeout}ms`);
  }
}

// ============================================================================
// Utilities
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape a string for use in CSS selectors (CSS.escape polyfill for Node). */
function cssEscape(value: string): string {
  return value.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "\\$&");
}

/* eslint-enable @typescript-eslint/no-explicit-any */
