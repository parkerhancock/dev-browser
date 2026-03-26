/**
 * Target Registry for the CDP Relay Server.
 *
 * Encapsulates the Maps that track page/session/target state.
 * Each ConnectedTarget carries its own lifecycle state and ownership,
 * eliminating the class of bugs where separate Maps fall out of sync.
 *
 * Maps (4, down from 6):
 *   targets:            cdpSessionId → ConnectedTarget
 *   namedPages:         "session:name" → cdpSessionId
 *   pageKeyByTargetId:  targetId → "session:name"
 *   sessions:           agentSession → SessionState
 *
 * Eliminated Maps (state now lives on ConnectedTarget):
 *   targetToAgentSession → ConnectedTarget.agentSession
 *   pendingDetach        → ConnectedTarget.state === "detaching" + .detachTimeout
 */

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  browserContextId?: string;
  attached: boolean;
}

/** Lifecycle states for a CDP target. */
export type TargetState = "attached" | "named" | "detaching" | "stale";

export interface ConnectedTarget {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
  lastActivity: number;
  pinned: boolean;

  /** Owning agent session. Undefined if unclaimed. */
  agentSession?: string;

  /**
   * Lifecycle state:
   *   attached  — target exists in registry but has no named page yet
   *   named     — target has a named page mapping
   *   detaching — target is in a grace period waiting for cross-origin reattachment
   *   stale     — CDP session is invalid (extension reconnected), awaiting recovery
   */
  state: TargetState;

  /** Grace period timer when state === "detaching". */
  detachTimeout?: NodeJS.Timeout;
}

export interface SessionState {
  id: string;
  pageNames: Set<string>;
  targetSessions: Set<string>;
}

export interface TargetRegistry {
  // Read-only Map access
  readonly targets: Map<string, ConnectedTarget>; // cdpSessionId -> ConnectedTarget
  readonly namedPages: Map<string, string>; // "session:name" -> cdpSessionId
  readonly pageKeyByTargetId: Map<string, string>; // targetId -> "session:name"
  readonly sessions: Map<string, SessionState>;

  // Session helpers
  getOrCreateSession(sessionId: string): SessionState;
  isOwnedBySession(cdpSessionId: string, agentSession: string): boolean;
  getSessionTargetIds(agentSession: string): string[];

  // Single-target writes (convenience)
  addTarget(cdpSessionId: string, target: ConnectedTarget): void;
  updateActivity(cdpSessionId: string): void;

  /**
   * Register a named page — sets namedPages, pageKeyByTargetId,
   * target ownership/state, and session state atomically.
   */
  nameTarget(
    pageKey: string,
    pageName: string,
    cdpSessionId: string,
    targetId: string,
    agentSession: string
  ): void;

  /**
   * Remove a named page and its associated target — cleans up all Maps atomically.
   * Returns the removed ConnectedTarget (if any) for further cleanup (e.g., detach).
   */
  removeNamedPage(pageKey: string): ConnectedTarget | undefined;

  /**
   * Remove only the name mapping (namedPages + pageKeyByTargetId + session.pageNames),
   * without removing the target from the targets Map.
   * Used when a stale namedPages entry points to a dead cdpSessionId.
   */
  removeStalePageName(pageKey: string, pageName: string, agentSession: string): void;

  /**
   * Atomically update all Maps for a cross-origin reattachment:
   * new cdpSessionId replaces old one for the same pageKey.
   */
  reattachTarget(
    pageKey: string,
    oldCdpSessionId: string,
    newCdpSessionId: string,
    agentSession: string
  ): void;

  /**
   * Schedule deferred cleanup for a detached target.
   * Sets target state to "detaching" and stores the timeout on the target.
   * If the same targetId reattaches before timeout, cancel via cancelPendingDetach.
   */
  deferDetach(
    cdpSessionId: string,
    targetId: string,
    onTimeout: () => void,
    delayMs: number
  ): void;

  /**
   * Cancel a pending detach for a targetId (called on reattachment).
   * Returns the old cdpSessionId if found, undefined if no pending detach.
   */
  cancelPendingDetach(targetId: string): string | undefined;

  /**
   * Remove a target that was never named (immediate cleanup on detach).
   */
  removeUnnamedTarget(cdpSessionId: string): void;

  /**
   * Remove all pages and targets for a session.
   * Returns page keys that were removed (for extension-side cleanup).
   */
  cleanupSession(
    agentSession: string
  ): { removedPageKeys: string[]; cdpSessionIds: string[] };

  /**
   * Set ownership of an unclaimed target. Used when a CDP command arrives
   * for a target that exists but has no owner yet.
   */
  claimTarget(cdpSessionId: string, agentSession: string): void;

  /**
   * Get the owning agent session for a CDP session.
   * Returns undefined if unclaimed.
   */
  getOwner(cdpSessionId: string): string | undefined;

  /**
   * Look up the pageKey for a given targetId.
   * Returns undefined if the target has no named page.
   */
  getPageKeyByTargetId(targetId: string): string | undefined;

  /**
   * Reverse lookup: find the pageKey that maps to a given cdpSessionId.
   * Scans namedPages — used during detachment to find which page owns a session.
   */
  getPageKeyByCdpSession(cdpSessionId: string): string | undefined;

  /**
   * Remove a target from the targets Map only (no other Maps).
   * Used to clean up stale CDP session entries after reattachment.
   */
  removeTarget(cdpSessionId: string): void;

  /**
   * Clear only targets (CDP sessions are invalid),
   * while preserving namedPages and sessions for recovery.
   * Used on extension reconnect.
   */
  clearTargetsOnly(): void;

  /**
   * Tear down all pages for a session, cleaning up all Maps properly.
   * Returns info needed for extension-side tab closing.
   */
  evictSession(
    agentSession: string
  ): Array<{ pageKey: string; pageName: string; cdpSessionId: string; target: ConnectedTarget | undefined }>;

  /**
   * Count of targets currently in "detaching" state.
   * Used for stats/debugging.
   */
  countDetaching(): number;

  /**
   * Nuclear reset — clear all Maps. Used on extension disconnect.
   * Cancels all pending detach timeouts.
   */
  clear(): void;
}

export function createTargetRegistry(): TargetRegistry {
  const targets = new Map<string, ConnectedTarget>();
  const namedPages = new Map<string, string>();
  const pageKeyByTargetId = new Map<string, string>();
  const sessions = new Map<string, SessionState>();

  /** Cancel and clear any detach timeout on a target. */
  function clearDetachTimeout(target: ConnectedTarget): void {
    if (target.detachTimeout) {
      clearTimeout(target.detachTimeout);
      target.detachTimeout = undefined;
    }
  }

  function getOrCreateSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        pageNames: new Set(),
        targetSessions: new Set(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  }

  return {
    // Expose Maps for read access
    targets,
    namedPages,
    pageKeyByTargetId,
    sessions,

    getOrCreateSession,

    isOwnedBySession(cdpSessionId: string, agentSession: string): boolean {
      return targets.get(cdpSessionId)?.agentSession === agentSession;
    },

    getSessionTargetIds(agentSession: string): string[] {
      const session = sessions.get(agentSession);
      return session ? Array.from(session.targetSessions) : [];
    },

    addTarget(cdpSessionId: string, target: ConnectedTarget): void {
      targets.set(cdpSessionId, target);
    },

    updateActivity(cdpSessionId: string): void {
      const target = targets.get(cdpSessionId);
      if (target) {
        target.lastActivity = Date.now();
      }
    },

    nameTarget(
      pageKey: string,
      pageName: string,
      cdpSessionId: string,
      targetId: string,
      agentSession: string
    ): void {
      namedPages.set(pageKey, cdpSessionId);
      pageKeyByTargetId.set(targetId, pageKey);

      // Set ownership and state on the target itself
      const target = targets.get(cdpSessionId);
      if (target) {
        target.agentSession = agentSession;
        target.state = "named";
      }

      const session = getOrCreateSession(agentSession);
      session.pageNames.add(pageName);
      session.targetSessions.add(cdpSessionId);
    },

    removeNamedPage(pageKey: string): ConnectedTarget | undefined {
      const cdpSessionId = namedPages.get(pageKey);
      if (!cdpSessionId) return undefined;

      const target = targets.get(cdpSessionId);
      const agentSession = target?.agentSession;

      // Clean up all Maps
      namedPages.delete(pageKey);
      if (target) {
        clearDetachTimeout(target);
        pageKeyByTargetId.delete(target.targetId);
        targets.delete(cdpSessionId);
      }

      // Update session state
      if (agentSession) {
        const session = sessions.get(agentSession);
        if (session) {
          const colonIdx = pageKey.indexOf(":");
          if (colonIdx >= 0) {
            session.pageNames.delete(pageKey.slice(colonIdx + 1));
          }
          session.targetSessions.delete(cdpSessionId);
        }
      }

      return target;
    },

    removeStalePageName(
      pageKey: string,
      pageName: string,
      agentSession: string
    ): void {
      namedPages.delete(pageKey);
      const session = sessions.get(agentSession);
      if (session) {
        session.pageNames.delete(pageName);
      }
    },

    reattachTarget(
      pageKey: string,
      oldCdpSessionId: string,
      newCdpSessionId: string,
      agentSession: string
    ): void {
      // Update namedPages to point to new session
      namedPages.set(pageKey, newCdpSessionId);

      // Transfer ownership to the new target
      const newTarget = targets.get(newCdpSessionId);
      if (newTarget) {
        newTarget.agentSession = agentSession;
        newTarget.state = "named";
        pageKeyByTargetId.set(newTarget.targetId, pageKey);
      }

      // Clean up old target
      const oldTarget = targets.get(oldCdpSessionId);
      if (oldTarget) {
        clearDetachTimeout(oldTarget);
      }
      targets.delete(oldCdpSessionId);

      // Update session state
      const session = sessions.get(agentSession);
      if (session) {
        session.targetSessions.delete(oldCdpSessionId);
        session.targetSessions.add(newCdpSessionId);
      }
    },

    deferDetach(
      cdpSessionId: string,
      _targetId: string,
      onTimeout: () => void,
      delayMs: number
    ): void {
      const target = targets.get(cdpSessionId);
      if (target) {
        clearDetachTimeout(target);
        target.state = "detaching";
        target.detachTimeout = setTimeout(onTimeout, delayMs);
      }
    },

    cancelPendingDetach(targetId: string): string | undefined {
      for (const [cdpSessionId, target] of targets) {
        if (target.targetId === targetId && target.state === "detaching") {
          clearDetachTimeout(target);
          return cdpSessionId;
        }
      }
      return undefined;
    },

    removeUnnamedTarget(cdpSessionId: string): void {
      const target = targets.get(cdpSessionId);
      if (target) {
        clearDetachTimeout(target);
      }
      targets.delete(cdpSessionId);
    },

    cleanupSession(
      agentSession: string
    ): { removedPageKeys: string[]; cdpSessionIds: string[] } {
      const session = sessions.get(agentSession);
      if (!session) return { removedPageKeys: [], cdpSessionIds: [] };

      const removedPageKeys: string[] = [];
      const cdpSessionIds: string[] = [];

      for (const pageName of session.pageNames) {
        const pageKey = `${agentSession}:${pageName}`;
        const cdpSessionId = namedPages.get(pageKey);
        if (cdpSessionId) {
          cdpSessionIds.push(cdpSessionId);
          const target = targets.get(cdpSessionId);
          if (target) {
            clearDetachTimeout(target);
            pageKeyByTargetId.delete(target.targetId);
            targets.delete(cdpSessionId);
          }
          namedPages.delete(pageKey);
          removedPageKeys.push(pageKey);
        }
      }

      sessions.delete(agentSession);
      return { removedPageKeys, cdpSessionIds };
    },

    claimTarget(cdpSessionId: string, agentSession: string): void {
      const target = targets.get(cdpSessionId);
      if (target) {
        target.agentSession = agentSession;
      }
      const session = getOrCreateSession(agentSession);
      session.targetSessions.add(cdpSessionId);
    },

    getOwner(cdpSessionId: string): string | undefined {
      return targets.get(cdpSessionId)?.agentSession;
    },

    getPageKeyByTargetId(targetId: string): string | undefined {
      return pageKeyByTargetId.get(targetId);
    },

    getPageKeyByCdpSession(cdpSessionId: string): string | undefined {
      for (const [pageKey, sid] of namedPages) {
        if (sid === cdpSessionId) {
          return pageKey;
        }
      }
      return undefined;
    },

    removeTarget(cdpSessionId: string): void {
      const target = targets.get(cdpSessionId);
      if (target) {
        clearDetachTimeout(target);
      }
      targets.delete(cdpSessionId);
    },

    clearTargetsOnly(): void {
      for (const target of targets.values()) {
        clearDetachTimeout(target);
      }
      targets.clear();
    },

    evictSession(
      agentSession: string
    ): Array<{ pageKey: string; pageName: string; cdpSessionId: string; target: ConnectedTarget | undefined }> {
      const session = sessions.get(agentSession);
      if (!session) return [];

      const result: Array<{ pageKey: string; pageName: string; cdpSessionId: string; target: ConnectedTarget | undefined }> = [];

      const pageNames = Array.from(session.pageNames);

      for (const pageName of pageNames) {
        const pageKey = `${agentSession}:${pageName}`;
        const cdpSessionId = namedPages.get(pageKey);

        if (cdpSessionId) {
          const target = targets.get(cdpSessionId);

          if (target) {
            clearDetachTimeout(target);
            pageKeyByTargetId.delete(target.targetId);
            targets.delete(cdpSessionId);
          }
          namedPages.delete(pageKey);

          result.push({ pageKey, pageName, cdpSessionId, target });
        }

        session.pageNames.delete(pageName);
        if (cdpSessionId) {
          session.targetSessions.delete(cdpSessionId);
        }
      }

      sessions.delete(agentSession);
      return result;
    },

    countDetaching(): number {
      let count = 0;
      for (const target of targets.values()) {
        if (target.state === "detaching") count++;
      }
      return count;
    },

    clear(): void {
      for (const target of targets.values()) {
        clearDetachTimeout(target);
      }

      targets.clear();
      namedPages.clear();
      pageKeyByTargetId.clear();
      sessions.clear();
    },
  };
}
