import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WXT takes the manifest version from package.json; keep it on the plugin's
// release version (satchel.yaml, generated into .claude-plugin/plugin.json).
describe("extension version", () => {
  it("matches the plugin version", () => {
    const read = (path: string) =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string };
    expect(read("../package.json").version).toBe(read("../../.claude-plugin/plugin.json").version);
  });
});
