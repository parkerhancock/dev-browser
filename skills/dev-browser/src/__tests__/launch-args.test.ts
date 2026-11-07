import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { DISABLED_FEATURES, stealthLaunchArgs } from "../launch-args.js";

// chromiumSwitches isn't a public export; load it relative to the package entry
const require = createRequire(createRequire(import.meta.url).resolve("patchright-core"));
const { chromiumSwitches } = require("./lib/server/chromium/chromiumSwitches.js") as {
  chromiumSwitches: (assistantMode?: boolean) => string[];
};

describe("launch args", () => {
  test("keep Playwright's disabled features except storage partitioning", () => {
    const defaults = chromiumSwitches(false)
      .find((arg) => arg.startsWith("--disable-features="))!
      .slice("--disable-features=".length)
      .split(",");
    expect(DISABLED_FEATURES).toEqual(defaults.filter((f) => f !== "ThirdPartyStoragePartitioning"));
  });

  test("headless launches use Chrome's new headless mode", () => {
    expect(stealthLaunchArgs(true)).toContain("--headless=new");
    expect(stealthLaunchArgs(false)).not.toContain("--headless=new");
  });
});
