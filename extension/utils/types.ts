/**
 * Types for extension-relay communication
 */

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type TabState = "connecting" | "connected" | "error";

export interface TabInfo {
  sessionId?: string;
  targetId?: string;
  state: TabState;
  errorText?: string;
}

export interface ExtensionState {
  tabs: Map<number, TabInfo>;
  connectionState: ConnectionState;
  currentTabId?: number;
  errorText?: string;
}

// Messages from relay to extension
export interface ForwardCDPCommandMessage {
  id: number;
  method: "forwardCDPCommand";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

export interface GetOrCreateSessionMessage {
  id: number;
  method: "getOrCreateSession";
  params: {
    sessionId: string;
  };
}

export interface CloseSessionMessage {
  id: number;
  method: "closeSession";
  params: {
    sessionId: string;
  };
}

export interface GetSessionTabsMessage {
  id: number;
  method: "getSessionTabs";
  params: {
    sessionId: string;
  };
}

export interface CreateTabMessage {
  id: number;
  method: "createTab";
  params: {
    sessionId: string;
    url?: string;
  };
}

export interface CloseTabMessage {
  id: number;
  method: "closeTab";
  params: {
    tabId: number;
  };
}

export type ExtensionCommandMessage =
  | ForwardCDPCommandMessage
  | GetOrCreateSessionMessage
  | CloseSessionMessage
  | GetSessionTabsMessage
  | CreateTabMessage
  | CloseTabMessage;

// Messages from extension to relay (responses)
export interface ExtensionResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

// Messages from extension to relay (events)
export interface ExtensionEventMessage {
  method: "forwardCDPEvent";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

// Log message from extension to relay
export interface ExtensionLogMessage {
  method: "log";
  params: {
    level: string;
    args: string[];
  };
}

export type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | ExtensionLogMessage;

// Chrome debugger target info
export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

// Popup <-> Background messaging
export interface GetStateMessage {
  type: "getState";
}

export interface SetStateMessage {
  type: "setState";
  isActive: boolean;
}

export interface StateResponse {
  isActive: boolean;
  isConnected: boolean;
}

export type PopupMessage = GetStateMessage | SetStateMessage;
