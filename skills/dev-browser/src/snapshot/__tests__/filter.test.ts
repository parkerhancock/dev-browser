import { describe, expect, test } from "vitest";
import { filterSnapshot } from "../filter";

const SNAPSHOT = `- generic [active] [ref=e1]:
  - navigation [ref=e2]:
    - link "A link" [ref=e3] [cursor=pointer]:
      - /url: /a
  - main [ref=e4]:
    - heading "Title" [level=1] [ref=e5]
    - generic [ref=e6]:
      - textbox "Email" [ref=e8]
      - combobox [ref=e9]:
        - option "One" [selected] [ref=e10]
      - button "Go" [ref=e13]`;

describe("filterSnapshot", () => {
  test("returns everything by default", () => {
    expect(filterSnapshot(SNAPSHOT)).toBe(SNAPSHOT);
  });

  test("keeps one subtree, re-indented", () => {
    expect(filterSnapshot(SNAPSHOT, { refId: "e2" })).toBe(
      `- navigation [ref=e2]:\n  - link "A link" [ref=e3] [cursor=pointer]:\n    - /url: /a`
    );
    expect(() => filterSnapshot(SNAPSHOT, { refId: "e99" })).toThrow(/not found/);
  });

  test("limits depth", () => {
    expect(filterSnapshot(SNAPSHOT, { depth: 2 }).split("\n")).toEqual([
      "- generic [active] [ref=e1]:",
      "  - navigation [ref=e2]:",
      "  - main [ref=e4]:",
    ]);
  });

  test("lists only interactive elements, flattened", () => {
    expect(filterSnapshot(SNAPSHOT, { filter: "interactive" }).split("\n")).toEqual([
      '- link "A link" [ref=e3] [cursor=pointer]',
      '- textbox "Email" [ref=e8]',
      "- combobox [ref=e9]",
      '- option "One" [selected] [ref=e10]',
      '- button "Go" [ref=e13]',
    ]);
  });

  test("truncates to maxChars", () => {
    expect(filterSnapshot(SNAPSHOT, { maxChars: 10 })).toMatch(/^- generic \n\n\[truncated: \d+ chars total\]$/);
  });
});
