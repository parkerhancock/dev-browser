import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { CDPRouter, groupColor } from "../services/CDPRouter";
import { TabManager } from "../services/TabManager";
import type { Logger } from "../utils/logger";
import type { ExtensionCommandMessage } from "../utils/types";

// Mock chrome.debugger since fakeBrowser doesn't include it
const mockDebuggerSendCommand = vi.fn();
const mockTabsGet = vi.fn();
const mockTabsGroup = vi.fn();
const mockTabsQuery = vi.fn();
const mockTabsCreate = vi.fn();
const mockTabsUngroup = vi.fn();
const mockTabsRemove = vi.fn();
const mockTabGroupsGet = vi.fn();
const mockTabGroupsQuery = vi.fn();
const mockTabGroupsUpdate = vi.fn();

vi.stubGlobal("chrome", {
  ...fakeBrowser,
  tabs: {
    ...fakeBrowser.tabs,
    get: mockTabsGet,
    group: mockTabsGroup,
    query: mockTabsQuery,
    create: mockTabsCreate,
    ungroup: mockTabsUngroup,
    remove: mockTabsRemove,
  },
  tabGroups: {
    get: mockTabGroupsGet,
    query: mockTabGroupsQuery,
    update: mockTabGroupsUpdate,
  },
  debugger: {
    sendCommand: mockDebuggerSendCommand,
    attach: vi.fn(),
    detach: vi.fn(),
    onEvent: { addListener: vi.fn(), hasListener: vi.fn() },
    onDetach: { addListener: vi.fn(), hasListener: vi.fn() },
    getTargets: vi.fn().mockResolvedValue([]),
  },
});

describe("CDPRouter", () => {
  let cdpRouter: CDPRouter;
  let tabManager: TabManager;
  let mockLogger: Logger;
  let mockSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();
    mockDebuggerSendCommand.mockReset();
    mockTabsGet.mockReset();
    mockTabsGroup.mockReset();
    mockTabsQuery.mockReset();
    mockTabsCreate.mockReset();
    mockTabsUngroup.mockReset().mockResolvedValue(undefined);
    mockTabsRemove.mockReset().mockResolvedValue(undefined);
    mockTabGroupsGet.mockReset();
    mockTabGroupsQuery.mockReset();
    mockTabGroupsUpdate.mockReset();

    mockLogger = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    mockSendMessage = vi.fn();

    tabManager = new TabManager({
      logger: mockLogger,
      sendMessage: mockSendMessage,
    });

    cdpRouter = new CDPRouter({
      logger: mockLogger,
      tabManager,
    });
  });

  describe("session tab groups", () => {
    const createTab = (key: string, title: string) =>
      cdpRouter.handleCommand({
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Target.createTarget",
          params: { url: "about:blank", group: { key, title } },
        },
      } as ExtensionCommandMessage);

    let nextTabId: number;
    let groups: Array<{ id: number; windowId: number; title: string }>;

    beforeEach(() => {
      nextTabId = 1;
      groups = [];
      mockTabsCreate.mockImplementation(async ({ windowId }: { windowId?: number }) => ({
        id: nextTabId++,
        windowId: windowId ?? 1,
      }));
      mockTabsGroup.mockImplementation(async ({ groupId }: { groupId?: number }) => {
        if (groupId !== undefined) return groupId;
        const group = { id: 100 + groups.length, windowId: 1, title: "" };
        groups.push(group);
        return group.id;
      });
      mockTabGroupsUpdate.mockImplementation(async (id: number, { title }: { title?: string }) => {
        if (title !== undefined) groups.find((group) => group.id === id)!.title = title;
      });
      mockTabGroupsGet.mockImplementation(async (id: number) => {
        const group = groups.find((g) => g.id === id);
        if (!group) throw new Error("No group");
        return group;
      });
      // Skip debugger attachment; these tests cover grouping only
      vi.spyOn(tabManager, "attach").mockResolvedValue({
        targetId: "t",
        type: "page",
        title: "",
        url: "about:blank",
        attached: true,
      });
    });

    it("puts concurrent tabs from one session in one group", async () => {
      await Promise.all([createTab("s1", "proj ab12"), createTab("s1", "proj ab12")]);

      expect(groups).toHaveLength(1);
      expect(mockTabGroupsUpdate).toHaveBeenCalledOnce();
      expect(mockTabGroupsUpdate).toHaveBeenCalledWith(100, {
        title: "🤖 proj ab12",
        color: groupColor("s1"),
      });
      expect(mockTabsGroup).toHaveBeenNthCalledWith(2, { tabIds: [2], groupId: 100 });
    });

    it("gives each session its own group", async () => {
      await createTab("s1", "proj ab12");
      await createTab("s2", "proj cd34");

      expect(groups.map((group) => group.title)).toEqual(["🤖 proj ab12", "🤖 proj cd34"]);
    });

    it("opens a session's later tabs in the window holding its group", async () => {
      await createTab("s1", "proj ab12");
      groups[0]!.windowId = 7; // the person dragged the group to another window

      await createTab("s1", "proj ab12");

      expect(mockTabsCreate).toHaveBeenLastCalledWith({
        url: "about:blank",
        active: false,
        windowId: 7,
      });
      expect(mockTabsGroup).toHaveBeenLastCalledWith({ tabIds: [2], groupId: 100 });
    });

    it("keeps using the session's group after a service-worker restart", async () => {
      await createTab("s1", "Aetna benefits");

      // A new router has an empty in-memory map; session storage still has the group
      cdpRouter = new CDPRouter({ logger: mockLogger, tabManager });
      await createTab("s1", "Aetna benefits");

      expect(groups).toHaveLength(1);
      expect(mockTabsGroup).toHaveBeenLastCalledWith({ tabIds: [2], groupId: 100 });
    });

    it("never joins another session's group that shares its title", async () => {
      await createTab("s1", "dev-browser");
      await createTab("s2", "dev-browser");

      expect(groups).toHaveLength(2);
    });

    it("renames the session's group", async () => {
      await createTab("s1", "dev-browser");

      await cdpRouter.handleCommand({
        id: 1,
        method: "renameGroup",
        params: { key: "s1", title: "Aetna benefits" },
      } as ExtensionCommandMessage);

      expect(mockTabGroupsUpdate).toHaveBeenLastCalledWith(100, { title: "🤖 Aetna benefits" });
    });

    it("ignores a rename for a session without a group", async () => {
      await cdpRouter.handleCommand({
        id: 1,
        method: "renameGroup",
        params: { key: "nobody", title: "x" },
      } as ExtensionCommandMessage);

      expect(mockTabGroupsUpdate).not.toHaveBeenCalled();
    });

    it("releases a tab by ungrouping it and detaching the debugger", async () => {
      vi.spyOn(tabManager, "has").mockReturnValue(true);
      const detach = vi.spyOn(tabManager, "detach").mockImplementation(() => {});

      await cdpRouter.handleCommand({
        id: 1,
        method: "releaseTab",
        params: { tabId: 9 },
      } as ExtensionCommandMessage);

      expect(mockTabsUngroup).toHaveBeenCalledWith(9);
      expect(detach).toHaveBeenCalledWith(9, true);
    });
  });

  describe("tab group sweep and collapse", () => {
    type Group = { id: number; windowId: number; title: string; collapsed: boolean };
    let groups: Group[];
    let tabsByGroup: Record<number, Array<{ id: number; active?: boolean }>>;

    const sweep = (live: Array<{ key: string; tabIds: number[] }>) =>
      cdpRouter.handleCommand({
        id: 1,
        method: "sweepGroups",
        params: { live },
      } as ExtensionCommandMessage);

    beforeEach(() => {
      groups = [];
      tabsByGroup = {};
      mockTabGroupsQuery.mockImplementation(async () => groups);
      mockTabGroupsGet.mockImplementation(async (id: number) => {
        const group = groups.find((g) => g.id === id);
        if (!group) throw new Error("No group");
        return group;
      });
      mockTabsQuery.mockImplementation(
        async ({ groupId, active }: { groupId: number; active?: boolean }) =>
          (tabsByGroup[groupId] ?? []).filter((tab) => !active || tab.active)
      );
    });

    const addGroup = (id: number, title: string, tabIds: number[]) => {
      groups.push({ id, windowId: 1, title, collapsed: false });
      tabsByGroup[id] = tabIds.map((tabId) => ({ id: tabId }));
    };

    it("closes agent groups no live session owns and leaves the person's groups alone", async () => {
      addGroup(1, "🤖 Old task", [11, 12]); // restored after a restart, session gone
      addGroup(2, "Dev Browser", [21]); // made by an older version
      addGroup(3, "Recipes", [31]); // the person's own group

      await expect(sweep([])).resolves.toEqual({ closedTabs: 3 });

      expect(mockTabsRemove).toHaveBeenCalledWith([11, 12]);
      expect(mockTabsRemove).toHaveBeenCalledWith([21]);
      expect(mockTabsRemove).not.toHaveBeenCalledWith([31]);
    });

    it("keeps a live session's group and closes an ended session's", async () => {
      await chrome.storage.session.set({ tabGroupIds: { live: 1, ended: 2 } });
      addGroup(1, "🤖 Live", [11]);
      addGroup(2, "🤖 Ended", [21]);

      await sweep([{ key: "live", tabIds: [] }]);

      expect(mockTabsRemove).toHaveBeenCalledOnce();
      expect(mockTabsRemove).toHaveBeenCalledWith([21]);
    });

    it("adopts a restored group that holds a live session's recovered tab", async () => {
      addGroup(5, "🤖 Aetna benefits", [51, 52]);

      await sweep([{ key: "s1", tabIds: [52] }]);

      expect(mockTabsRemove).not.toHaveBeenCalled();
      expect(await chrome.storage.session.get("tabGroupIds")).toEqual({
        tabGroupIds: { s1: 5 },
      });
    });

    it("collapses an idle session's group but not one the person is looking at", async () => {
      await chrome.storage.session.set({ tabGroupIds: { idle: 1, watched: 2 } });
      addGroup(1, "🤖 Idle", [11]);
      addGroup(2, "🤖 Watched", [21]);
      tabsByGroup[2]![0]!.active = true;

      for (const key of ["idle", "watched"]) {
        await cdpRouter.handleCommand({
          id: 1,
          method: "collapseGroup",
          params: { key, collapsed: true },
        } as ExtensionCommandMessage);
      }

      expect(mockTabGroupsUpdate).toHaveBeenCalledOnce();
      expect(mockTabGroupsUpdate).toHaveBeenCalledWith(1, { collapsed: true });
    });
  });

  describe("handleCommand", () => {
    it("should return early for non-forwardCDPCommand methods", async () => {
      const msg = {
        id: 1,
        method: "someOtherMethod" as const,
        params: { method: "Test.method" },
      };

      // @ts-expect-error - testing invalid method
      const result = await cdpRouter.handleCommand(msg);
      expect(result).toBeUndefined();
    });

    it("should throw error when no tab found for command", async () => {
      const msg: ExtensionCommandMessage = {
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Page.navigate",
          sessionId: "unknown-session",
        },
      };

      await expect(cdpRouter.handleCommand(msg)).rejects.toThrow(
        "No tab found for method Page.navigate"
      );
    });

    it("should find tab by sessionId", async () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      mockDebuggerSendCommand.mockResolvedValue({ result: "ok" });

      const msg: ExtensionCommandMessage = {
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Page.navigate",
          sessionId: "session-1",
          params: { url: "https://example.com" },
        },
      };

      await cdpRouter.handleCommand(msg);

      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 123, sessionId: undefined },
        "Page.navigate",
        { url: "https://example.com" }
      );
    });

    it("should find tab via child session", async () => {
      tabManager.set(123, {
        sessionId: "parent-session",
        targetId: "target-1",
        state: "connected",
      });
      tabManager.trackChildSession("child-session", 123);

      mockDebuggerSendCommand.mockResolvedValue({});

      const msg: ExtensionCommandMessage = {
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Runtime.evaluate",
          sessionId: "child-session",
        },
      };

      await cdpRouter.handleCommand(msg);

      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 123, sessionId: "child-session" },
        "Runtime.evaluate",
        undefined
      );
    });
  });

  describe("handleDebuggerEvent", () => {
    it("should forward CDP events to relay", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 123 },
        "Page.loadEventFired",
        { timestamp: 12345 },
        sendMessage
      );

      expect(sendMessage).toHaveBeenCalledWith({
        method: "forwardCDPEvent",
        params: {
          sessionId: "session-1",
          method: "Page.loadEventFired",
          params: { timestamp: 12345 },
        },
      });
    });

    it("should track child sessions on Target.attachedToTarget", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 123 },
        "Target.attachedToTarget",
        { sessionId: "new-child-session", targetInfo: {} },
        sendMessage
      );

      expect(tabManager.getParentTabId("new-child-session")).toBe(123);
    });

    it("should untrack child sessions on Target.detachedFromTarget", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });
      tabManager.trackChildSession("child-session", 123);

      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 123 },
        "Target.detachedFromTarget",
        { sessionId: "child-session" },
        sendMessage
      );

      expect(tabManager.getParentTabId("child-session")).toBeUndefined();
    });

    it("should ignore events for unknown tabs", () => {
      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent({ tabId: 999 }, "Page.loadEventFired", {}, sendMessage);

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
