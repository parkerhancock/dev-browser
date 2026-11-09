import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { drawOverlays, encodeGif } from "../gif.js";

const W = 400;
const H = 300;
const blank = () => new Uint8Array(W * H * 4).fill(255);
const pixel = (px: Uint8Array, x: number, y: number) => Array.from(px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
const ORANGE = [217, 119, 6];
const RED = [220, 38, 38];
const WHITE = [255, 255, 255];

describe("drawOverlays", () => {
  test("draws a ring at a click", () => {
    const px = blank();
    drawOverlays(px, W, H, { marker: { x: 100, y: 100 } }, 1, 0, { showProgressBar: false });
    expect(pixel(px, 113, 100)).toEqual(ORANGE); // on the ring
    expect(pixel(px, 100, 100)).toEqual(WHITE); // the center stays clear
  });

  test("draws an arrow along a drag", () => {
    const px = blank();
    drawOverlays(px, W, H, { drag: { from: { x: 50, y: 50 }, to: { x: 250, y: 50 } } }, 1, 0, {
      showProgressBar: false,
    });
    expect(pixel(px, 150, 50)).toEqual(RED);
    expect(pixel(px, 150, 70)).toEqual(WHITE);
  });

  test("draws a dark label with light text above the progress bar", () => {
    const px = blank();
    drawOverlays(px, W, H, { label: "Click e12" }, 1, 0.5);
    let dark = 0;
    let light = 0;
    for (let y = H - 40; y < H - 4; y++) {
      for (let x = 150; x < 250; x++) {
        const [r] = pixel(px, x, y);
        if (r === 17) dark++;
        if (r === 255 && y > H - 30 && y < H - 12 && x > 165 && x < 235) light++;
      }
    }
    expect(dark).toBeGreaterThan(500);
    expect(light).toBeGreaterThan(20);
  });

  test("fills the progress bar in proportion to progress", () => {
    const px = blank();
    drawOverlays(px, W, H, {}, 1, 0.25);
    expect(pixel(px, 50, H - 1)).toEqual(ORANGE);
    expect(pixel(px, 150, H - 1)).toEqual(WHITE);
  });

  test("options turn each overlay off", () => {
    const px = blank();
    drawOverlays(
      px,
      W,
      H,
      { marker: { x: 100, y: 100 }, drag: { from: { x: 0, y: 10 }, to: { x: 300, y: 10 } }, label: "Drag" },
      1,
      1,
      { showClickIndicators: false, showDragPaths: false, showActionLabels: false, showProgressBar: false }
    );
    expect(px.every((v) => v === 255)).toBe(true);
  });

  test("maps CSS coordinates by the frame's scale", () => {
    const px = blank();
    drawOverlays(px, W, H, { marker: { x: 200, y: 200 } }, 0.5, 0, { showProgressBar: false });
    expect(pixel(px, 107, 100)).toEqual(ORANGE);
  });
});

describe("encodeGif", () => {
  test("writes an animated GIF of the frames' size", () => {
    const png = new PNG({ width: W, height: H });
    png.data.fill(200);
    const frame = PNG.sync.write(png);
    const gif = encodeGif([
      { png: frame },
      { png: frame, marker: { x: 10, y: 10 }, label: "Click" },
    ]);
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.readUInt16LE(6)).toBe(W);
    expect(gif.readUInt16LE(8)).toBe(H);
  });
});
