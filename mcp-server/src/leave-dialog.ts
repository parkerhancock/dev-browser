/**
 * "Leave site?" (beforeunload) dialogs during navigate. A page with unsaved
 * changes can ask to confirm leaving. Without force, navigate dismisses the
 * dialog, so the page stays and its changes survive; with force, it accepts
 * the dialog and the changes are discarded.
 *
 * Standalone pages are Playwright pages, so a dialog listener decides. In
 * extension mode the relay answers every dialog itself, so it's told what to
 * do with the next ones (DevBrowser.setBeforeUnloadPolicy).
 */

import type { Page } from "../../skills/dev-browser/src/page.js";
import { CDPPage } from "../../skills/dev-browser/src/cdp-page.js";

interface Dialog {
  type(): string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
}

interface DialogEmitter {
  on(event: "dialog", listener: (dialog: Dialog) => void): unknown;
  off(event: "dialog", listener: (dialog: Dialog) => void): unknown;
}

export interface LeaveDialogOutcome<T> {
  result?: T;
  /** The navigation's error, unless a dismissed dialog explains it. */
  error?: unknown;
  /** "Leave site?" dialogs the page showed during the navigation. */
  dialogs: number;
}

export async function navigateHandlingLeaveDialog<T>(
  page: Page,
  accept: boolean,
  navigate: () => Promise<T>
): Promise<LeaveDialogOutcome<T>> {
  let dialogs = 0;
  let result: T | undefined;
  let error: unknown;

  if (page instanceof CDPPage) {
    await page.cdp("DevBrowser.setBeforeUnloadPolicy", { accept });
    try {
      result = await navigate();
    } catch (err) {
      error = err;
    } finally {
      dialogs = (await page.cdp<{ dialogs: number }>("DevBrowser.takeBeforeUnloadDialogs")).dialogs;
    }
  } else {
    const emitter = page as unknown as DialogEmitter;
    // With a listener attached Playwright no longer auto-handles dialogs, so
    // this one answers every type: other dialogs are dismissed as before.
    const onDialog = (dialog: Dialog) => {
      if (dialog.type() === "beforeunload") {
        dialogs++;
        void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
      } else {
        void dialog.dismiss().catch(() => {});
      }
    };
    emitter.on("dialog", onDialog);
    try {
      result = await navigate();
    } catch (err) {
      error = err;
    } finally {
      emitter.off("dialog", onDialog);
    }
  }

  // Dismissing the dialog cancels the navigation, which surfaces as an abort
  if (dialogs > 0 && !accept) error = undefined;
  return { result, error, dialogs };
}
