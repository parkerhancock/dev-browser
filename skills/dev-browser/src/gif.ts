/**
 * Animated GIFs from page screenshots, for the gif_creator tool. Each frame
 * is a viewport screenshot at CSS scale; a click frame can carry a marker at
 * the clicked point.
 */

import * as gifencModule from "gifenc";
import { PNG } from "pngjs";

// Node loads gifenc's CommonJS build (its exports arrive on `default`);
// bundlers like Vite load the ESM build with named exports.
const gifenc: typeof gifencModule =
  "GIFEncoder" in gifencModule && typeof gifencModule.GIFEncoder === "function"
    ? gifencModule
    : (gifencModule as unknown as { default: typeof gifencModule }).default;

export interface GifFrame {
  png: Buffer;
  /** Draw a click marker here (CSS pixels, the screenshot's own coordinates). */
  marker?: { x: number; y: number };
}

export interface GifOptions {
  /** Scale frames down to at most this width (default 800). */
  maxWidth?: number;
  /** Time each frame shows, in ms (default 1000; the last frame holds 2000). */
  delayMs?: number;
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

/** A red ring around (cx, cy). */
function drawMarker(px: Uint8Array, w: number, h: number, cx: number, cy: number, radius: number): void {
  const inner = Math.max(1, radius - Math.max(2, radius / 4));
  for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius && d >= inner) px.set([230, 30, 30, 255], (y * w + x) * 4);
    }
  }
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
    if (frame.marker) {
      const fx = width / png.width;
      const fy = height / png.height;
      drawMarker(rgba, width, height, frame.marker.x * fx, frame.marker.y * fy, Math.max(8, 14 * fx));
    }
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
