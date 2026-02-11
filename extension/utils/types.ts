/**
 * Types for extension-relay communication
 */

export type TabState = "connecting" | "connected" | "error";

export interface TabInfo {
  sessionId?: string;
  targetId?: string;
  state: TabState;
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

export interface GetAvailableTargetsMessage {
  id: number;
  method: "getAvailableTargets";
  params?: Record<string, unknown>;
}

export interface AttachToTabMessage {
  id: number;
  method: "attachToTab";
  params: {
    tabId: number;
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
  | GetAvailableTargetsMessage
  | AttachToTabMessage
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
