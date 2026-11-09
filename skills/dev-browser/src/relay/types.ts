/**
 * Relay types: public options and results, and the extension's message shapes.
 */

import type { TargetInfo } from "../relay-registry.js";
import type { RelayPolicy } from "../policy.js";

export type DialogPolicy = "dismiss" | "accept" | "ignore";

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Require the shared token on HTTP requests and WS upgrades (default: true). */
  requireAuth?: boolean;
  /** Override the token (default: load/create ~/.dev-browser/token). */
  token?: string;
  /** What to do with JS dialogs (alert/confirm/prompt). Default: "dismiss". */
  dialogPolicy?: DialogPolicy;
  /** Override the policy (default: load ~/.dev-browser/policy.json). */
  policy?: RelayPolicy;
  /**
   * Optional raw Node handler mounted at ALL /mcp — lets the CLI serve the
   * MCP streamable-HTTP endpoint from the relay's port.
   */
  mcpHandler?: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void | Promise<void>;
}

/** A download tracked by the relay (reported by the extension's chrome.downloads listeners). */
export interface DownloadRecord {
  /** chrome.downloads item id */
  id: number;
  url: string;
  /** Absolute path on disk, once Chrome has determined it */
  path?: string;
  /** Filename the page suggested (standalone mode only) */
  suggestedFilename?: string;
  state: "inProgress" | "completed" | "interrupted";
  startedAt: number;
  updatedAt: number;
  fileSize?: number;
  mime?: string;
}

/** Browser identification sent by the extension on connect. */
export interface ExtensionBrowserInfo {
  /** "chrome" | "msedge" | "brave" | "opera" | "vivaldi" | "chromium" | "unknown" */
  browser: string;
  version?: string;
  userAgent?: string;
}

/** A console message captured from a page. */
export interface ConsoleMessage {
  /** "log" | "info" | "warning" | "error" | "debug" | ... */
  level: string;
  text: string;
  /** Where it came from: console API call, browser log, or thrown exception. */
  source: "console" | "log" | "exception";
  timestamp: number;
  url?: string;
  line?: number;
}

export interface RelayServer {
  wsEndpoint: string;
  port: number;
  stop(): Promise<void>;
}

// TargetInfo, ConnectedTarget, and SessionState live in ../relay-registry.js

// Message types for extension communication
export interface ExtensionCommandMessage {
  id: number;
  method: "forwardCDPCommand";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

export interface ExtensionResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

export interface ExtensionEventMessage {
  method: "forwardCDPEvent";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

export interface ChildTarget {
  sessionId: string;
  parentSessionId: string;
  targetInfo: TargetInfo;
}

export interface ExtensionDownloadEventParams {
  id: number;
  url: string;
  filename?: string;
  state: "inProgress" | "completed" | "interrupted";
  fileSize?: number;
  mime?: string;
  startTime?: string;
}

export type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | { method: "log"; params: { level: string; args: string[] } }
  | { method: "browserInfo"; params: ExtensionBrowserInfo }
  | { method: "downloadEvent"; params: ExtensionDownloadEventParams };

// ============================================================================
// Relay Server Implementation
// ============================================================================
