/**
 * dev-browser Chrome Extension Background Script
 *
 * This extension connects to the dev-browser relay server and allows
 * Playwright automation of the user's existing browser tabs.
 *
 * Tab group-based isolation: each agent session gets its own tab group.
 * Tabs spawned by an agent's actions automatically join that group.
 */

import { createLogger } from "../utils/logger";
import { TabManager } from "../services/TabManager";
import { ConnectionManager } from "../services/ConnectionManager";
import { CDPRouter } from "../services/CDPRouter";
import { StateManager } from "../services/StateManager";
import { SessionManager } from "../services/SessionManager";
import type { PopupMessage, StateResponse } from "../utils/types";

export default defineBackground(() => {
  // Create connection manager first (needed for sendMessage)
  let connectionManager: ConnectionManager;

  // Create logger with sendMessage function
  const logger = createLogger((msg) => connectionManager?.send(msg));

  // Create state manager for persistence
  const stateManager = new StateManager();

  // Create session manager for tab group-based isolation
  const sessionManager = new SessionManager({ logger });

  // Create tab manager
  const tabManager = new TabManager({
    logger,
    sendMessage: (msg) => connectionManager.send(msg),
  });

  // Create CDP router with session manager
  const cdpRouter = new CDPRouter({
    logger,
    tabManager,
    sessionManager,
  });

  // Create connection manager
  connectionManager = new ConnectionManager({
    logger,
    onMessage: (msg) => cdpRouter.handleCommand(msg),
    onConnect: () => {
      // Re-announce existing targets when a client connects
      // so Playwright sees tabs that were attached before reconnection
      logger.debug("Relay connected, re-announcing existing targets");
      tabManager.reannounceTargets().catch((err) => {
        logger.debug("Error re-announcing targets:", err);
      });
    },
    onDisconnect: () => {
      // DON'T detach debuggers on disconnect - keep them attached
      // so tabs remain accessible when a new client connects.
      // The debugger sessions persist and will be re-announced
      // via Target.attachedToTarget when a new client connects.
      logger.debug("Relay disconnected, keeping debuggers attached");
    },
  });

  // Keep-alive alarm name for Chrome Alarms API
  const KEEPALIVE_ALARM = "keepAlive";

  // Update badge to show active/inactive state
  function updateBadge(isActive: boolean): void {
    chrome.action.setBadgeText({ text: isActive ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  }

  // Handle state changes
  async function handleStateChange(isActive: boolean): Promise<void> {
    await stateManager.setState({ isActive });
    if (isActive) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      connectionManager.startMaintaining();
    } else {
      chrome.alarms.clear(KEEPALIVE_ALARM);
      connectionManager.disconnect();
    }
    updateBadge(isActive);
  }

  // Handle debugger events - routes to owning agent session
  function onDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown
  ): void {
    cdpRouter.handleDebuggerEvent(source, method, params, (msg, agentSession) => {
      // Send with agent session for routing on relay side
      if (agentSession) {
        connectionManager.send({ ...(msg as object), _agentSession: agentSession });
      } else {
        connectionManager.send(msg);
      }
    });
  }

  function onDebuggerDetach(
    source: chrome.debugger.Debuggee,
    reason: `${chrome.debugger.DetachReason}`
  ): void {
    const tabId = source.tabId;
    if (!tabId) return;

    logger.debug(`Debugger detached for tab ${tabId}: ${reason}`);
    tabManager.handleDebuggerDetach(tabId);
  }

  // Handle spawned tabs: when a tab opens from an agent's tab, add it to the same group
  async function onTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    if (!tab.id || !tab.openerTabId) return;

    // Check if the opener tab is in a managed session group
    const agentSession = await sessionManager.getSessionForTab(tab.openerTabId);
    if (!agentSession) return;

    logger.debug(`Spawned tab ${tab.id} from tab ${tab.openerTabId} (session: ${agentSession})`);

    try {
      // Add the new tab to the same session's group
      await sessionManager.addTabToSession(tab.id, agentSession);

      // Attach debugger to the new tab
      await new Promise((resolve) => setTimeout(resolve, 100)); // Let tab initialize
      const targetInfo = await tabManager.attach(tab.id);

      // Notify relay about the new tab
      const tabInfo = tabManager.get(tab.id);
      if (tabInfo) {
        connectionManager.send({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: tabInfo.sessionId,
              targetInfo: { ...targetInfo, attached: true },
              waitingForDebugger: false,
            },
          },
          _agentSession: agentSession,
        });
      }

      logger.log(`Auto-attached spawned tab ${tab.id} to session ${agentSession}`);
    } catch (err) {
      logger.debug(`Failed to auto-attach spawned tab ${tab.id}:`, err);
    }
  }

  // Handle messages from popup
  chrome.runtime.onMessage.addListener(
    (
      message: PopupMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: StateResponse) => void
    ) => {
      if (message.type === "getState") {
        (async () => {
          const state = await stateManager.getState();
          const isConnected = await connectionManager.checkConnection();
          sendResponse({
            isActive: state.isActive,
            isConnected,
          });
        })();
        return true; // Async response
      }

      if (message.type === "setState") {
        (async () => {
          await handleStateChange(message.isActive);
          const state = await stateManager.getState();
          const isConnected = await connectionManager.checkConnection();
          sendResponse({
            isActive: state.isActive,
            isConnected,
          });
        })();
        return true; // Async response
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

  // Listen for new tabs to detect spawned tabs
  chrome.tabs.onCreated.addListener((tab) => {
    onTabCreated(tab).catch((err) => {
      logger.debug("Error handling tab creation:", err);
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

  // Initialize session manager and extension state
  (async () => {
    await sessionManager.initialize();
    logger.log("Extension initialized");

    const state = await stateManager.getState();
    updateBadge(state.isActive);
    if (state.isActive) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      connectionManager.startMaintaining();
    }
  })();

  // Set up Chrome Alarms keep-alive listener
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
