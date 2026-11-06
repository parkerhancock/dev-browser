/**
 * DownloadManager - Forwards chrome.downloads lifecycle events to the relay
 * so agents can wait for and retrieve downloads (parity plan P1 #8).
 */

import type { Logger } from "../utils/logger";
import type { DownloadEventParams } from "../utils/types";

export interface DownloadManagerDeps {
  logger: Logger;
  sendMessage: (msg: unknown) => void;
}

function mapState(state?: `${chrome.downloads.State}`): DownloadEventParams["state"] {
  switch (state) {
    case "complete":
      return "completed";
    case "interrupted":
      return "interrupted";
    default:
      return "inProgress";
  }
}

export class DownloadManager {
  private logger: Logger;
  private sendMessage: (msg: unknown) => void;

  constructor(deps: DownloadManagerDeps) {
    this.logger = deps.logger;
    this.sendMessage = deps.sendMessage;
  }

  start(): void {
    chrome.downloads.onCreated.addListener(this.onCreated);
    chrome.downloads.onChanged.addListener(this.onChanged);
  }

  private sendEvent(params: DownloadEventParams): void {
    this.sendMessage({ method: "downloadEvent", params });
  }

  private onCreated = (item: chrome.downloads.DownloadItem): void => {
    this.logger.debug(`Download started: ${item.finalUrl || item.url}`);
    this.sendEvent({
      id: item.id,
      url: item.finalUrl || item.url,
      filename: item.filename || undefined,
      state: mapState(item.state),
      mime: item.mime || undefined,
      startTime: item.startTime,
    });
  };

  private onChanged = (delta: chrome.downloads.DownloadDelta): void => {
    // Only state and filename transitions matter to the relay
    if (!delta.state && !delta.filename) return;

    // The delta carries fragments; look up the full item for path/size
    chrome.downloads
      .search({ id: delta.id })
      .then((items) => {
        const item = items[0];
        if (!item) return;
        this.sendEvent({
          id: item.id,
          url: item.finalUrl || item.url,
          filename: item.filename || undefined,
          state: mapState(item.state),
          fileSize: item.fileSize >= 0 ? item.fileSize : undefined,
          mime: item.mime || undefined,
          startTime: item.startTime,
        });
      })
      .catch((err) => {
        this.logger.debug("Error looking up download:", err);
      });
  };
}
