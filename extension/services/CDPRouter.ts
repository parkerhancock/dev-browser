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

/** chrome.storage.session key holding the session -> tab group id map. */
const GROUP_IDS_KEY = "tabGroupIds";

/** Tabs created without a session (older relays) share one group. */
const DEFAULT_GROUP: TabGroupSpec = { key: "default", title: "dev-browser" };

/**
 * Prefix on every group dev-browser makes. It tells the person which groups
 * an agent owns, and lets the sweep recognize them after Chrome restores
 * them with new ids. A group the person renames without it becomes theirs.
 */
export const GROUP_MARKER = "🤖 ";

/** Title of the shared group versions before 2.1 made. */
const LEGACY_GROUP_TITLE = "Dev Browser";

const displayTitle = (title: string): string => GROUP_MARKER + title;

const isAgentGroupTitle = (title: string | undefined): boolean =>
  !!title && (title.startsWith(GROUP_MARKER) || title === LEGACY_GROUP_TITLE);

/** A live session on the relay and the tab ids of its pages. */
export interface LiveSession {
  key: string;
  tabIds: number[];
}

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
  private groupIdsLoaded?: Promise<void>;
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

  /** Load the session -> group map, which survives service-worker restarts. */
  private loadGroupIds(): Promise<void> {
    this.groupIdsLoaded ??= chrome.storage.session
      .get(GROUP_IDS_KEY)
      .then((stored) => {
        const saved = (stored[GROUP_IDS_KEY] ?? {}) as Record<string, number>;
        for (const [key, id] of Object.entries(saved)) {
          if (!this.groupIds.has(key)) this.groupIds.set(key, id);
        }
      })
      .catch((err) => this.logger.debug("Could not load tab group ids:", err));
    return this.groupIdsLoaded;
  }

  private async saveGroupIds(): Promise<void> {
    await chrome.storage.session
      .set({ [GROUP_IDS_KEY]: Object.fromEntries(this.groupIds) })
      .catch((err) => this.logger.debug("Could not save tab group ids:", err));
  }

  /** The session's tab group, if it still exists. */
  private async findGroup(key: string): Promise<chrome.tabGroups.TabGroup | undefined> {
    await this.loadGroupIds();
    const id = this.groupIds.get(key);
    if (id === undefined) return undefined;
    try {
      return await chrome.tabGroups.get(id);
    } catch {
      // The person closed the group, or Chrome restarted and renumbered groups
      this.groupIds.delete(key);
      await this.saveGroupIds();
      return undefined;
    }
  }

  /** Rename the session's tab group, if it has one. */
  private renameGroup(key: string, title: string): Promise<void> {
    return this.runGroupOperation(key, async () => {
      const group = await this.findGroup(key);
      if (group) await chrome.tabGroups.update(group.id, { title: displayTitle(title) });
    });
  }

  /**
   * Collapse or expand the session's group. Never collapses a group holding
   * the tab the person is looking at.
   */
  private setGroupCollapsed(key: string, collapsed: boolean): Promise<void> {
    return this.runGroupOperation(key, async () => {
      const group = await this.findGroup(key);
      if (!group || group.collapsed === collapsed) return;
      if (collapsed) {
        const active = await chrome.tabs.query({ groupId: group.id, active: true });
        if (active.length > 0) return;
      }
      await chrome.tabGroups.update(group.id, { collapsed });
    });
  }

  /**
   * Close agent groups no live session owns: groups of ended sessions, groups
   * Chrome restored after a restart, and the shared group older versions made.
   * A restored group holding a live session's tab becomes that session's group.
   * Groups without the agent marker belong to the person and are never touched.
   */
  async sweepGroups(live: LiveSession[]): Promise<{ closedTabs: number }> {
    await this.loadGroupIds();
    const liveKeys = new Set(live.map((session) => session.key));
    const keyByTabId = new Map(
      live.flatMap((session) => session.tabIds.map((tabId) => [tabId, session.key] as const))
    );
    const keyByGroupId = new Map(Array.from(this.groupIds, ([key, id]) => [id, key]));
    let closedTabs = 0;

    for (const group of await chrome.tabGroups.query({})) {
      const key = keyByGroupId.get(group.id);
      if (key === undefined && !isAgentGroupTitle(group.title)) continue;
      if (key !== undefined && liveKeys.has(key)) continue;

      const tabs = await chrome.tabs.query({ groupId: group.id });
      const owner = tabs
        .map((tab) => (tab.id === undefined ? undefined : keyByTabId.get(tab.id)))
        .find((k) => k !== undefined);
      if (owner !== undefined) {
        // A live session's tab sits here (recovered after a restart): adopt the group
        if (!this.groupIds.has(owner)) this.groupIds.set(owner, group.id);
        continue;
      }

      if (key !== undefined) this.groupIds.delete(key);
      const tabIds = tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
      if (tabIds.length > 0) {
        await chrome.tabs.remove(tabIds);
        closedTabs += tabIds.length;
      }
      this.logger.log(`Swept tab group "${group.title}": closed ${tabIds.length} tab(s)`);
    }

    await this.saveGroupIds();
    return { closedTabs };
  }

  /**
   * Open a tab in the session's tab group. The session's first tab opens in the
   * focused window; later tabs open in whichever window holds its group.
   */
  private createGroupedTab(url: string, spec: TabGroupSpec): Promise<chrome.tabs.Tab> {
    return this.runGroupOperation(spec.key, async () => {
      const group = await this.findGroup(spec.key);
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
            title: displayTitle(spec.title),
            color: groupColor(spec.key),
          });
          this.groupIds.set(spec.key, groupId);
          await this.saveGroupIds();
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

      case "collapseGroup":
        await this.setGroupCollapsed(msg.params.key, msg.params.collapsed);
        return { success: true };

      case "sweepGroups":
        return this.sweepGroups(msg.params.live);

      case "renameGroup":
        await this.renameGroup(msg.params.key, msg.params.title);
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
