import { describe, test, expect } from "vitest";
import { detectBrowser } from "../utils/browser-info";

describe("detectBrowser", () => {
  test("identifies Edge from userAgentData brands", () => {
    const info = detectBrowser({
      userAgentData: {
        brands: [
          { brand: "Chromium", version: "131" },
          { brand: "Microsoft Edge", version: "131" },
          { brand: "Not_A Brand", version: "24" },
        ],
      },
      userAgent: "ua",
    });
    expect(info.browser).toBe("msedge");
    expect(info.version).toBe("131");
  });

  test("identifies Brave ahead of Chrome", () => {
    const info = detectBrowser({
      userAgentData: {
        brands: [
          { brand: "Brave", version: "131" },
          { brand: "Chromium", version: "131" },
          { brand: "Google Chrome", version: "131" },
        ],
      },
    });
    expect(info.browser).toBe("brave");
  });

  test("identifies Chrome from brands", () => {
    const info = detectBrowser({
      userAgentData: {
        brands: [
          { brand: "Google Chrome", version: "131" },
          { brand: "Chromium", version: "131" },
        ],
      },
    });
    expect(info.browser).toBe("chrome");
  });

  test("falls back to user-agent sniffing", () => {
    expect(detectBrowser({ userAgent: "Mozilla/5.0 Chrome/131.0.0.0 Edg/131.0.0.0" }).browser).toBe(
      "msedge"
    );
    expect(detectBrowser({ userAgent: "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" }).browser).toBe(
      "chrome"
    );
    expect(detectBrowser({ userAgent: "SomethingElse/1.0" }).browser).toBe("unknown");
  });
});
