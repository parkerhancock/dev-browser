/**
 * TabManager - Manages tab state and debugger attachment.
 */

import type { TabInfo, TargetInfo } from "../utils/types";
import type { Logger } from "../utils/logger";

export type SendMessageFn = (message: unknown) => void;

export interface TabManagerDeps {
  logger: Logger;
  sendMessage: SendMessageFn;
}

// Random prefix per service worker lifetime to prevent session ID collisions across restarts
const SESSION_PREFIX = Math.random().toString(36).slice(2, 6);

// Stealth script injected into every new page before navigation.
// Masks CDP debugger fingerprints that sites use to detect automation.
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', {
    configurable: true,
    get: () => undefined,
  });
`;

export class TabManager {
  private tabs = new Map<number, TabInfo>();
  private childSessions = new Map<string, number>(); // sessionId -> parentTabId
  private attachingTabs = new Set<number>(); // Guard against concurrent attach
  private reattaches = new Map<number, number[]>(); // tabId -> recent reattach times
  private nextSessionId = 1;
  private logger: Logger;
  private sendMessage: SendMessageFn;

  constructor(deps: TabManagerDeps) {
    this.logger = deps.logger;
    this.sendMessage = deps.sendMessage;
  }

  /**
   * Get tab info by session ID.
   */
  getBySessionId(sessionId: string): { tabId: number; tab: TabInfo } | undefined {
    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId === sessionId) {
        return { tabId, tab };
      }
    }
    return undefined;
  }

  /**
   * Get tab info by target ID.
   */
  getByTargetId(targetId: string): { tabId: number; tab: TabInfo } | undefined {
    for (const [tabId, tab] of this.tabs) {
      if (tab.targetId === targetId) {
        return { tabId, tab };
      }
    }
    return undefined;
  }

  /**
   * Get parent tab ID for a child session (iframe, worker).
   */
  getParentTabId(sessionId: string): number | undefined {
    return this.childSessions.get(sessionId);
  }

  /**
   * Get tab info by tab ID.
   */
  get(tabId: number): TabInfo | undefined {
    return this.tabs.get(tabId);
  }

  /**
   * Check if a tab is tracked.
   */
  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  /**
   * Set tab info (used for intermediate states like "connecting").
   */
  set(tabId: number, info: TabInfo): void {
    this.tabs.set(tabId, info);
  }

  /**
   * Track a child session (iframe, worker).
   */
  trackChildSession(sessionId: string, parentTabId: number): void {
    this.logger.debug("Child target attached:", sessionId, "for tab:", parentTabId);
    this.childSessions.set(sessionId, parentTabId);
  }

  /**
   * Untrack a child session.
   */
  untrackChildSession(sessionId: string): void {
    this.logger.debug("Child target detached:", sessionId);
    this.childSessions.delete(sessionId);
  }

  /**
   * Attach debugger to a tab and register it.
   */
  async attach(tabId: number): Promise<TargetInfo> {
    if (this.attachingTabs.has(tabId)) {
      throw new Error(`Already attaching to tab ${tabId}`);
    }
    this.attachingTabs.add(tabId);

    const debuggee = { tabId };

    try {
      this.logger.debug("Attaching debugger to tab:", tabId);
      await chrome.debugger.attach(debuggee, "1.3");

      const result = (await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")) as {
        targetInfo: TargetInfo;
      };

      const targetInfo = result.targetInfo;
      const sessionId = `pw-${SESSION_PREFIX}-tab-${this.nextSessionId++}`;

      this.tabs.set(tabId, {
        sessionId,
        targetId: targetInfo.targetId,
        state: "connected",
      });

      // Enable essential CDP domains so events will fire
      // These must be enabled before Playwright connects, otherwise
      // navigation events that happen during connection setup are lost
      try {
        await chrome.debugger.sendCommand(debuggee, "Page.enable");
        await chrome.debugger.sendCommand(debuggee, "Network.enable");
        await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
        this.logger.debug("CDP domains enabled for tab:", tabId);
      } catch (err) {
        this.logger.debug("Error enabling CDP domains:", err);
        // Continue anyway - Playwright will enable them
      }

      // Inject stealth overrides before any navigation occurs.
      // Sites like X.com detect CDP debugger attachment and degrade
      // functionality (e.g., refusing to render React or blocking API calls).
      try {
        await chrome.debugger.sendCommand(debuggee, "Page.addScriptToEvaluateOnNewDocument", {
          source: STEALTH_SCRIPT,
        });
        this.logger.debug("Stealth script injected for tab:", tabId);
      } catch (err) {
        this.logger.debug("Error injecting stealth script:", err);
      }

      // Notify relay of new target
      this.sendMessage({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: { ...targetInfo, browserContextId: "default", attached: true },
            waitingForDebugger: false,
          },
        },
      });

      this.logger.log("Tab attached:", tabId, "sessionId:", sessionId, "url:", targetInfo.url);
      return targetInfo;
    } finally {
      this.attachingTabs.delete(tabId);
    }
  }

  /**
   * Remove a tab and its child sessions from tracking, notifying the relay.
   */
  private removeTab(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    this.sendMessage({
      method: "forwardCDPEvent",
      params: {
        method: "Target.detachedFromTarget",
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    });

    this.tabs.delete(tabId);

    for (const [childSessionId, parentTabId] of this.childSessions) {
      if (parentTabId === tabId) {
        this.childSessions.delete(childSessionId);
      }
    }
  }

  /**
   * Detach a tab and clean up.
   */
  detach(tabId: number, shouldDetachDebugger: boolean): void {
    this.logger.debug("Detaching tab:", tabId);
    this.removeTab(tabId);

    if (shouldDetachDebugger) {
      chrome.debugger.detach({ tabId }).catch((err) => {
        this.logger.debug("Error detaching debugger:", err);
      });
    }
  }

  /**
   * Handle debugger detach event from Chrome.
   */
  async handleDebuggerDetach(tabId: number, reason?: string): Promise<void> {
    const wasTracked = this.tabs.has(tabId);
    this.removeTab(tabId);

    // Chrome also reports target_closed when it drops the debugger from a tab
    // that stays open, for example after another extension (a password
    // manager's inline menu) injects a frame into the page. Reattach, and the
    // relay hands the named page to the new session (it waits 500 ms for one).
    if (!wasTracked || reason !== "target_closed" || !this.mayReattach(tabId)) return;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return; // The tab really closed
    }
    try {
      await this.attach(tabId);
      this.logger.log("Reattached debugger to tab:", tabId);
    } catch (err) {
      this.logger.debug("Could not reattach debugger to tab:", tabId, err);
    }
  }

  /** At most three reattaches per tab in 30 s, so a page that keeps evicting the debugger can't loop. */
  private mayReattach(tabId: number): boolean {
    const now = Date.now();
    const recent = (this.reattaches.get(tabId) ?? []).filter((t) => now - t < 30000);
    if (recent.length >= 3) return false;
    recent.push(now);
    this.reattaches.set(tabId, recent);
    return true;
  }

  /**
   * Clear all tabs and child sessions.
   */
  clear(): void {
    this.tabs.clear();
    this.childSessions.clear();
  }

  /**
   * Detach all tabs (used on disconnect).
   */
  detachAll(): void {
    for (const tabId of this.tabs.keys()) {
      chrome.debugger.detach({ tabId }).catch(() => {});
    }
    this.clear();
  }

  /**
   * Get all tab IDs.
   */
  getAllTabIds(): number[] {
    return Array.from(this.tabs.keys());
  }
}
