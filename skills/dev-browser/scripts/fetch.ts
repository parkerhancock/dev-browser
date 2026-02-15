#!/usr/bin/env npx tsx
/**
 * Fetch a URL using dev-browser's stealth mode and output markdown.
 *
 * Usage: npx tsx scripts/fetch.ts <url> [--timeout=30000] [--mode=extension|standalone]
 *
 * Outputs markdown content to stdout. Errors go to stderr.
 * Auto-starts the relay/server if not running.
 */

import { connect } from "../src/client.js";
import TurndownService from "turndown";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillDir = join(__dirname, "..");

// Parse arguments
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const timeout = parseInt(
  args.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? "30000",
  10
);
const explicitMode = args.find((a) => a.startsWith("--mode="))?.split("=")[1] as
  | "extension"
  | "standalone"
  | undefined;

if (!url) {
  console.error("Usage: npx tsx scripts/fetch.ts <url> [--timeout=30000] [--mode=extension]");
  process.exit(1);
}

// Validate URL
try {
  new URL(url);
} catch {
  console.error(`Invalid URL: ${url}`);
  process.exit(1);
}

// Server ports
const PORTS = {
  extension: 9224,
  standalone: 9222,
};

// Check if server is running
async function isServerRunning(mode: "extension" | "standalone"): Promise<boolean> {
  const port = PORTS[mode];
  try {
    const res = await fetch(`http://localhost:${port}/`);
    return res.ok;
  } catch {
    return false;
  }
}

// Start server and wait for it to be ready
async function ensureServerRunning(mode: "extension" | "standalone"): Promise<void> {
  if (await isServerRunning(mode)) {
    return;
  }

  console.error(`Starting ${mode} server...`);

  const script = mode === "extension" ? "start.sh" : "server.sh";
  const scriptPath = join(skillDir, script);

  // Start server in background
  const child = spawn("bash", [scriptPath], {
    cwd: skillDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Don't wait for child - let it run in background
  child.unref();

  // Capture startup output for debugging
  let startupOutput = "";
  child.stdout?.on("data", (data) => {
    startupOutput += data.toString();
  });
  child.stderr?.on("data", (data) => {
    startupOutput += data.toString();
  });

  // Wait for server to be ready (poll with timeout)
  const maxWait = 15000;
  const pollInterval = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isServerRunning(mode)) {
      console.error(`${mode} server ready`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Server didn't start in time
  console.error(`Server startup output: ${startupOutput}`);
  throw new Error(
    `Failed to start ${mode} server after ${maxWait}ms. ` +
      (mode === "extension"
        ? "Make sure the Chrome extension is installed and activated."
        : "Check server.sh for errors.")
  );
}

// Retry helper for transient failures
async function retry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetryable =
        lastError.message.includes("reconnecting") ||
        lastError.message.includes("Extension") ||
        lastError.message.includes("ECONNREFUSED");
      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }
      console.error(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function fetchWithMode(mode: "extension" | "standalone"): Promise<string> {
  const client = await connect({ mode, ephemeral: true });

  try {
    const pageName = `fetch-${Date.now()}`;
    const page = await retry(() => client.page(pageName));

    // Navigate to URL
    console.error(`Fetching: ${url} (mode: ${mode})`);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });

    // Brief wait for dynamic content to settle
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get page title
    const title = await page.title();

    // Get the main content HTML
    // Try to extract article/main content first, fall back to body
    const html = await page.evaluate(() => {
      // Priority: article, main, [role=main], body
      const selectors = ["article", "main", '[role="main"]', "body"];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && el.innerHTML.trim().length > 100) {
          return el.innerHTML;
        }
      }
      return document.body?.innerHTML ?? "";
    });

    // Convert HTML to markdown
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });

    // Remove script, style, nav, footer, aside elements
    turndown.remove(["script", "style", "nav", "footer", "aside", "noscript", "iframe"]);

    // Convert links to include href
    turndown.addRule("links", {
      filter: "a",
      replacement: (content, node) => {
        const href = (node as HTMLAnchorElement).getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
          return content;
        }
        // Make relative URLs absolute
        try {
          const absoluteUrl = new URL(href, url).href;
          return `[${content}](${absoluteUrl})`;
        } catch {
          return `[${content}](${href})`;
        }
      },
    });

    const markdown = turndown.turndown(html);

    // Clean up
    await client.close(pageName);

    return `# ${title}\n\nSource: ${url}\n\n${markdown}`;
  } finally {
    await client.disconnect();
  }
}

async function main() {
  // If explicit mode requested, use only that
  if (explicitMode) {
    await ensureServerRunning(explicitMode);
    const result = await fetchWithMode(explicitMode);
    console.log(result);
    return;
  }

  // Try extension mode first (better stealth), fall back to standalone
  try {
    // Check if extension mode is available
    const extensionRunning = await isServerRunning("extension");
    if (extensionRunning) {
      const result = await fetchWithMode("extension");
      console.log(result);
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Extension") && !msg.includes("reconnecting") && !msg.includes("ECONNREFUSED")) {
      throw err;
    }
  }

  // Extension not available or failed - use standalone (auto-start if needed)
  console.error(`Extension mode unavailable, using standalone...`);
  await ensureServerRunning("standalone");
  const result = await fetchWithMode("standalone");
  console.log(result);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
