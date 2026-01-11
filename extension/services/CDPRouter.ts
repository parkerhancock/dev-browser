/**
 * CDPRouter - Routes CDP commands to the correct tab.
 *
 * Integrates with SessionManager for tab group-based isolation.
 */

import type { Logger } from "../utils/logger";
import type { TabManager } from "./TabManager";
import type { SessionManager } from "./SessionManager";
import type { ExtensionCommandMessage, TabInfo } from "../utils/types";

export interface CDPRouterDeps {
  logger: Logger;
  tabManager: TabManager;
  sessionManager: SessionManager;
}

export class CDPRouter {
  private logger: Logger;
  private tabManager: TabManager;
  private sessionManager: SessionManager;

  constructor(deps: CDPRouterDeps) {
    this.logger = deps.logger;
    this.tabManager = deps.tabManager;
    this.sessionManager = deps.sessionManager;
  }

  /**
   * Handle an incoming command from the relay.
   */
  async handleCommand(msg: ExtensionCommandMessage): Promise<unknown> {
    switch (msg.method) {
      case "getOrCreateSession":
        return this.handleGetOrCreateSession(msg.params.sessionId);

      case "closeSession":
        return this.handleCloseSession(msg.params.sessionId);

      case "getSessionTabs":
        return this.handleGetSessionTabs(msg.params.sessionId);

      case "createTab":
        return this.handleCreateTab(msg.params.sessionId, msg.params.url);

      case "forwardCDPCommand":
        return this.handleCDPCommand(msg);

      default:
        throw new Error(`Unknown method: ${(msg as { method: string }).method}`);
    }
  }

  /**
   * Get or create a session and its tab group.
   */
  private async handleGetOrCreateSession(
    sessionId: string
  ): Promise<{ groupId: number; groupName: string; tabs: Array<{ tabId: number; url: string }> }> {
    const { groupId, groupName } = await this.sessionManager.getOrCreateGroup(sessionId);

    // Get existing tabs in the group
    const tabs = await this.sessionManager.getTabsForSession(sessionId);
    const tabInfos = tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({ tabId: t.id!, url: t.url || "" }));

    this.logger.log(`Session ${sessionId}: group "${groupName}" with ${tabInfos.length} tabs`);
    return { groupId, groupName, tabs: tabInfos };
  }

  /**
   * Close a session and all its tabs.
   */
  private async handleCloseSession(sessionId: string): Promise<{ success: boolean }> {
    await this.sessionManager.closeSession(sessionId);
    return { success: true };
  }

  /**
   * Get all tabs in a session.
   */
  private async handleGetSessionTabs(
    sessionId: string
  ): Promise<{ tabs: Array<{ tabId: number; url: string; targetId?: string; cdpSessionId?: string }> }> {
    const tabs = await this.sessionManager.getTabsForSession(sessionId);
    const result = [];

    for (const tab of tabs) {
      if (!tab.id) continue;

      const tabInfo = this.tabManager.get(tab.id);
      result.push({
        tabId: tab.id,
        url: tab.url || "",
        targetId: tabInfo?.targetId,
        cdpSessionId: tabInfo?.sessionId,
      });
    }

    return { tabs: result };
  }

  /**
   * Create a new tab in a session's group.
   */
  private async handleCreateTab(
    sessionId: string,
    url?: string
  ): Promise<{ tabId: number; targetId: string; cdpSessionId: string }> {
    const targetUrl = url || "about:blank";
    this.logger.debug(`Creating tab for session ${sessionId}: ${targetUrl}`);

    // Create the tab
    const tab = await chrome.tabs.create({ url: targetUrl, active: false });
    if (!tab.id) throw new Error("Failed to create tab");

    // Add to session's group
    await this.sessionManager.addTabToSession(tab.id, sessionId);

    // Small delay for tab to initialize
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Attach debugger
    const targetInfo = await this.tabManager.attach(tab.id);

    const tabInfo = this.tabManager.get(tab.id);
    if (!tabInfo?.sessionId) {
      throw new Error("Failed to get CDP session after attach");
    }

    return {
      tabId: tab.id,
      targetId: targetInfo.targetId,
      cdpSessionId: tabInfo.sessionId,
    };
  }

  /**
   * Handle CDP command forwarding.
   */
  private async handleCDPCommand(msg: ExtensionCommandMessage): Promise<unknown> {
    if (msg.method !== "forwardCDPCommand") return;

    let targetTabId: number | undefined;
    let targetTab: TabInfo | undefined;

    // Find target tab by CDP sessionId
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

    // Handle special CDP commands
    switch (msg.params.method) {
      case "Runtime.enable": {
        if (!debuggee) {
          throw new Error(
            `No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`
          );
        }
        // Disable and re-enable to reset state
        try {
          await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch {
          // Ignore errors
        }
        return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", msg.params.params);
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
   * Returns the agent session ID that should receive this event.
   */
  async handleDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown,
    sendMessage: (msg: unknown, agentSession?: string) => void
  ): Promise<void> {
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

    // Get the agent session that owns this tab (via group membership)
    const agentSession = source.tabId
      ? await this.sessionManager.getSessionForTab(source.tabId)
      : null;

    sendMessage(
      {
        method: "forwardCDPEvent",
        params: {
          sessionId: source.sessionId || tab.sessionId,
          method,
          params,
        },
      },
      agentSession || undefined
    );
  }
}
