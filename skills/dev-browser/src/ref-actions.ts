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
