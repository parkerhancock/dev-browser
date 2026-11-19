/**
 * dev-browser Chrome Extension Background Script
 *
 * This extension connects to the dev-browser relay server and allows
 * Playwright automation of the user's existing browser tabs.
 */

import { createLogger } from "../utils/logger";
import { TabManager } from "../services/TabManager";
import {
  ConnectionManager,
  allowSshAccess,
  hasSshApproval,
  relayHostApprovalFingerprint,
} from "../services/ConnectionManager";
import { CDPRouter } from "../services/CDPRouter";
import { StateManager } from "../services/StateManager";
import { DownloadManager } from "../services/DownloadManager";
import type { PopupMessage, StateResponse } from "../utils/types";

export default defineBackground(() => {
  // Create connection manager first (needed for sendMessage)
  let connectionManager: ConnectionManager;

  // Create logger with sendMessage function
  const logger = createLogger((msg) => connectionManager?.send(msg));

  // Create state manager for persistence
  const stateManager = new StateManager();

  // Create tab manager
  const tabManager = new TabManager({
    logger,
    sendMessage: (msg) => connectionManager.send(msg),
  });

  // Create CDP router
  const cdpRouter = new CDPRouter({
    logger,
    tabManager,
  });

  // Create connection manager
  connectionManager = new ConnectionManager({
    logger,
    onMessage: (msg) => cdpRouter.handleCommand(msg),
    onDisconnect: () => tabManager.detachAll(),
    onApproved: () =>
      void stateManager
        .getState()
        .then((state) => stateManager.setState({ ...state, sshEnabled: true })),
  });

  // Forward download lifecycle events to the relay
  const downloadManager = new DownloadManager({
    logger,
    sendMessage: (msg) => connectionManager.send(msg),
  });
  downloadManager.start();

  // Keep-alive alarm name for Chrome Alarms API
  const KEEPALIVE_ALARM = "keepAlive";

  // Update badge to show active/inactive state
  function updateBadge(isActive: boolean): void {
    chrome.action.setBadgeText({ text: isActive ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  }

  // Handle state changes
  async function handleStateChange(isActive: boolean, sshEnabled = false): Promise<void> {
    connectionManager.setSshAccess(isActive && sshEnabled);
    if (!isActive) connectionManager.disconnect();
    await stateManager.setState({ isActive, sshEnabled: isActive && sshEnabled });
    if (isActive) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      connectionManager.startMaintaining();
    } else {
      chrome.alarms.clear(KEEPALIVE_ALARM);
    }
    updateBadge(isActive);
  }

  // Handle debugger events
  function onDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown
  ): void {
    cdpRouter.handleDebuggerEvent(source, method, params, (msg) => connectionManager.send(msg));
  }

  function onDebuggerDetach(
    source: chrome.debugger.Debuggee,
    reason: `${chrome.debugger.DetachReason}`
  ): void {
    const tabId = source.tabId;
    if (!tabId) return;

    logger.debug(`Debugger detached for tab ${tabId}: ${reason}`);
    void tabManager.handleDebuggerDetach(tabId, reason);
  }

  let approvingSsh = false;
  let popupStateVersion = 0;

  async function popupState(error?: string): Promise<StateResponse> {
    const state = await stateManager.getState();
    return {
      isActive: state.isActive,
      isConnected: await connectionManager.checkConnection(),
      sshApproved: await hasSshApproval(),
      sshEnabled: state.isActive && state.sshEnabled === true,
      sshConnected: connectionManager.isSshConnected(),
      sshPendingFingerprint: await relayHostApprovalFingerprint(),
      error,
    };
  }

  // Handle messages from popup
  chrome.runtime.onMessage.addListener(
    (
      message: PopupMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: StateResponse) => void
    ) => {
      if (message.type === "getState") {
        void popupState().then(sendResponse, () => sendResponse({ isActive: false, isConnected: false }));
        return true;
      }
      if (sender.url !== chrome.runtime.getURL("popup.html")) return false;

      if (message.type === "setSshAccess") {
        if (approvingSsh) {
          void popupState("Approval is already in progress").then(sendResponse);
          return true;
        }
        approvingSsh = true;
        const version = ++popupStateVersion;
        void (async () => {
          try {
            const approved = await hasSshApproval();
            if (message.enabled && !approved) await allowSshAccess();
            if (version === popupStateVersion) {
              const state = await stateManager.getState();
              if (version === popupStateVersion) {
                if (message.enabled && !approved) connectionManager.disconnect();
                await handleStateChange(message.enabled || state.isActive, message.enabled);
              }
            }
            sendResponse(await popupState());
          } catch (error) {
            sendResponse(await popupState(error instanceof Error ? error.message : "SSH access could not be changed"));
          } finally {
            approvingSsh = false;
          }
        })();
        return true;
      }

      if (message.type === "setState") {
        popupStateVersion++;
        void handleStateChange(message.isActive)
          .then(() => popupState(), () => popupState("Browser control could not be changed"))
          .then(sendResponse);
        return true;
      }

      return false;
    }
  );

  // Set up event listeners

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabManager.has(tabId)) {
      logger.debug("Tab closed:", tabId);
      tabManager.detach(tabId, false);
    }
  });

  // Track URL changes for attached tabs and synthesize Target.targetInfoChanged events
  // Chrome's debugger API doesn't forward browser-level Target events, so we use tabs API
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only process URL changes for tabs we have attached to
    const tabInfo = tabManager.get(tabId);
    if (!tabInfo || tabInfo.state !== "connected" || !tabInfo.sessionId) return;

    // Only care about URL changes (status changes, title changes, etc. don't matter for URL tracking)
    if (!changeInfo.url) return;

    logger.debug(`Tab ${tabId} URL changed to: ${changeInfo.url}`);

    // Synthesize a Target.targetInfoChanged event with the new URL
    // This mirrors what CDP would send at the browser level
    connectionManager.send({
      method: "forwardCDPEvent",
      params: {
        sessionId: tabInfo.sessionId,
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: {
            targetId: tabInfo.targetId,
            type: "page",
            title: tab.title || "",
            url: changeInfo.url,
            attached: true,
          },
        },
      },
    });
  });

  // Register debugger event listeners
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);

  // Reset any stale debugger connections on startup
  chrome.debugger.getTargets().then((targets) => {
    const attached = targets.filter((t) => t.tabId && t.attached);
    if (attached.length > 0) {
      logger.log(`Detaching ${attached.length} stale debugger connections`);
      for (const target of attached) {
        chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
      }
    }
  });

  logger.log("Extension initialized");

  // Initialize from stored state
  stateManager
    .getState()
    .then((state) => {
      updateBadge(state.isActive);
      if (state.isActive) {
        connectionManager.setSshAccess(state.sshEnabled === true);
        // Create keep-alive alarm only when extension is active
        chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
        connectionManager.startMaintaining();
      }
    })
    .catch((err) => {
      logger.debug("Error loading initial state, defaulting to inactive:", err);
      updateBadge(false);
    });

  // Set up Chrome Alarms keep-alive listener
  // This ensures the connection is maintained even after service worker unloads
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
      const state = await stateManager.getState();

      if (state.isActive) {
        const isConnected = connectionManager.isConnected();

        if (!isConnected) {
          logger.debug("Keep-alive: Connection lost, restarting...");
          connectionManager.startMaintaining();
        }
      }
    }
  });
});
