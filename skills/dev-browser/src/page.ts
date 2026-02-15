/**
 * Unified Page interface — a Playwright-compatible subset.
 *
 * Standalone mode: Playwright's real Page satisfies this structurally.
 * Extension mode: CDPPage implements this via HTTP RPC to the relay.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Page {
  // ---- Navigation ----
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<any>;
  goBack(options?: { timeout?: number; waitUntil?: string }): Promise<any>;
  goForward(options?: { timeout?: number; waitUntil?: string }): Promise<any>;
  reload(options?: { timeout?: number; waitUntil?: string }): Promise<any>;

  // ---- Content ----
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  setContent(html: string, options?: { timeout?: number; waitUntil?: string }): Promise<void>;
  innerHTML(selector: string, options?: { timeout?: number }): Promise<string>;
  innerText(selector: string, options?: { timeout?: number }): Promise<string>;
  textContent(selector: string, options?: { timeout?: number }): Promise<string | null>;

  // ---- Evaluation ----
  evaluate<R = any>(
    pageFunction: string | ((...args: any[]) => R | Promise<R>),
    ...args: any[]
  ): Promise<R>;
  evaluateHandle(
    pageFunction: string | ((...args: any[]) => any),
    ...args: any[]
  ): Promise<any>;

  // ---- Interaction ----
  click(selector: string, options?: { timeout?: number; button?: "left" | "right" | "middle"; clickCount?: number; delay?: number }): Promise<void>;
  dblclick(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  hover(selector: string, options?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, values: any, options?: { timeout?: number }): Promise<string[]>;
  check(selector: string, options?: { timeout?: number }): Promise<void>;
  uncheck(selector: string, options?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  focus(selector: string, options?: { timeout?: number }): Promise<void>;

  // ---- Locators ----
  locator(selector: string): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByTestId(testId: string | RegExp): Locator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): Locator;

  // ---- Waiting ----
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<any>;
  waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle", options?: { timeout?: number }): Promise<void>;
  waitForFunction(pageFunction: string | ((...args: any[]) => any), arg?: any, options?: { timeout?: number; polling?: number }): Promise<any>;
  waitForTimeout(timeout: number): Promise<void>;
  waitForURL(url: string | RegExp | ((url: URL) => boolean), options?: { timeout?: number }): Promise<void>;

  // ---- Input Devices ----
  keyboard: Keyboard;
  mouse: Mouse;

  // ---- Screenshots / PDF ----
  screenshot(options?: {
    fullPage?: boolean;
    type?: "png" | "jpeg";
    path?: string;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer>;
  pdf(options?: {
    format?: string;
    printBackground?: boolean;
    path?: string;
  }): Promise<Buffer>;

  // ---- State ----
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
  isClosed(): boolean;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  viewportSize(): { width: number; height: number } | null;
}

export interface Locator {
  // ---- Interaction ----
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  type(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  hover(options?: { timeout?: number }): Promise<void>;
  check(options?: { timeout?: number }): Promise<void>;
  uncheck(options?: { timeout?: number }): Promise<void>;
  selectOption(values: any, options?: { timeout?: number }): Promise<string[]>;
  press(key: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  focus(options?: { timeout?: number }): Promise<void>;

  // ---- Content ----
  textContent(options?: { timeout?: number }): Promise<string | null>;
  innerText(options?: { timeout?: number }): Promise<string>;
  innerHTML(options?: { timeout?: number }): Promise<string>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  isChecked(options?: { timeout?: number }): Promise<boolean>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  count(): Promise<number>;

  // ---- Filtering ----
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;

  // ---- Waiting ----
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void>;
}

export interface Keyboard {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  press(key: string, options?: { delay?: number }): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
  insertText(text: string): Promise<void>;
}

export interface Mouse {
  click(x: number, y: number, options?: { button?: "left" | "right" | "middle"; clickCount?: number; delay?: number }): Promise<void>;
  dblclick(x: number, y: number, options?: { button?: "left" | "right" | "middle"; delay?: number }): Promise<void>;
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  down(options?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void>;
  up(options?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
