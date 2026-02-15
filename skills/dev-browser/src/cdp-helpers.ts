/**
 * CDP helper utilities — key code mapping and element coordinate resolution.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text: string;
}

const KEY_MAP: Record<string, KeyDefinition> = {
  // Navigation
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, text: "" },
  Delete: { key: "Delete", code: "Delete", keyCode: 46, text: "" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27, text: "" },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },

  // Arrow keys
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, text: "" },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, text: "" },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, text: "" },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, text: "" },

  // Page navigation
  Home: { key: "Home", code: "Home", keyCode: 36, text: "" },
  End: { key: "End", code: "End", keyCode: 35, text: "" },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33, text: "" },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34, text: "" },
  Insert: { key: "Insert", code: "Insert", keyCode: 45, text: "" },

  // Modifiers
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, text: "" },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, text: "" },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, text: "" },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, text: "" },

  // Function keys
  F1: { key: "F1", code: "F1", keyCode: 112, text: "" },
  F2: { key: "F2", code: "F2", keyCode: 113, text: "" },
  F3: { key: "F3", code: "F3", keyCode: 114, text: "" },
  F4: { key: "F4", code: "F4", keyCode: 115, text: "" },
  F5: { key: "F5", code: "F5", keyCode: 116, text: "" },
  F6: { key: "F6", code: "F6", keyCode: 117, text: "" },
  F7: { key: "F7", code: "F7", keyCode: 118, text: "" },
  F8: { key: "F8", code: "F8", keyCode: 119, text: "" },
  F9: { key: "F9", code: "F9", keyCode: 120, text: "" },
  F10: { key: "F10", code: "F10", keyCode: 121, text: "" },
  F11: { key: "F11", code: "F11", keyCode: 122, text: "" },
  F12: { key: "F12", code: "F12", keyCode: 123, text: "" },
};

// Modifier bit flags for CDP Input.dispatchKeyEvent
const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

/**
 * Resolve a key name to its CDP key definition.
 * Handles named keys (Enter, Tab, etc.) and single characters (a, A, 1, etc.).
 */
export function resolveKey(key: string): KeyDefinition {
  // Named key
  if (KEY_MAP[key]) return KEY_MAP[key];

  // Single character
  if (key.length === 1) {
    const charCode = key.charCodeAt(0);
    const upper = key.toUpperCase();
    // Letters: keyCode is uppercase ASCII
    if (/^[a-zA-Z]$/.test(key)) {
      return {
        key,
        code: `Key${upper}`,
        keyCode: upper.charCodeAt(0),
        text: key,
      };
    }
    // Digits
    if (/^[0-9]$/.test(key)) {
      return { key, code: `Digit${key}`, keyCode: charCode, text: key };
    }
    // Other characters (punctuation, etc.)
    return { key, code: "", keyCode: charCode, text: key };
  }

  // Unknown key name — pass through
  return { key, code: key, keyCode: 0, text: "" };
}

/**
 * Parse a compound key like "Control+a" or "Shift+Enter" into parts.
 * Returns { modifiers: string[], key: string }.
 */
export function parseKeyCombo(combo: string): {
  modifiers: string[];
  key: string;
} {
  const parts = combo.split("+");
  const key = parts.pop()!;
  return { modifiers: parts, key };
}

/**
 * Compute the CDP modifiers bitmask from a list of modifier key names.
 */
export function computeModifiers(modifiers: string[]): number {
  let mask = 0;
  for (const mod of modifiers) {
    mask |= MODIFIER_FLAGS[mod] ?? 0;
  }
  return mask;
}

/**
 * Build the JS expression to resolve an element's center coordinates from a CSS selector.
 * Returns { x, y } or throws if element not found.
 */
export function elementCenterExpression(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) throw new Error('Element not found: ' + ${sel});
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`;
}

/**
 * CDP mouse button name to CDP button number.
 */
export function mouseButton(button?: "left" | "right" | "middle"): number {
  switch (button) {
    case "right":
      return 2;
    case "middle":
      return 1;
    default:
      return 0;
  }
}
