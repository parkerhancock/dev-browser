/**
 * Set a form control by snapshot ref: text inputs, textareas, selects,
 * checkboxes, radios, and contenteditable elements. Runs in the world the
 * Page evaluates in, which is where read_page stored the refs.
 */

import type { Page } from "./page.js";

const SET_VALUE_SCRIPT = (ref: string, value: string | number | boolean): string => `(() => {
  const ref = ${JSON.stringify(ref)};
  const value = ${JSON.stringify(value)};
  const refs = globalThis.__devBrowserRefs;
  if (!refs) throw new Error("No snapshot refs found. Call read_page first.");
  const el = refs[ref];
  if (!el) throw new Error("Ref " + ref + " not found. Call read_page again.");
  const fire = () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const tag = el.tagName;
  if (tag === "SELECT") {
    const opt = Array.from(el.options).find((o) => o.value === String(value) || o.text.trim() === String(value));
    if (!opt) throw new Error("No option " + JSON.stringify(String(value)) + " in ref " + ref);
    el.value = opt.value;
    fire();
    return "selected " + JSON.stringify(opt.text.trim());
  }
  if (tag === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
    const want = el.type === "radio" || value === true || value === "true" || value === "on";
    if (el.checked !== want) el.click();
    return (el.checked ? "checked" : "unchecked");
  }
  if (el.isContentEditable) {
    el.focus();
    el.textContent = String(value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return "set text";
  }
  if (tag === "INPUT" || tag === "TEXTAREA") {
    el.focus();
    // The prototype setter, so frameworks that track value (React) see a change
    const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    fire();
    return "set value";
  }
  throw new Error("Ref " + ref + " is a <" + tag.toLowerCase() + ">, not a form control");
})()`;

/** Set the form control at `ref` to `value`; returns what was done. */
export async function setRefValue(page: Page, ref: string, value: string | number | boolean): Promise<string> {
  return page.evaluate<string>(SET_VALUE_SCRIPT(ref, value));
}

export interface DropFile {
  /** File contents, base64. */
  data: string;
  name: string;
  mimeType: string;
}

/**
 * Drop a file onto a page element, as if dragged in from the desktop: the
 * element at `ref`, or the one at viewport point (x, y). Fires dragenter,
 * dragover, and drop with a DataTransfer holding the file.
 */
export async function dropFile(
  page: Page,
  file: DropFile,
  target: { ref?: string; x?: number; y?: number }
): Promise<string> {
  return page.evaluate<string>(`(() => {
    const file = ${JSON.stringify(file)};
    const target = ${JSON.stringify(target)};
    let el;
    if (target.ref) {
      const refs = globalThis.__devBrowserRefs;
      el = refs && refs[target.ref];
      if (!el) throw new Error("Ref " + target.ref + " not found. Call read_page again.");
    } else {
      el = document.elementFromPoint(target.x, target.y);
      if (!el) throw new Error("Nothing at (" + target.x + ", " + target.y + ")");
    }
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    const rect = el.getBoundingClientRect();
    const point = target.ref
      ? { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
      : { clientX: target.x, clientY: target.y };
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, ...point }));
    }
    return "dropped " + file.name + " on <" + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ">";
  })()`);
}

/** Whether the element at `ref` is an <input type=file>. */
export async function isFileInputRef(page: Page, ref: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const el = (globalThis.__devBrowserRefs || {})[${JSON.stringify(ref)}];
    return !!el && el.tagName === "INPUT" && el.type === "file";
  })()`);
}
