/**
 * Unit tests for the Target Registry state machine.
 *
 * Tests lifecycle state transitions, ownership tracking, detach/reattach,
 * session management, and cleanup — all without spinning up a relay server.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  createTargetRegistry,
  type ConnectedTarget,
  type TargetRegistry,
} from "../relay-registry.js";

function makeTarget(overrides: Partial<ConnectedTarget> = {}): ConnectedTarget {
  return {
    sessionId: overrides.sessionId ?? "cdp-1",
    targetId: overrides.targetId ?? "target-1",
    targetInfo: {
      targetId: overrides.targetId ?? "target-1",
      type: "page",
      title: "",
      url: "about:blank",
      attached: true,
    },
    lastActivity: Date.now(),
    pinned: false,
    state: "attached",
    ...overrides,
  };
}

describe("TargetRegistry", () => {
  let registry: TargetRegistry;

  beforeEach(() => {
    registry = createTargetRegistry();
  });

  // --------------------------------------------------------------------------
  // Basic target management
  // --------------------------------------------------------------------------

  describe("addTarget", () => {
    test("adds target with attached state", () => {
      const target = makeTarget();
      registry.addTarget("cdp-1", target);

      expect(registry.targets.get("cdp-1")).toBe(target);
      expect(target.state).toBe("attached");
    });

    test("target has no owner initially", () => {
      registry.addTarget("cdp-1", makeTarget());
      expect(registry.getOwner("cdp-1")).toBeUndefined();
    });
  });

  describe("updateActivity", () => {
    test("updates lastActivity timestamp", () => {
      const target = makeTarget({ lastActivity: 1000 });
      registry.addTarget("cdp-1", target);

      registry.updateActivity("cdp-1");
      expect(target.lastActivity).toBeGreaterThan(1000);
    });

    test("no-op for nonexistent target", () => {
      // Should not throw
      registry.updateActivity("nonexistent");
    });
  });

  // --------------------------------------------------------------------------
  // Lifecycle: attached → named
  // --------------------------------------------------------------------------

  describe("nameTarget", () => {
    test("transitions state from attached to named", () => {
      const target = makeTarget();
      registry.addTarget("cdp-1", target);

      registry.nameTarget("agent:my-page", "my-page", "cdp-1", "target-1", "agent");

      expect(target.state).toBe("named");
      expect(target.agentSession).toBe("agent");
    });

    test("sets up all mappings", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:my-page", "my-page", "cdp-1", "target-1", "agent");

      expect(registry.namedPages.get("agent:my-page")).toBe("cdp-1");
      expect(registry.getPageKeyByTargetId("target-1")).toBe("agent:my-page");
      expect(registry.getOwner("cdp-1")).toBe("agent");
    });

    test("updates session state", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:my-page", "my-page", "cdp-1", "target-1", "agent");

      const session = registry.sessions.get("agent");
      expect(session).toBeDefined();
      expect(session!.pageNames.has("my-page")).toBe(true);
      expect(session!.targetSessions.has("cdp-1")).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Ownership
  // --------------------------------------------------------------------------

  describe("claimTarget / getOwner", () => {
    test("claims unclaimed target", () => {
      registry.addTarget("cdp-1", makeTarget());

      expect(registry.getOwner("cdp-1")).toBeUndefined();
      registry.claimTarget("cdp-1", "agent-a");
      expect(registry.getOwner("cdp-1")).toBe("agent-a");
    });

    test("adds to session targetSessions", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.claimTarget("cdp-1", "agent-a");

      const session = registry.sessions.get("agent-a");
      expect(session!.targetSessions.has("cdp-1")).toBe(true);
    });

    test("sets agentSession on the target object", () => {
      const target = makeTarget();
      registry.addTarget("cdp-1", target);
      registry.claimTarget("cdp-1", "agent-a");

      expect(target.agentSession).toBe("agent-a");
    });

    test("isOwnedBySession checks ownership", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.claimTarget("cdp-1", "agent-a");

      expect(registry.isOwnedBySession("cdp-1", "agent-a")).toBe(true);
      expect(registry.isOwnedBySession("cdp-1", "agent-b")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Lifecycle: named → detaching → cleanup
  // --------------------------------------------------------------------------

  describe("deferDetach", () => {
    test("transitions state to detaching", () => {
      const target = makeTarget({ state: "named" });
      registry.addTarget("cdp-1", target);

      registry.deferDetach("cdp-1", "target-1", () => {}, 1000);

      expect(target.state).toBe("detaching");
      expect(target.detachTimeout).toBeDefined();
    });

    test("timeout callback fires after delay", async () => {
      vi.useFakeTimers();

      const target = makeTarget({ state: "named" });
      registry.addTarget("cdp-1", target);

      const callback = vi.fn();
      registry.deferDetach("cdp-1", "target-1", callback, 500);

      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });

  describe("cancelPendingDetach", () => {
    test("cancels detach for matching targetId", () => {
      vi.useFakeTimers();

      const target = makeTarget({ state: "named" });
      registry.addTarget("cdp-1", target);

      const callback = vi.fn();
      registry.deferDetach("cdp-1", "target-1", callback, 500);

      const cancelled = registry.cancelPendingDetach("target-1");
      expect(cancelled).toBe("cdp-1");

      // Timeout should not fire
      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    test("returns undefined for non-detaching target", () => {
      registry.addTarget("cdp-1", makeTarget());
      expect(registry.cancelPendingDetach("target-1")).toBeUndefined();
    });

    test("returns undefined for unknown targetId", () => {
      expect(registry.cancelPendingDetach("nonexistent")).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Cross-origin reattachment
  // --------------------------------------------------------------------------

  describe("reattachTarget", () => {
    test("transfers mappings from old to new cdpSessionId", () => {
      // Set up a named target
      const oldTarget = makeTarget({ sessionId: "cdp-old", targetId: "target-1" });
      registry.addTarget("cdp-old", oldTarget);
      registry.nameTarget("agent:page", "page", "cdp-old", "target-1", "agent");

      // Add the new target (as Chrome would via attachedToTarget)
      const newTarget = makeTarget({ sessionId: "cdp-new", targetId: "target-1" });
      registry.addTarget("cdp-new", newTarget);

      // Reattach
      registry.reattachTarget("agent:page", "cdp-old", "cdp-new", "agent");

      // New target is named and owned
      expect(newTarget.state).toBe("named");
      expect(newTarget.agentSession).toBe("agent");
      expect(registry.namedPages.get("agent:page")).toBe("cdp-new");
      expect(registry.getOwner("cdp-new")).toBe("agent");

      // Old target is removed
      expect(registry.targets.has("cdp-old")).toBe(false);
    });

    test("updates session targetSessions", () => {
      const oldTarget = makeTarget({ sessionId: "cdp-old" });
      registry.addTarget("cdp-old", oldTarget);
      registry.nameTarget("agent:page", "page", "cdp-old", "target-1", "agent");

      const newTarget = makeTarget({ sessionId: "cdp-new", targetId: "target-1" });
      registry.addTarget("cdp-new", newTarget);

      registry.reattachTarget("agent:page", "cdp-old", "cdp-new", "agent");

      const session = registry.sessions.get("agent")!;
      expect(session.targetSessions.has("cdp-new")).toBe(true);
      expect(session.targetSessions.has("cdp-old")).toBe(false);
    });

    test("clears detach timeout on old target", () => {
      vi.useFakeTimers();

      const oldTarget = makeTarget({ sessionId: "cdp-old" });
      registry.addTarget("cdp-old", oldTarget);
      registry.nameTarget("agent:page", "page", "cdp-old", "target-1", "agent");

      const callback = vi.fn();
      registry.deferDetach("cdp-old", "target-1", callback, 500);

      const newTarget = makeTarget({ sessionId: "cdp-new", targetId: "target-1" });
      registry.addTarget("cdp-new", newTarget);
      registry.reattachTarget("agent:page", "cdp-old", "cdp-new", "agent");

      // Old timeout should be cleared
      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // Removal
  // --------------------------------------------------------------------------

  describe("removeNamedPage", () => {
    test("removes all mappings and returns target", () => {
      const target = makeTarget();
      registry.addTarget("cdp-1", target);
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      const removed = registry.removeNamedPage("agent:page");

      expect(removed).toBe(target);
      expect(registry.targets.has("cdp-1")).toBe(false);
      expect(registry.namedPages.has("agent:page")).toBe(false);
      expect(registry.getPageKeyByTargetId("target-1")).toBeUndefined();
      expect(registry.getOwner("cdp-1")).toBeUndefined();
    });

    test("updates session state", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      registry.removeNamedPage("agent:page");

      const session = registry.sessions.get("agent");
      expect(session!.pageNames.has("page")).toBe(false);
      expect(session!.targetSessions.has("cdp-1")).toBe(false);
    });

    test("returns undefined for nonexistent pageKey", () => {
      expect(registry.removeNamedPage("nonexistent")).toBeUndefined();
    });

    test("clears detach timeout if target was detaching", () => {
      vi.useFakeTimers();

      const target = makeTarget();
      registry.addTarget("cdp-1", target);
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      const callback = vi.fn();
      registry.deferDetach("cdp-1", "target-1", callback, 500);

      registry.removeNamedPage("agent:page");

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("removeUnnamedTarget", () => {
    test("removes target from targets map", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.removeUnnamedTarget("cdp-1");
      expect(registry.targets.has("cdp-1")).toBe(false);
    });

    test("does not affect namedPages", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      // Remove a different unnamed target
      registry.addTarget("cdp-2", makeTarget({ sessionId: "cdp-2", targetId: "target-2" }));
      registry.removeUnnamedTarget("cdp-2");

      expect(registry.namedPages.has("agent:page")).toBe(true);
    });
  });

  describe("removeStalePageName", () => {
    test("removes page name without affecting targets", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      registry.removeStalePageName("agent:page", "page", "agent");

      // Page name removed
      expect(registry.namedPages.has("agent:page")).toBe(false);
      expect(registry.sessions.get("agent")!.pageNames.has("page")).toBe(false);

      // But target is still there
      expect(registry.targets.has("cdp-1")).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Reverse lookups
  // --------------------------------------------------------------------------

  describe("getPageKeyByTargetId", () => {
    test("returns pageKey for named target", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");
      expect(registry.getPageKeyByTargetId("target-1")).toBe("agent:page");
    });

    test("returns undefined for unnamed target", () => {
      registry.addTarget("cdp-1", makeTarget());
      expect(registry.getPageKeyByTargetId("target-1")).toBeUndefined();
    });
  });

  describe("getPageKeyByCdpSession", () => {
    test("returns pageKey for named cdpSessionId", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");
      expect(registry.getPageKeyByCdpSession("cdp-1")).toBe("agent:page");
    });

    test("returns undefined for unnamed cdpSessionId", () => {
      registry.addTarget("cdp-1", makeTarget());
      expect(registry.getPageKeyByCdpSession("cdp-1")).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Session management
  // --------------------------------------------------------------------------

  describe("getOrCreateSession", () => {
    test("creates session on first access", () => {
      const session = registry.getOrCreateSession("agent-a");
      expect(session.id).toBe("agent-a");
      expect(session.pageNames.size).toBe(0);
      expect(session.targetSessions.size).toBe(0);
    });

    test("returns same session on second access", () => {
      const s1 = registry.getOrCreateSession("agent-a");
      const s2 = registry.getOrCreateSession("agent-a");
      expect(s1).toBe(s2);
    });
  });

  describe("getSessionTargetIds", () => {
    test("returns cdpSessionIds for session", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:p1", "p1", "cdp-1", "target-1", "agent");

      registry.addTarget("cdp-2", makeTarget({ sessionId: "cdp-2", targetId: "target-2" }));
      registry.nameTarget("agent:p2", "p2", "cdp-2", "target-2", "agent");

      const ids = registry.getSessionTargetIds("agent");
      expect(ids).toContain("cdp-1");
      expect(ids).toContain("cdp-2");
    });

    test("returns empty array for unknown session", () => {
      expect(registry.getSessionTargetIds("nonexistent")).toEqual([]);
    });
  });

  describe("evictSession", () => {
    test("removes all pages and returns info for each", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:p1", "p1", "cdp-1", "target-1", "agent");

      registry.addTarget("cdp-2", makeTarget({ sessionId: "cdp-2", targetId: "target-2" }));
      registry.nameTarget("agent:p2", "p2", "cdp-2", "target-2", "agent");

      const evicted = registry.evictSession("agent");

      expect(evicted).toHaveLength(2);
      expect(evicted.map((e) => e.pageName).sort()).toEqual(["p1", "p2"]);

      // Everything cleaned up
      expect(registry.targets.size).toBe(0);
      expect(registry.namedPages.size).toBe(0);
      expect(registry.sessions.has("agent")).toBe(false);
    });

    test("returns empty array for nonexistent session", () => {
      expect(registry.evictSession("nonexistent")).toEqual([]);
    });
  });

  describe("cleanupSession", () => {
    test("removes all pages and returns pageKeys + cdpSessionIds", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:p1", "p1", "cdp-1", "target-1", "agent");

      const result = registry.cleanupSession("agent");

      expect(result.removedPageKeys).toEqual(["agent:p1"]);
      expect(result.cdpSessionIds).toEqual(["cdp-1"]);
      expect(registry.targets.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Bulk operations
  // --------------------------------------------------------------------------

  describe("clearTargetsOnly", () => {
    test("clears targets but preserves namedPages and sessions", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      registry.clearTargetsOnly();

      // Targets gone
      expect(registry.targets.size).toBe(0);

      // But namedPages and sessions preserved (for recovery)
      expect(registry.namedPages.has("agent:page")).toBe(true);
      expect(registry.sessions.has("agent")).toBe(true);
    });

    test("cancels detach timeouts", () => {
      vi.useFakeTimers();

      const target = makeTarget();
      registry.addTarget("cdp-1", target);
      const callback = vi.fn();
      registry.deferDetach("cdp-1", "target-1", callback, 500);

      registry.clearTargetsOnly();

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("clear", () => {
    test("clears everything", () => {
      registry.addTarget("cdp-1", makeTarget());
      registry.nameTarget("agent:page", "page", "cdp-1", "target-1", "agent");

      registry.clear();

      expect(registry.targets.size).toBe(0);
      expect(registry.namedPages.size).toBe(0);
      expect(registry.pageKeyByTargetId.size).toBe(0);
      expect(registry.sessions.size).toBe(0);
    });

    test("cancels detach timeouts", () => {
      vi.useFakeTimers();

      registry.addTarget("cdp-1", makeTarget());
      const callback = vi.fn();
      registry.deferDetach("cdp-1", "target-1", callback, 500);

      registry.clear();

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // countDetaching
  // --------------------------------------------------------------------------

  describe("countDetaching", () => {
    test("counts targets in detaching state", () => {
      registry.addTarget("cdp-1", makeTarget({ sessionId: "cdp-1" }));
      registry.addTarget("cdp-2", makeTarget({ sessionId: "cdp-2", targetId: "target-2" }));
      registry.addTarget("cdp-3", makeTarget({ sessionId: "cdp-3", targetId: "target-3" }));

      registry.deferDetach("cdp-1", "target-1", () => {}, 1000);
      registry.deferDetach("cdp-2", "target-2", () => {}, 1000);

      expect(registry.countDetaching()).toBe(2);
    });

    test("returns 0 when nothing is detaching", () => {
      registry.addTarget("cdp-1", makeTarget());
      expect(registry.countDetaching()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Multi-target state machine scenario
  // --------------------------------------------------------------------------

  describe("full lifecycle scenario", () => {
    test("attach → name → detach → reattach → remove", () => {
      // 1. Target arrives from extension (attached, no owner)
      const target1 = makeTarget({ sessionId: "cdp-1", targetId: "t1" });
      registry.addTarget("cdp-1", target1);
      expect(target1.state).toBe("attached");

      // 2. Agent claims it via Target.attachToTarget
      registry.claimTarget("cdp-1", "agent");
      expect(target1.agentSession).toBe("agent");

      // 3. Agent names it via POST /pages
      registry.nameTarget("agent:mypage", "mypage", "cdp-1", "t1", "agent");
      expect(target1.state).toBe("named");

      // 4. Cross-origin navigation: old session detaches
      registry.deferDetach("cdp-1", "t1", () => {}, 500);
      expect(target1.state).toBe("detaching");
      expect(registry.countDetaching()).toBe(1);

      // 5. New session attaches with same targetId
      const target2 = makeTarget({ sessionId: "cdp-2", targetId: "t1" });
      registry.addTarget("cdp-2", target2);

      // 6. Cancel pending detach, remove old target
      const cancelled = registry.cancelPendingDetach("t1");
      expect(cancelled).toBe("cdp-1");
      registry.removeTarget("cdp-1");
      expect(registry.countDetaching()).toBe(0);

      // 7. Reattach with new session
      registry.reattachTarget("agent:mypage", "cdp-1", "cdp-2", "agent");
      expect(target2.state).toBe("named");
      expect(target2.agentSession).toBe("agent");
      expect(registry.namedPages.get("agent:mypage")).toBe("cdp-2");

      // 8. Agent closes the page
      const removed = registry.removeNamedPage("agent:mypage");
      expect(removed).toBe(target2);
      expect(registry.targets.size).toBe(0);
      expect(registry.namedPages.size).toBe(0);
    });
  });
});
