/**
 * Launch settings that keep a headless standalone browser from looking automated.
 *
 * Patchright removes the CDP leaks (Runtime.enable, the automation flags). The
 * rest is launch configuration, measured against bot-detector.rebrowser.net:
 *
 * - Run Chrome's full "new" headless mode by passing --headless=new ourselves
 *   with Playwright's headless option off. Playwright's own headless mode uses
 *   the separate headless shell for bundled Chromium, which detectors spot.
 * - Re-enable third-party storage partitioning. Playwright disables it, and a
 *   browser without it no longer matches any real Chrome.
 * - Keep two switches Playwright adds in its own headless mode: report a mouse
 *   (Linux without a display otherwise reports no pointer) and mute audio.
 *
 * The user agent and viewport are set at the call site.
 */

/**
 * Playwright's default --disable-features list (chromiumSwitches.js in
 * patchright-core 1.57.0) minus ThirdPartyStoragePartitioning. Chrome honors
 * only the last --disable-features switch, so passing this list replaces the
 * default. A test checks it against the installed patchright-core.
 */
export const DISABLED_FEATURES = [
  "AcceptCHFrame",
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "Translate",
  "AutoDeElevate",
  "RenderDocument",
  "OptimizationHints",
];

/** A common laptop size; Playwright's 1280x720 default is a known tell. */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/** Extra Chrome switches. Pair headless launches with Playwright's headless: false. */
export function stealthLaunchArgs(headless: boolean): string[] {
  const args = [`--disable-features=${DISABLED_FEATURES.join(",")}`];
  if (headless) {
    args.push(
      "--headless=new",
      "--mute-audio",
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"
    );
  }
  return args;
}
