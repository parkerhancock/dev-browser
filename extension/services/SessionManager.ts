/**
 * SessionManager - Manages agent sessions and their tab groups.
 *
 * Each agent session maps to a Chrome tab group. The tab group is the
 * source of truth for which tabs belong to which agent.
 */

import type { Logger } from "../utils/logger";

export interface SessionGroup {
  sessionId: string;
  groupId: number;
  groupName: string;
  createdAt: number;
}

export interface SessionManagerDeps {
  logger: Logger;
}

const STORAGE_KEY = "devBrowserSessions";

export class SessionManager {
  private logger: Logger;
  // Runtime cache: groupId -> sessionId (for fast event routing)
  private groupToSession = new Map<number, string>();
  // Runtime cache: sessionId -> groupId
  private sessionToGroup = new Map<string, number>();
  private nextSessionNumber = 1;

  constructor(deps: SessionManagerDeps) {
    this.logger = deps.logger;
  }

  /**
   * Initialize from Chrome storage and rebuild runtime caches.
   */
  async initialize(): Promise<void> {
    const sessions = await this.loadSessions();

    // Verify groups still exist and rebuild caches
    for (const session of sessions) {
      try {
        await chrome.tabGroups.get(session.groupId);
        // Group exists, add to caches
        this.groupToSession.set(session.groupId, session.sessionId);
        this.sessionToGroup.set(session.sessionId, session.groupId);
        this.logger.debug(
          `Restored session ${session.sessionId} -> group ${session.groupId} (${session.groupName})`
        );
      } catch {
        // Group no longer exists, will be cleaned up
        this.logger.debug(`Session ${session.sessionId} group no longer exists, removing`);
      }
    }

    // Calculate next session number from existing names
    for (const session of sessions) {
      const match = session.groupName.match(/^Session (\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= this.nextSessionNumber) {
          this.nextSessionNumber = num + 1;
        }
      }
    }

    // Save cleaned up sessions
    await this.saveSessions();
    this.logger.log(`SessionManager initialized with ${this.sessionToGroup.size} sessions`);
  }

  /**
   * Get or create a tab group for the given session ID.
   */
  async getOrCreateGroup(sessionId: string): Promise<{ groupId: number; groupName: string; isNew: boolean }> {
    // Check if session already has a group
    const existingGroupId = this.sessionToGroup.get(sessionId);
    if (existingGroupId !== undefined) {
      try {
        const group = await chrome.tabGroups.get(existingGroupId);
        return { groupId: existingGroupId, groupName: group.title || `Session`, isNew: false };
      } catch {
        // Group was deleted, remove from cache
        this.sessionToGroup.delete(sessionId);
        this.groupToSession.delete(existingGroupId);
      }
    }

    // Create a new group - need a tab first
    // We'll create a placeholder tab, group it, then return
    // The caller will add their actual tab to this group
    const groupName = `Session ${this.nextSessionNumber++}`;

    this.logger.debug(`Creating new group "${groupName}" for session ${sessionId}`);

    // Create a temporary tab to establish the group
    const tempTab = await chrome.tabs.create({ url: "about:blank", active: false });
    if (!tempTab.id) throw new Error("Failed to create temporary tab");

    const groupId = await chrome.tabs.group({ tabIds: [tempTab.id] });
    await chrome.tabGroups.update(groupId, {
      title: groupName,
      color: "blue",
      collapsed: false,
    });

    // Close the temporary tab - the group will be empty but persists
    // Actually, Chrome deletes empty groups, so we need to keep a tab
    // The caller should immediately add their tab to this group

    // Store mapping
    this.groupToSession.set(groupId, sessionId);
    this.sessionToGroup.set(sessionId, groupId);
    await this.saveSessions();

    // Close temp tab after a short delay to let caller add their tab
    setTimeout(() => {
      chrome.tabs.remove(tempTab.id!).catch(() => {});
    }, 500);

    return { groupId, groupName, isNew: true };
  }

  /**
   * Get the session ID that owns a tab (based on its group membership).
   */
  async getSessionForTab(tabId: number): Promise<string | null> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        return null;
      }
      return this.groupToSession.get(tab.groupId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the group ID for a session.
   */
  getGroupForSession(sessionId: string): number | undefined {
    return this.sessionToGroup.get(sessionId);
  }

  /**
   * Get the session ID for a group.
   */
  getSessionForGroup(groupId: number): string | undefined {
    return this.groupToSession.get(groupId);
  }

  /**
   * Add a tab to a session's group.
   */
  async addTabToSession(tabId: number, sessionId: string): Promise<void> {
    const groupId = this.sessionToGroup.get(sessionId);
    if (groupId === undefined) {
      throw new Error(`No group found for session ${sessionId}`);
    }

    await chrome.tabs.group({ tabIds: [tabId], groupId });
    this.logger.debug(`Added tab ${tabId} to session ${sessionId} (group ${groupId})`);
  }

  /**
   * Get all tabs in a session's group.
   */
  async getTabsForSession(sessionId: string): Promise<chrome.tabs.Tab[]> {
    const groupId = this.sessionToGroup.get(sessionId);
    if (groupId === undefined) {
      return [];
    }

    return chrome.tabs.query({ groupId });
  }

  /**
   * Close all tabs in a session and remove the session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const groupId = this.sessionToGroup.get(sessionId);
    if (groupId === undefined) {
      return;
    }

    const tabs = await chrome.tabs.query({ groupId });
    const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);

    if (tabIds.length > 0) {
      await chrome.tabs.remove(tabIds);
    }

    this.groupToSession.delete(groupId);
    this.sessionToGroup.delete(sessionId);
    await this.saveSessions();

    this.logger.log(`Closed session ${sessionId} (${tabIds.length} tabs)`);
  }

  /**
   * Check if a group is managed by us.
   */
  isManagedGroup(groupId: number): boolean {
    return this.groupToSession.has(groupId);
  }

  /**
   * Load sessions from Chrome storage.
   */
  private async loadSessions(): Promise<SessionGroup[]> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] || [];
  }

  /**
   * Save sessions to Chrome storage.
   */
  private async saveSessions(): Promise<void> {
    const sessions: SessionGroup[] = [];
    for (const [sessionId, groupId] of this.sessionToGroup) {
      try {
        const group = await chrome.tabGroups.get(groupId);
        sessions.push({
          sessionId,
          groupId,
          groupName: group.title || "Session",
          createdAt: Date.now(),
        });
      } catch {
        // Group no longer exists, skip
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  }
}
