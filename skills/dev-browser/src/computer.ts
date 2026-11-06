/**
 * Mouse, keyboard, and screenshot actions addressed by viewport coordinates or
 * snapshot refs. Backs the MCP `computer` tool and runs against the unified
 * Page interface, so both modes share one implementation.
 *
 * Coordinates are CSS pixels. Screenshots are captured at CSS scale, so a pixel
 * in the image is the same coordinate a click takes, on HiDPI displays too.
 */

import { parseKeyCombo } from "./cdp-helpers.js";
import type { Page } from "./page.js";

export const COMPUTER_ACTIONS = [
  "left_click",
  "right_click",
  "double_click",
  "triple_click",
  "type",
  "key",
  "scroll",
  "scroll_to",
  "left_click_drag",
  "hover",
  "screenshot",
  "zoom",
  "wait",
] as const;

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export interface ComputerInput {
  action: ComputerAction;
  /** [x, y] target. Click actions and hover accept `ref` instead. */
  coordinate?: number[];
  /** Element ref from a snapshot, e.g. "e12". */
  ref?: string;
  /** [x, y] drag start for left_click_drag. */
  start_coordinate?: number[];
  /** Text for `type`; space-separated keys or combos for `key`. */
  text?: string;
  /** Times to repeat the key sequence (1-100). */
  repeat?: number;
  /** Modifier keys held during a click, e.g. "shift" or "ctrl+shift". */
  modifiers?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  /** Wheel ticks, default 3. */
  scroll_amount?: number;
  /** Seconds to wait (0-10). */
  duration?: number;
  /** [x0, y0, x1, y1] region for `zoom`. */
  region?: number[];
}

export interface ComputerResult {
  message: string;
  image?: Buffer;
}

const SCROLL_TICK_PX = 100;
const MAX_WAIT_SECONDS = 10;
const MAX_KEY_REPEAT = 100;
const DRAG_STEPS = 10;

const MODIFIER_NAMES: Record<string, string> = {
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  win: "Meta",
  windows: "Meta",
  super: "Meta",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const KEY_NAMES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

function modifierName(name: string): string {
  const mapped = MODIFIER_NAMES[name.toLowerCase()];
  if (!mapped) throw new Error(`Unknown modifier: "${name}"`);
  return mapped;
}

function keyName(name: string): string {
  if (name.length === 1) return name;
  const lower = name.toLowerCase();
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  return KEY_NAMES[lower] ?? name;
}

/** Normalize "cmd+a" to the Playwright-style "Meta+a". */
export function normalizeKeyCombo(combo: string): string {
  const { modifiers, key } = parseKeyCombo(combo);
  return [...modifiers.map(modifierName), keyName(key)].join("+");
}

function point(value: number[] | undefined, label: string): { x: number; y: number } {
  const [x, y] = value ?? [];
  if (value?.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} must be [x, y]`);
  }
  return { x: x!, y: y! };
}

/** Scroll a snapshot ref into view and return its center. */
async function refCenter(page: Page, ref: string): Promise<{ x: number; y: number }> {
  const id = JSON.stringify(ref);
  return page.evaluate(`(() => {
    const refs = globalThis.__devBrowserRefs;
    if (!refs) throw new Error("No snapshot refs found. Call read_page first.");
    const el = refs[${id}];
    if (!el) throw new Error("Ref " + ${id} + " not found. Call read_page again.");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
}

async function target(page: Page, input: ComputerInput): Promise<{ x: number; y: number }> {
  if (input.ref) return refCenter(page, input.ref);
  return point(input.coordinate, "coordinate (or ref)");
}

/** Run `fn` with modifier keys held, releasing them even if it throws. */
async function withModifiers(
  page: Page,
  modifiers: string | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const keys = modifiers ? modifiers.split("+").map(modifierName) : [];
  const held: string[] = [];
  try {
    for (const key of keys) {
      await page.keyboard.down(key);
      held.push(key);
    }
    await fn();
  } finally {
    for (const key of held.reverse()) await page.keyboard.up(key);
  }
}

async function click(
  page: Page,
  input: ComputerInput,
  options: { button?: "left" | "right"; clickCount?: number }
): Promise<ComputerResult> {
  const { x, y } = await target(page, input);
  await withModifiers(page, input.modifiers, () => page.mouse.click(x, y, options));
  return { message: `${input.action} at (${Math.round(x)}, ${Math.round(y)})` };
}

async function screenshot(page: Page): Promise<ComputerResult> {
  const image = await page.screenshot({ scale: "css" });
  const size = await page.evaluate<{ width: number; height: number }>(
    "({ width: window.innerWidth, height: window.innerHeight })"
  );
  return {
    message: `Screenshot of the ${size.width}x${size.height} viewport. Image pixels are click coordinates.`,
    image,
  };
}

async function zoom(page: Page, region: number[] | undefined): Promise<ComputerResult> {
  const [x0, y0, x1, y1] = region ?? [];
  if (region?.length !== 4 || !(x1! > x0!) || !(y1! > y0!)) {
    throw new Error("region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0");
  }
  const clip = { x: x0!, y: y0!, width: x1! - x0!, height: y1! - y0! };
  return {
    message: `Region (${x0}, ${y0}) to (${x1}, ${y1}). Coordinates stay in the full viewport frame.`,
    image: await page.screenshot({ clip }),
  };
}

async function pressKeys(page: Page, input: ComputerInput): Promise<ComputerResult> {
  const keys = (input.text ?? "").split(/\s+/).filter(Boolean).map(normalizeKeyCombo);
  if (keys.length === 0) throw new Error("text is required for key");
  const repeat = input.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_KEY_REPEAT) {
    throw new Error(`repeat must be an integer from 1 to ${MAX_KEY_REPEAT}`);
  }
  for (let i = 0; i < repeat; i++) {
    for (const key of keys) await page.keyboard.press(key);
  }
  return { message: `Pressed ${keys.join(" ")}${repeat > 1 ? ` x${repeat}` : ""}` };
}

async function scroll(page: Page, input: ComputerInput): Promise<ComputerResult> {
  const { x, y } = point(input.coordinate, "coordinate");
  const distance = (input.scroll_amount ?? 3) * SCROLL_TICK_PX;
  const deltas = {
    up: [0, -distance],
    down: [0, distance],
    left: [-distance, 0],
    right: [distance, 0],
  } as const;
  const direction = input.scroll_direction;
  if (!direction || !(direction in deltas)) {
    throw new Error("scroll_direction must be up, down, left, or right");
  }
  await page.mouse.move(x, y);
  await page.mouse.wheel(deltas[direction][0], deltas[direction][1]);
  return { message: `Scrolled ${direction} ${distance}px at (${x}, ${y})` };
}

async function drag(page: Page, input: ComputerInput): Promise<ComputerResult> {
  const from = point(input.start_coordinate, "start_coordinate");
  const to = point(input.coordinate, "coordinate");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: DRAG_STEPS });
  await page.mouse.up();
  return { message: `Dragged (${from.x}, ${from.y}) to (${to.x}, ${to.y})` };
}

export async function computerAction(page: Page, input: ComputerInput): Promise<ComputerResult> {
  switch (input.action) {
    case "left_click":
      return click(page, input, {});
    case "right_click":
      return click(page, input, { button: "right" });
    case "double_click":
      return click(page, input, { clickCount: 2 });
    case "triple_click":
      return click(page, input, { clickCount: 3 });
    case "hover": {
      const { x, y } = await target(page, input);
      await page.mouse.move(x, y);
      return { message: `Hovering at (${Math.round(x)}, ${Math.round(y)})` };
    }
    case "type":
      if (!input.text) throw new Error("text is required for type");
      await page.keyboard.type(input.text);
      return { message: `Typed ${input.text.length} characters` };
    case "key":
      return pressKeys(page, input);
    case "scroll":
      return scroll(page, input);
    case "scroll_to":
      if (!input.ref) throw new Error("ref is required for scroll_to");
      await refCenter(page, input.ref);
      return { message: `Scrolled ${input.ref} into view` };
    case "left_click_drag":
      return drag(page, input);
    case "screenshot":
      return screenshot(page);
    case "zoom":
      return zoom(page, input.region);
    case "wait": {
      const seconds = input.duration;
      if (seconds === undefined || !(seconds >= 0 && seconds <= MAX_WAIT_SECONDS)) {
        throw new Error(`duration must be from 0 to ${MAX_WAIT_SECONDS} seconds`);
      }
      await page.waitForTimeout(seconds * 1000);
      return { message: `Waited ${seconds}s` };
    }
    default:
      throw new Error(`Unknown action: ${String(input.action)}`);
  }
}
