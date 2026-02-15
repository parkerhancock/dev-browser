import { describe, it, expect } from "vitest";
import {
  resolveKey,
  parseKeyCombo,
  computeModifiers,
  elementCenterExpression,
  mouseButton,
} from "../cdp-helpers.js";

// ============================================================================
// resolveKey
// ============================================================================

describe("resolveKey", () => {
  it("resolves named navigation keys", () => {
    expect(resolveKey("Enter")).toEqual({
      key: "Enter", code: "Enter", keyCode: 13, text: "\r",
    });
    expect(resolveKey("Tab")).toEqual({
      key: "Tab", code: "Tab", keyCode: 9, text: "",
    });
    expect(resolveKey("Backspace")).toEqual({
      key: "Backspace", code: "Backspace", keyCode: 8, text: "",
    });
    expect(resolveKey("Delete")).toEqual({
      key: "Delete", code: "Delete", keyCode: 46, text: "",
    });
    expect(resolveKey("Escape")).toEqual({
      key: "Escape", code: "Escape", keyCode: 27, text: "",
    });
    expect(resolveKey("Space")).toEqual({
      key: " ", code: "Space", keyCode: 32, text: " ",
    });
  });

  it("resolves arrow keys", () => {
    expect(resolveKey("ArrowUp").keyCode).toBe(38);
    expect(resolveKey("ArrowDown").keyCode).toBe(40);
    expect(resolveKey("ArrowLeft").keyCode).toBe(37);
    expect(resolveKey("ArrowRight").keyCode).toBe(39);
  });

  it("resolves modifier keys with Left code variant", () => {
    expect(resolveKey("Control")).toMatchObject({ code: "ControlLeft", keyCode: 17 });
    expect(resolveKey("Shift")).toMatchObject({ code: "ShiftLeft", keyCode: 16 });
    expect(resolveKey("Alt")).toMatchObject({ code: "AltLeft", keyCode: 18 });
    expect(resolveKey("Meta")).toMatchObject({ code: "MetaLeft", keyCode: 91 });
  });

  it("resolves function keys F1-F12", () => {
    expect(resolveKey("F1")).toMatchObject({ code: "F1", keyCode: 112 });
    expect(resolveKey("F12")).toMatchObject({ code: "F12", keyCode: 123 });
  });

  it("resolves lowercase letters with KeyX code", () => {
    const a = resolveKey("a");
    expect(a).toEqual({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    const z = resolveKey("z");
    expect(z).toEqual({ key: "z", code: "KeyZ", keyCode: 90, text: "z" });
  });

  it("resolves uppercase letters with same keyCode as lowercase", () => {
    const A = resolveKey("A");
    expect(A).toEqual({ key: "A", code: "KeyA", keyCode: 65, text: "A" });
  });

  it("resolves digits with DigitN code", () => {
    expect(resolveKey("0")).toEqual({ key: "0", code: "Digit0", keyCode: 48, text: "0" });
    expect(resolveKey("9")).toEqual({ key: "9", code: "Digit9", keyCode: 57, text: "9" });
  });

  it("resolves punctuation as single-char fallback", () => {
    const dot = resolveKey(".");
    expect(dot.key).toBe(".");
    expect(dot.text).toBe(".");
    expect(dot.code).toBe(""); // no named code for punctuation
  });

  it("passes through unknown multi-char key names", () => {
    const unknown = resolveKey("SomeUnknownKey");
    expect(unknown).toEqual({
      key: "SomeUnknownKey", code: "SomeUnknownKey", keyCode: 0, text: "",
    });
  });

  it("resolves page navigation keys", () => {
    expect(resolveKey("Home").keyCode).toBe(36);
    expect(resolveKey("End").keyCode).toBe(35);
    expect(resolveKey("PageUp").keyCode).toBe(33);
    expect(resolveKey("PageDown").keyCode).toBe(34);
    expect(resolveKey("Insert").keyCode).toBe(45);
  });
});

// ============================================================================
// parseKeyCombo
// ============================================================================

describe("parseKeyCombo", () => {
  it("parses a simple key", () => {
    expect(parseKeyCombo("Enter")).toEqual({ modifiers: [], key: "Enter" });
  });

  it("parses single modifier + key", () => {
    expect(parseKeyCombo("Control+a")).toEqual({
      modifiers: ["Control"], key: "a",
    });
  });

  it("parses multiple modifiers + key", () => {
    expect(parseKeyCombo("Control+Shift+a")).toEqual({
      modifiers: ["Control", "Shift"], key: "a",
    });
  });

  it("parses triple modifier combo", () => {
    expect(parseKeyCombo("Control+Alt+Delete")).toEqual({
      modifiers: ["Control", "Alt"], key: "Delete",
    });
  });
});

// ============================================================================
// computeModifiers
// ============================================================================

describe("computeModifiers", () => {
  it("returns 0 for no modifiers", () => {
    expect(computeModifiers([])).toBe(0);
  });

  it("returns correct bitmask for individual modifiers", () => {
    expect(computeModifiers(["Alt"])).toBe(1);
    expect(computeModifiers(["Control"])).toBe(2);
    expect(computeModifiers(["Meta"])).toBe(4);
    expect(computeModifiers(["Shift"])).toBe(8);
  });

  it("combines modifier bits with OR", () => {
    expect(computeModifiers(["Control", "Shift"])).toBe(2 | 8);
    expect(computeModifiers(["Alt", "Control", "Meta", "Shift"])).toBe(15);
  });

  it("ignores unknown modifier names", () => {
    expect(computeModifiers(["Unknown"])).toBe(0);
    expect(computeModifiers(["Control", "Unknown"])).toBe(2);
  });
});

// ============================================================================
// elementCenterExpression
// ============================================================================

describe("elementCenterExpression", () => {
  it("generates JS with querySelector, scrollIntoView, and getBoundingClientRect", () => {
    const expr = elementCenterExpression("button.submit");
    expect(expr).toContain("document.querySelector");
    expect(expr).toContain("button.submit");
    expect(expr).toContain("scrollIntoView");
    expect(expr).toContain("getBoundingClientRect");
    expect(expr).toContain("rect.x + rect.width / 2");
    expect(expr).toContain("rect.y + rect.height / 2");
  });

  it("properly JSON-escapes the selector", () => {
    const expr = elementCenterExpression('[data-testid="foo"]');
    // The selector should be inside a JSON.stringify'd string
    expect(expr).toContain('[data-testid=\\"foo\\"]');
  });

  it("throws expression includes error message with selector", () => {
    const expr = elementCenterExpression(".missing");
    expect(expr).toContain("Element not found");
    expect(expr).toContain(".missing");
  });
});

// ============================================================================
// mouseButton
// ============================================================================

describe("mouseButton", () => {
  it("maps button names to CDP button numbers", () => {
    expect(mouseButton("left")).toBe(0);
    expect(mouseButton("middle")).toBe(1);
    expect(mouseButton("right")).toBe(2);
  });

  it("defaults to left (0) when undefined", () => {
    expect(mouseButton()).toBe(0);
    expect(mouseButton(undefined)).toBe(0);
  });
});
