/**
 * CDPRouter - Routes CDP commands to the correct tab.
 */

import type { Logger } from "../utils/logger";
import type { TabManager } from "./TabManager";
import type { ExtensionCommandMessage, TabInfo, TargetInfo } from "../utils/types";

/** The tab group a new tab joins: one per agent session. */
export interface TabGroupSpec {
  key: string;
  title: string;
}

/** Tabs created without a session (older relays) share one group. */
const DEFAULT_GROUP: TabGroupSpec = { key: "default", title: "Dev Browser" };

type GroupColor = `${chrome.tabGroups.Color}`;

const GROUP_COLORS: GroupColor[] = [
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

/** A stable color per session, so neighboring sessions' groups look different. */
export function groupColor(key: string): GroupColor {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length]!;
}

function parseGroupSpec(value: unknown): TabGroupSpec {
  const spec = value as Partial<TabGroupSpec> | undefined;
  return typeof spec?.key === "string" && typeof spec.title === "string" && spec.title
    ? { key: spec.key, title: spec.title }
    : DEFAULT_GROUP;
}

export interface CDPRouterDeps {
  logger: Logger;
  tabManager: TabManager;
}

export class CDPRouter {
  private logger: Logger;
  private tabManager: TabManager;
  private groupIds = new Map<string, number>(); // session key -> tab group id
  private groupOperations = new Map<string, Promise<void>>();

  constructor(deps: CDPRouterDeps) {
    this.logger = deps.logger;
    this.tabManager = deps.tabManager;
  }

  private async runGroupOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.groupOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined
    );

    this.groupOperations.set(key, settled);
    settled.finally(() => {
      if (this.groupOperations.get(key) === settled) {
        this.groupOperations.delete(key);
      }
    });

    return current;
  }

  /** The session's existing tab group, if it still exists. */
  private async findGroup(spec: TabGroupSpec): Promise<chrome.tabGroups.TabGroup | undefined> {
    const cachedId = this.groupIds.get(spec.key);
    if (cachedId !== undefined) {
      try {
        return await chrome.tabGroups.get(cachedId);
      } catch {
        // The group closed, or disappeared while the service worker was suspended.
        this.groupIds.delete(spec.key);
      }
    }

    // After a service-worker restart the cache is empty; the title names the session.
    const groups = await chrome.tabGroups.query({ title: spec.title });
    const match = groups.find((group) => group.title === spec.title);
    if (match) this.groupIds.set(spec.key, match.id);
    return match;
  }

  /**
   * Open a tab in the session's tab group. The session's first tab opens in the
   * focused window; later tabs open in whichever window holds its group.
   */
  private createGroupedTab(url: string, spec: TabGroupSpec): Promise<chrome.tabs.Tab> {
    return this.runGroupOperation(spec.key, async () => {
      const group = await this.findGroup(spec);
      const tab = await chrome.tabs.create({
        url,
        active: false,
        ...(group ? { windowId: group.windowId } : {}),
      });
      if (tab.id === undefined) throw new Error("Failed to create tab");

      try {
        if (group) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
        } else {
          const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(groupId, {
            title: spec.title,
            color: groupColor(spec.key),
          });
          this.groupIds.set(spec.key, groupId);
        }
      } catch (err) {
        // A tab that can't be grouped still works; don't fail the request over it.
        this.logger.debug(`Could not group tab ${tab.id}:`, err);
      }
      return tab;
    });
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
        await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
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

      case "releaseTab":
        // The session ended but a person is using this tab: leave it open,
        // take it out of the session's group, and stop debugging it.
        await chrome.tabs.ungroup(msg.params.tabId).catch(() => {});
        if (this.tabManager.has(msg.params.tabId)) {
          this.tabManager.detach(msg.params.tabId, true);
        }
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
        const tab = await this.createGroupedTab(url, parseGroupSpec(msg.params.params?.group));
        if (!tab.id) throw new Error("Failed to create tab");

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
  private async attachToTab(tabId: number): Promise<{
    sessionId: string;
    targetInfo: { targetId: string; type: string; title: string; url: string; attached: boolean };
  }> {
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
