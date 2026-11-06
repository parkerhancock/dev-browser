/**
 * Detect which Chromium browser this extension is running in.
 * Used to label the relay WebSocket connection (parity plan P1 #10b).
 */

export interface BrowserInfo {
  /** Short label: "chrome" | "msedge" | "brave" | "opera" | "vivaldi" | "chromium" | "unknown" */
  browser: string;
  version?: string;
  userAgent?: string;
}

interface NavigatorLike {
  userAgentData?: { brands?: Array<{ brand: string; version: string }> };
  userAgent?: string;
}

/** Brand strings as they appear in navigator.userAgentData.brands, most specific first. */
const BRAND_LABELS: Array<[string, string]> = [
  ["Microsoft Edge", "msedge"],
  ["Brave", "brave"],
  ["Opera", "opera"],
  ["Vivaldi", "vivaldi"],
  ["Google Chrome", "chrome"],
  ["Chromium", "chromium"],
];

export function detectBrowser(nav: NavigatorLike = navigator as NavigatorLike): BrowserInfo {
  const brands = nav.userAgentData?.brands ?? [];
  for (const [brand, label] of BRAND_LABELS) {
    const hit = brands.find((b) => b.brand === brand);
    if (hit) {
      return { browser: label, version: hit.version, userAgent: nav.userAgent };
    }
  }

  // Fallback: user-agent sniffing (userAgentData unavailable)
  const ua = nav.userAgent ?? "";
  if (/Edg\//.test(ua)) return { browser: "msedge", userAgent: ua };
  if (/OPR\//.test(ua)) return { browser: "opera", userAgent: ua };
  if (/Vivaldi\//.test(ua)) return { browser: "vivaldi", userAgent: ua };
  if (/Chrome\//.test(ua)) return { browser: "chrome", userAgent: ua };
  return { browser: "unknown", userAgent: ua };
}
