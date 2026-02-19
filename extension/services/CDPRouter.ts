/**
 * CDPRouter - Routes CDP commands to the correct tab.
 */

import type { Logger } from "../utils/logger";
import type { TabManager } from "./TabManager";
import type { ExtensionCommandMessage, TabInfo, TargetInfo } from "../utils/types";

export interface CDPRouterDeps {
  logger: Logger;
  tabManager: TabManager;
}

export class CDPRouter {
  private logger: Logger;
  private tabManager: TabManager;
  private devBrowserGroupId: number | null = null;

  constructor(deps: CDPRouterDeps) {
    this.logger = deps.logger;
    this.tabManager = deps.tabManager;
  }

  /**
   * Gets or creates the "Dev Browser" tab group, returning its ID.
   * Searches all existing tab groups first to avoid creating duplicates
   * (the in-memory cache is lost when the service worker restarts).
   */
  private async getOrCreateDevBrowserGroup(tabId: number): Promise<number> {
    // If we have a cached group ID, verify it still exists
    if (this.devBrowserGroupId !== null) {
      try {
        await chrome.tabGroups.get(this.devBrowserGroupId);
        await chrome.tabs.group({ tabIds: [tabId], groupId: this.devBrowserGroupId });
        return this.devBrowserGroupId;
      } catch {
        this.devBrowserGroupId = null;
      }
    }

    // Cache miss — search for an existing "Dev Browser" group before creating one
    const allGroups = await chrome.tabGroups.query({ title: "Dev Browser" });
    if (allGroups.length > 0) {
      const existing = allGroups[0];
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id });
      this.devBrowserGroupId = existing.id;
      return existing.id;
    }

    // No existing group found — create a new one
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: "Dev Browser",
      color: "blue",
    });
    this.devBrowserGroupId = groupId;
    return groupId;
  }

  /**
   * Attach debugger to a newly created tab with retry.
   * Chrome may not be ready for debugger attachment immediately after tab creation.
   */
  private async attachWithRetry(tabId: number, maxRetries = 5): Promise<TargetInfo> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.tabManager.attach(tabId);
      } catch (err) {
        if (attempt === maxRetries - 1) throw err;
        // Exponential backoff: 50ms, 100ms, 200ms, 400ms
        await new Promise(r => setTimeout(r, 50 * Math.pow(2, attempt)));
      }
    }
    throw new Error("unreachable");
  }

  /**
   * Handle an incoming CDP command from the relay.
   */
  async handleCommand(msg: ExtensionCommandMessage): Promise<unknown> {
    // Handle recovery commands (not CDP-forwarded)
    switch (msg.method) {
      case "getAvailableTargets":
        return this.getAvailableTargets();

      case "attachToTab":
        return this.attachToTab(msg.params.tabId);

      case "closeTab":
        await chrome.tabs.remove(msg.params.tabId);
        return { success: true };

      case "forwardCDPCommand":
        // Continue to handle CDP command below
        break;

      default:
        return;
    }

    // Type narrowed to ForwardCDPCommandMessage
    if (msg.method !== "forwardCDPCommand") return;

    let targetTabId: number | undefined;
    let targetTab: TabInfo | undefined;

    // Find target tab by sessionId
    if (msg.params.sessionId) {
      const found = this.tabManager.getBySessionId(msg.params.sessionId);
      if (found) {
        targetTabId = found.tabId;
        targetTab = found.tab;
      }
    }

    // Check child sessions (iframes, workers)
    if (!targetTab && msg.params.sessionId) {
      const parentTabId = this.tabManager.getParentTabId(msg.params.sessionId);
      if (parentTabId) {
        targetTabId = parentTabId;
        targetTab = this.tabManager.get(parentTabId);
        this.logger.debug(
          "Found parent tab for child session:",
          msg.params.sessionId,
          "tabId:",
          parentTabId
        );
      }
    }

    // Find by targetId in params
    if (
      !targetTab &&
      msg.params.params &&
      typeof msg.params.params === "object" &&
      "targetId" in msg.params.params
    ) {
      const found = this.tabManager.getByTargetId(msg.params.params.targetId as string);
      if (found) {
        targetTabId = found.tabId;
        targetTab = found.tab;
      }
    }

    const debuggee = targetTabId ? { tabId: targetTabId } : undefined;

    // Handle special commands
    switch (msg.params.method) {
      case "Runtime.enable": {
        if (!debuggee) {
          throw new Error(
            `No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`
          );
        }
        // Disable and re-enable to reset execution context state
        try {
          await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
        } catch {
          // Ignore errors — may already be disabled
        }
        return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", msg.params.params);
      }

      case "Target.createTarget": {
        const url = (msg.params.params?.url as string) || "about:blank";
        this.logger.debug("Creating new tab with URL:", url);
        const tab = await chrome.tabs.create({ url, active: false });
        if (!tab.id) throw new Error("Failed to create tab");

        // Add tab to "Dev Browser" group
        await this.getOrCreateDevBrowserGroup(tab.id);

        // Wait for tab to be ready, then attach debugger (retry on transient failures)
        const targetInfo = await this.attachWithRetry(tab.id);
        return { targetId: targetInfo.targetId, tabId: tab.id };
      }

      case "Target.closeTarget": {
        if (!targetTabId) {
          this.logger.log(`Target not found: ${msg.params.params?.targetId}`);
          return { success: false };
        }
        await chrome.tabs.remove(targetTabId);
        return { success: true };
      }

      case "Target.activateTarget": {
        if (!targetTabId) {
          this.logger.log(`Target not found for activation: ${msg.params.params?.targetId}`);
          return {};
        }
        await chrome.tabs.update(targetTabId, { active: true });
        return {};
      }
    }

    if (!debuggee || !targetTab) {
      throw new Error(
        `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId}`
      );
    }

    this.logger.debug("CDP command:", msg.params.method, "for tab:", targetTabId);

    const debuggerSession: chrome.debugger.DebuggerSession = {
      ...debuggee,
      sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : undefined,
    };

    return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params);
  }

  /**
   * Handle debugger events from Chrome.
   */
  handleDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown,
    sendMessage: (msg: unknown) => void
  ): void {
    const tab = source.tabId ? this.tabManager.get(source.tabId) : undefined;
    if (!tab) return;

    this.logger.debug("Forwarding CDP event:", method, "from tab:", source.tabId);

    // Track child sessions
    if (
      method === "Target.attachedToTarget" &&
      params &&
      typeof params === "object" &&
      "sessionId" in params
    ) {
      const sessionId = (params as { sessionId: string }).sessionId;
      this.tabManager.trackChildSession(sessionId, source.tabId!);
    }

    if (
      method === "Target.detachedFromTarget" &&
      params &&
      typeof params === "object" &&
      "sessionId" in params
    ) {
      const sessionId = (params as { sessionId: string }).sessionId;
      this.tabManager.untrackChildSession(sessionId);
    }

    sendMessage({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  }

  /**
   * Get all available tabs that can be attached to for recovery.
   */
  private async getAvailableTargets(): Promise<{
    targets: Array<{ tabId: number; targetId: string; url: string; title: string }>;
  }> {
    const tabs = await chrome.tabs.query({});
    const targets: Array<{ tabId: number; targetId: string; url: string; title: string }> = [];

    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      // Skip chrome:// and extension pages
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;

      targets.push({
        tabId: tab.id,
        targetId: `tab-${tab.id}`, // Placeholder, real targetId comes after attach
        url: tab.url,
        title: tab.title || "",
      });
    }

    this.logger.debug(`getAvailableTargets: found ${targets.length} tabs`);
    return { targets };
  }

  /**
   * Attach debugger to a specific tab for recovery.
   */
  private async attachToTab(
    tabId: number
  ): Promise<{ sessionId: string; targetInfo: { targetId: string; type: string; title: string; url: string; attached: boolean } }> {
    // Check if already attached
    const existing = this.tabManager.get(tabId);
    if (existing && existing.state === "connected" && existing.sessionId) {
      // Get current target info
      const debuggee = { tabId };
      const result = (await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")) as {
        targetInfo: { targetId: string; type: string; title: string; url: string };
      };

      this.logger.debug(`attachToTab: already attached to tab ${tabId}`);
      return {
        sessionId: existing.sessionId,
        targetInfo: { ...result.targetInfo, attached: true },
      };
    }

    // Attach to tab
    this.logger.debug(`attachToTab: attaching to tab ${tabId}`);
    const targetInfo = await this.tabManager.attach(tabId);
    const tab = this.tabManager.get(tabId);

    if (!tab || !tab.sessionId) {
      throw new Error(`Failed to attach to tab ${tabId}`);
    }

    return {
      sessionId: tab.sessionId,
      targetInfo: { ...targetInfo, attached: true },
    };
  }
}
