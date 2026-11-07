/**
 * Device emulation for resize_window: viewport presets, a phone or tablet
 * (mobile layout, touch, an Android user agent), and the color scheme.
 *
 * Emulation overrides live on a CDP session and end when it detaches, so the
 * client keeps one session per page while emulating (extension mode's relay
 * session already persists).
 */

export interface EmulateOptions {
  width?: number;
  height?: number;
  /** Emulate a touch phone or tablet: mobile layout, touch points, Android UA. */
  mobile?: boolean;
  colorScheme?: "light" | "dark";
}

export const PRESETS = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
} as const;

export interface CdpOp {
  method: string;
  params: Record<string, unknown>;
}

/** What the page reports about its own browser, read before emulating. */
export interface BrowserIdentity {
  userAgent: string;
  brands: { brand: string; version: string }[];
}

export const BROWSER_IDENTITY_SCRIPT = `({
  userAgent: navigator.userAgent,
  brands: (navigator.userAgentData && navigator.userAgentData.brands) || [],
})`;

/** The same Chrome version on an Android phone. */
export function androidUserAgent(desktopUserAgent: string): string {
  const version = /Chrome\/(\d+)/.exec(desktopUserAgent)?.[1] ?? "143";
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
}

/** CDP commands that turn the page into a touch phone/tablet of this size. */
export function mobileOps(identity: BrowserIdentity, width: number, height: number): CdpOp[] {
  return [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: { width, height, deviceScaleFactor: 3, mobile: true },
    },
    { method: "Emulation.setTouchEmulationEnabled", params: { enabled: true, maxTouchPoints: 5 } },
    {
      method: "Emulation.setUserAgentOverride",
      params: {
        userAgent: androidUserAgent(identity.userAgent),
        userAgentMetadata: {
          brands: identity.brands,
          platform: "Android",
          platformVersion: "10.0.0",
          architecture: "",
          model: "K",
          mobile: true,
        },
      },
    },
  ];
}

/** CDP commands that undo mobileOps. */
export const CLEAR_MOBILE_OPS: CdpOp[] = [
  { method: "Emulation.clearDeviceMetricsOverride", params: {} },
  { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
  { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
];

export function colorSchemeOp(colorScheme: "light" | "dark"): CdpOp {
  return {
    method: "Emulation.setEmulatedMedia",
    params: { features: [{ name: "prefers-color-scheme", value: colorScheme }] },
  };
}
