/**
 * Structural compatibility test: Playwright's Page must satisfy our Page interface.
 *
 * This is a compile-time-only test. If it compiles, the structural typing is correct.
 * If Playwright changes their Page API in a breaking way, this test will fail at build time.
 */
import { describe, it, expect } from "vitest";
import type { Page as PlaywrightPage } from "playwright-core";
import type { Page } from "../page.js";

describe("Page structural compatibility", () => {
  it("Playwright Page satisfies our Page interface (compile-time check)", () => {
    // This assignment must compile without error.
    // It proves PlaywrightPage structurally satisfies our Page interface.
    const _check: Page = null as unknown as PlaywrightPage;

    // Runtime assertion so the test doesn't appear empty
    expect(_check).toBeNull();
  });
});
