/**
 * DOM tree extraction via Playwright page.evaluate()
 * Injects JavaScript to walk the DOM and collect all necessary data
 */

import type { Page, Frame } from "playwright";
import type { RawDOMNode } from "./types.js";
import { extractDOMScriptSource } from "./extract-script.js";

/**
 * Extract the raw DOM tree from a Playwright page
 */
export async function extractRawDOM(page: Page): Promise<RawDOMNode | null> {
  // Use evaluate with string to avoid bundler transformation issues
  const result = (await page.evaluate(extractDOMScriptSource)) as RawDOMNode | null;

  // Process iframes recursively
  if (result) {
    await processFrames(page, result);
  }

  return result;
}

/**
 * Process iframe content documents recursively
 */
async function processFrames(pageOrFrame: Page | Frame, node: RawDOMNode): Promise<void> {
  // Process children first
  for (const child of node.children) {
    await processFrames(pageOrFrame, child);
  }

  // Process shadow roots
  for (const shadow of node.shadowRoots) {
    await processFrames(pageOrFrame, shadow);
  }

  // If this is an iframe, try to extract its content
  if (node.isFrame && node.frameUrl && node.frameUrl !== "about:blank") {
    try {
      // Find the frame by URL or try to locate it
      // Page has frames(), Frame has childFrames()
      const frames = "frames" in pageOrFrame ? pageOrFrame.frames() : pageOrFrame.childFrames();
      const frame = frames.find((f: Frame) => {
        try {
          return f.url() === node.frameUrl || f.url().includes(node.frameUrl || "");
        } catch {
          return false;
        }
      });

      if (frame) {
        try {
          const frameContent = (await frame.evaluate(extractDOMScriptSource)) as RawDOMNode | null;
          if (frameContent) {
            node.contentDocument = frameContent;
            // Recursively process the frame's content
            await processFrames(frame, frameContent);
          }
        } catch {
          // Frame may be cross-origin or detached
        }
      }
    } catch {
      // Ignore frame processing errors
    }
  }
}
