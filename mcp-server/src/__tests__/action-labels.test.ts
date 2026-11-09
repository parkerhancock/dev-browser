import { describe, expect, test } from "vitest";
import { describeAction } from "../action-labels.js";

describe("describeAction", () => {
  test.each([
    ["navigate", { url: "https://example.com/a" }, "Go to example.com/a"],
    ["navigate", { url: "back" }, "Go back"],
    ["computer", { action: "left_click", ref: "e4" }, "Click e4"],
    ["computer", { action: "left_click", coordinate: [1, 2] }, "Click"],
    ["computer", { action: "type", text: "hello" }, 'Type "hello"'],
    ["computer", { action: "key", text: "Tab", repeat: 3 }, "Press Tab x3"],
    ["computer", { action: "scroll", scroll_direction: "up" }, "Scroll up"],
    ["computer", { action: "left_click_drag" }, "Drag"],
    ["form_input", { ref: "e9", value: "secret" }, "Set e9"],
    ["form_input", { fields: { "#a": "1", "#b": "2" } }, "Fill 2 fields"],
    ["file_upload", { files: ["/tmp/x/report.pdf"] }, "Upload report.pdf"],
    ["resize_window", { preset: "mobile", color_scheme: "dark" }, "Resize to mobile, dark mode"],
    ["javascript", { code: "1" }, "Run JavaScript"],
  ])("%s %j → %s", (tool, args, label) => {
    expect(describeAction(tool, args)).toBe(label);
  });

  test("leaves form values out of labels", () => {
    expect(describeAction("form_input", { ref: "e9", value: "hunter2" })).not.toContain("hunter2");
  });

  test("returns nothing for tools that don't act", () => {
    expect(describeAction("read_page", {})).toBeUndefined();
    expect(describeAction("computer", { action: "screenshot" })).toBeUndefined();
  });
});
