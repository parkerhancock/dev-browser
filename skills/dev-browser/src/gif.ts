/**
 * Animated GIFs from page screenshots, for the gif_creator tool. Each frame
 * is a viewport screenshot at CSS scale. Overlays are drawn at the GIF's own
 * resolution: a ring at a click, an arrow along a drag, a label naming the
 * action, and a progress bar along the bottom edge.
 */

import * as gifencModule from "gifenc";
import { PNG } from "pngjs";
import { GLYPHS, GLYPH_HEIGHT, GLYPH_WIDTH } from "./gif-font.js";

// Node loads gifenc's CommonJS build (its exports arrive on `default`);
// bundlers like Vite load the ESM build with named exports.
const gifenc: typeof gifencModule =
  "GIFEncoder" in gifencModule && typeof gifencModule.GIFEncoder === "function"
    ? gifencModule
    : (gifencModule as unknown as { default: typeof gifencModule }).default;

export interface Point {
  x: number;
  y: number;
}

export interface GifFrame {
  png: Buffer;
  /** Draw a click marker here (CSS pixels, the screenshot's own coordinates). */
  marker?: Point;
  /** Draw an arrow along a drag (CSS pixels). */
  drag?: { from: Point; to: Point };
  /** A short description of the action that led to this frame. */
  label?: string;
}

export interface GifOptions {
  /** Scale frames down to at most this width (default 800). */
  maxWidth?: number;
  /** Time each frame shows, in ms (default 1000; the last frame holds 2000). */
  delayMs?: number;
  /** Rings at click locations (default true). */
  showClickIndicators?: boolean;
  /** Arrows along drags (default true). */
  showDragPaths?: boolean;
  /** Labels describing each action (default true). */
  showActionLabels?: boolean;
  /** A bar along the bottom showing how far through the recording a frame is (default true). */
  showProgressBar?: boolean;
}

type Rgb = readonly [number, number, number];
const ORANGE: Rgb = [217, 119, 6];
const RED: Rgb = [220, 38, 38];
const WHITE: Rgb = [255, 255, 255];
const LABEL_BACKGROUND: Rgb = [17, 17, 17];

function setPixel(px: Uint8Array, w: number, h: number, x: number, y: number, rgb: Rgb): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  px.set([rgb[0], rgb[1], rgb[2], 255], (y * w + x) * 4);
}

function fillRect(px: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, rgb: Rgb): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) setPixel(px, w, h, x, y, rgb);
  }
}

/** Nearest-neighbor resize of RGBA pixels. */
function resize(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      out.set(src.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * dw + x) * 4);
    }
  }
  return out;
}

/** An orange ring around (cx, cy). */
function drawMarker(px: Uint8Array, w: number, h: number, cx: number, cy: number, radius: number): void {
  const inner = Math.max(1, radius - Math.max(2, radius / 4));
  for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius && d >= inner) setPixel(px, w, h, x, y, ORANGE);
    }
  }
}

/** A thick line from a to b. */
function drawLine(px: Uint8Array, w: number, h: number, a: Point, b: Point, thickness: number, rgb: Rgb): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  const r = thickness / 2;
  for (let i = 0; i <= steps; i++) {
    const cx = a.x + ((b.x - a.x) * i) / steps;
    const cy = a.y + ((b.y - a.y) * i) / steps;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (Math.hypot(x - cx, y - cy) <= r) setPixel(px, w, h, x, y, rgb);
      }
    }
  }
}

/** A red arrow from a to b, with the head at b. */
function drawArrow(px: Uint8Array, w: number, h: number, a: Point, b: Point, thickness: number): void {
  drawLine(px, w, h, a, b, thickness, RED);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = thickness * 4;
  for (const side of [-1, 1]) {
    const tip = { x: b.x - head * Math.cos(angle + (side * Math.PI) / 6), y: b.y - head * Math.sin(angle + (side * Math.PI) / 6) };
    drawLine(px, w, h, b, tip, thickness, RED);
  }
}

/**
 * White text on a dark box, centered above the bottom edge. Characters outside
 * printable ASCII draw as "?", and text too wide for the frame is cut short
 * with "...".
 */
function drawLabel(px: Uint8Array, w: number, h: number, text: string, scale: number, bottom: number): void {
  const pad = 4 * scale;
  const maxChars = Math.floor((w - 4 * pad) / (GLYPH_WIDTH * scale));
  if (maxChars < 4) return;
  let label = text.replace(/\s+/g, " ").trim();
  if (label.length > maxChars) label = `${label.slice(0, maxChars - 3)}...`;
  const textWidth = label.length * GLYPH_WIDTH * scale;
  const x0 = Math.round((w - textWidth) / 2);
  const y0 = bottom - pad - GLYPH_HEIGHT * scale - 2 * scale;
  fillRect(px, w, h, x0 - pad, y0 - pad, x0 + textWidth + pad, y0 + GLYPH_HEIGHT * scale + pad, LABEL_BACKGROUND);
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    const glyph = GLYPHS[code >= 32 && code <= 126 ? code - 32 : 31]!; // 31 is "?"
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      const row = parseInt(glyph.slice(gy * 2, gy * 2 + 2), 16);
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (row & (0x80 >> gx)) {
          const x = x0 + (i * GLYPH_WIDTH + gx) * scale;
          fillRect(px, w, h, x, y0 + gy * scale, x + scale, y0 + (gy + 1) * scale, WHITE);
        }
      }
    }
  }
}

/**
 * Draw a frame's overlays onto RGBA pixels at GIF resolution. `scale` maps the
 * frame's CSS coordinates to these pixels; `progress` is the share of the
 * recording shown so far (0-1).
 */
export function drawOverlays(
  rgba: Uint8Array,
  width: number,
  height: number,
  frame: Omit<GifFrame, "png">,
  scale: number,
  progress: number,
  options: GifOptions = {}
): void {
  // Overlays grow with the GIF so they stay legible on large exports
  const ui = Math.max(1, Math.round(width / 800));
  const barHeight = 4 * ui;
  const show = (flag: boolean | undefined) => flag !== false;
  const toGif = (p: Point): Point => ({ x: p.x * scale, y: p.y * scale });
  if (frame.drag && show(options.showDragPaths)) {
    drawArrow(rgba, width, height, toGif(frame.drag.from), toGif(frame.drag.to), Math.max(2, 3 * ui));
  }
  if (frame.marker && show(options.showClickIndicators)) {
    const at = toGif(frame.marker);
    drawMarker(rgba, width, height, at.x, at.y, Math.max(8, 14 * scale));
  }
  const bar = show(options.showProgressBar);
  if (frame.label && show(options.showActionLabels)) {
    drawLabel(rgba, width, height, frame.label, ui, height - (bar ? barHeight : 0));
  }
  if (bar) fillRect(rgba, width, height, 0, height - barHeight, width * progress, height, ORANGE);
}

export function encodeGif(frames: GifFrame[], options: GifOptions = {}): Buffer {
  if (frames.length === 0) throw new Error("No frames recorded");
  const first = PNG.sync.read(frames[0]!.png);
  const scale = Math.min(1, (options.maxWidth ?? 800) / first.width);
  const width = Math.max(1, Math.round(first.width * scale));
  const height = Math.max(1, Math.round(first.height * scale));
  const delay = options.delayMs ?? 1000;

  const gif = gifenc.GIFEncoder();
  frames.forEach((frame, i) => {
    const png = i === 0 ? first : PNG.sync.read(frame.png);
    const rgba = resize(new Uint8Array(png.data), png.width, png.height, width, height);
    drawOverlays(rgba, width, height, frame, width / png.width, (i + 1) / frames.length, options);
    const palette = gifenc.quantize(rgba, 256);
    gif.writeFrame(gifenc.applyPalette(rgba, palette), width, height, {
      palette,
      delay: i === frames.length - 1 ? delay * 2 : delay,
      ...(i === 0 ? { repeat: 0 } : {}),
    });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}
