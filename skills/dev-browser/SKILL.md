---
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, generate PDFs, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "save as PDF", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

<!--
TODO: Move session ID hook back to frontmatter when fixed
======================================================
Skill-scoped hooks in SKILL.md frontmatter don't work (Claude Code bug).
Tracking: https://github.com/anthropics/claude-code/issues/17688

When resolved, restore this frontmatter and remove from ~/.claude/settings.json:

hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: "$HOME/.claude/skills/dev-browser/scripts/inject-session-id.sh"

Current workaround: Hook is in ~/.claude/settings.json (global PreToolUse)
-->

# Dev Browser Skill

Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally. Once you've proven out part of a workflow and there is repeated work to be done, you can write a script to do the repeated work in a single execution.

## Choosing Your Approach

- **Local/source-available sites**: Read the source code first to write selectors directly
- **Unknown page layouts**: Use `getAISnapshot()` to discover elements and `selectSnapshotRef()` to interact with them
- **Visual feedback**: Take screenshots to see what the user sees

## Setup

Two modes available on different ports. **Both can run simultaneously** - useful when some agents debug a UI (standalone) while others automate logged-in sessions (extension).

| Mode | Port | Use Case |
|------|------|----------|
| Standalone | 9222 | Fresh browser, debugging, CI/CD |
| Extension | 9224 | User's Chrome, logged-in sessions |

### Standalone Mode (Default)

Launches a new Chromium browser for fresh automation sessions.

```bash
./skills/dev-browser/server.sh &
```

Add `--headless` flag if user requests it. **Wait for the `Ready` message before running scripts.**

### Extension Mode

Connects to user's existing Chrome browser. Use this when:

- The user is already logged into sites and wants you to do things behind an authed experience that isn't local dev.
- The user asks you to use the extension

**Important**: The core flow is still the same. You create named pages inside of their browser. Use `connect({ mode: "extension" })` to connect.

**Start the relay server:**

```bash
./skills/dev-browser/start.sh
```

The script is idempotent - safe to run multiple times. It starts the relay if not running, or confirms it's already running.

Wait for `Relay ready` before running scripts. If the extension hasn't connected yet, tell the user to launch and activate it. Download link: https://github.com/SawyerHood/dev-browser/releases

**Stop the relay (optional):**

```bash
./skills/dev-browser/stop.sh
```

**Verify extension is connected** before running scripts:

```typescript
const client = await connect({ mode: "extension" });
const info = await client.getServerInfo();
if (!info.extensionConnected) {
  console.log("Extension not connected - tell user to activate it");
}
```

**Automatic session persistence:** The skill includes a SessionStart hook that exposes `CLAUDE_SESSION_ID` as an environment variable. When running in Claude Code:
- Pages automatically persist across script executions within the same session
- Each Claude Code session gets its own isolated page namespace
- No explicit session ID needed - just call `connect()` and pages will persist

**Multi-agent support:** Multiple Claude Code instances can safely share the same server. Each session is automatically isolated via `CLAUDE_SESSION_ID`. To share pages between agents, use an explicit session:

```typescript
const client = await connect({ mode: "extension", session: "shared-workspace" });
```

## Replacing Built-in WebFetch

This plugin includes a `webfetch` agent that replaces Claude Code's built-in WebFetch with a stealth browser-based fetcher. This handles sites with bot protection that block the standard fetcher.

### Setup

**Zero configuration required.** The plugin:
1. Automatically blocks built-in WebFetch via a PreToolUse hook
2. Auto-starts the browser server on first fetch

Just install and use. Ask Claude to fetch any URL and it routes to the stealth fetcher.

### Mode Priority

The fetch script tries modes in this order:
1. **Extension mode** (port 9224) - Best stealth, uses your real Chrome with logged-in sessions
2. **Standalone mode** (port 9222) - Auto-starts if extension unavailable, launches fresh Chromium

For extension mode, you need the dev-browser Chrome extension installed and activated.
Download: https://github.com/SawyerHood/dev-browser/releases

**Alternative (manual):** If hooks aren't working, add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["WebFetch"]
  }
}
```

### How It Works

When you ask Claude to fetch a URL, it routes to the `webfetch` agent which:
1. Uses dev-browser's extension mode (real Chrome, not headless)
2. Fetches the page with stealth protections
3. Converts HTML to clean markdown
4. Processes with Haiku (cost-efficient, like built-in WebFetch)
5. Returns a concise answer

### Direct CLI Usage

```bash
cd ~/.claude/skills/dev-browser && npx tsx scripts/fetch.ts "https://example.com"
```

Options:
- `--timeout=N`: Max wait time in ms (default: 30000)
- `--mode=extension|standalone`: Browser mode (default: extension)

## Session Types

| Type | Pages persist? | When to use |
|------|---------------|-------------|
| **Automatic** (`CLAUDE_SESSION_ID` set) | Yes | Default in Claude Code - pages survive across scripts |
| **Explicit** (`session: "name"`) | Yes | Share pages between agents or name your workspace |
| **Ephemeral** (`ephemeral: true`) | No | Quick one-off lookups that shouldn't leave tabs behind |
| **Auto-generated** (no session, no env var) | No | Standalone scripts outside Claude Code |

**Ephemeral sessions** are useful when you need to quickly check something without polluting your persistent session's tab space:

```typescript
// Quick lookup - page auto-closes on disconnect
const client = await connect({ ephemeral: true });
const page = await client.page("lookup");
await navigateTo(page, "https://api.example.com/status");
const status = await page.textContent("pre");
await client.disconnect(); // Page automatically closed
```

**When pages don't persist** (ephemeral or auto-generated sessions), you'll see a log message:
```
[dev-browser] Session: ephemeral-xxx (ephemeral - pages auto-close on disconnect)
```

## Writing Scripts

> **Run all scripts from `skills/dev-browser/` directory.** The `@/` import alias requires this directory's config.

Execute scripts inline using heredocs:

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connect, navigateTo } from "@/client.js";

const client = await connect();
// Create page with custom viewport size (optional)
const page = await client.page("example", { viewport: { width: 1920, height: 1080 } });

await navigateTo(page, "https://example.com");

console.log({ title: await page.title(), url: page.url() });
await client.disconnect();
EOF
```

**Write to `tmp/` files only when** the script needs reuse, is complex, or user explicitly requests it.

### Key Principles

1. **Small scripts**: Each script does ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Log/return state at the end to decide next steps
3. **Descriptive page names**: Use `"checkout"`, `"login"`, not `"main"`
4. **Disconnect to exit**: `await client.disconnect()` - pages persist on server
5. **Plain JS in evaluate**: `page.evaluate()` runs in browser - no TypeScript syntax

## Workflow Loop

Follow this pattern for complex tasks:

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

### No TypeScript in Browser Context

Code passed to `page.evaluate()` runs in the browser, which doesn't understand TypeScript:

```typescript
// ✅ Correct: plain JavaScript
const text = await page.evaluate(() => {
  return document.body.innerText;
});

// ❌ Wrong: TypeScript syntax will fail at runtime
const text = await page.evaluate(() => {
  const el: HTMLElement = document.body; // Type annotation breaks in browser!
  return el.innerText;
});
```

## Scraping Data

For scraping large datasets, intercept and replay network requests rather than scrolling the DOM. See [references/scraping.md](references/scraping.md) for the complete guide covering request capture, schema discovery, and paginated API replay.

## Client API

```typescript
// Connect to standalone server (port 9222) - default
const client = await connect();

// Connect to extension/relay server (port 9224)
const client = await connect({ mode: "extension" });

// Ephemeral session - pages auto-close on disconnect (useful for quick lookups)
const client = await connect({ ephemeral: true });

// Get or create named page (viewport only applies to new pages)
const page = await client.page("name");
const pageWithSize = await client.page("name", { viewport: { width: 1920, height: 1080 } });
const pinnedPage = await client.page("form", { pinned: true }); // Exempt from idle cleanup

const pages = await client.list(); // List all page names
await client.close("name"); // Close a single page
await client.pin("name"); // Pin page (exempt from idle cleanup)
await client.pin("name", false); // Unpin page (resume idle cleanup)
await client.closeAll(); // Close ALL pages in this session
await client.disconnect(); // Disconnect (pages persist, unless ephemeral)

// Server info (extension mode)
const info = await client.getServerInfo(); // { mode, extensionConnected, wsEndpoint }
const sessionId = client.getSession(); // Current session ID

// Tab management (extension mode) - bypasses session isolation
const tabs = await client.allTargets(); // List ALL browser tabs (not just this session)
await client.closeTarget(tabId); // Close a specific tab by tabId
const result = await client.cleanup("^about:blank$"); // Close tabs matching URL pattern

// ARIA Snapshot methods
const snapshot = await client.getAISnapshot("name"); // Get accessibility tree (10s timeout)
const snapshot = await client.getAISnapshot("name", { timeout: 5000 }); // Custom timeout
const element = await client.selectSnapshotRef("name", "e5"); // Get element by ref

// Archiving (HAR recording auto-starts on page())
const archivePath = await client.saveArchive("name"); // .zip with WACZ + HTML + PDF
const waczPath = await client.saveWacz("name");        // WACZ only
client.isRecordingHar("name");                          // Check if recording
```

The `page` object implements the unified `Page` interface — a Playwright-compatible subset with ~45 methods + keyboard/mouse/locators. In standalone mode it's a real Playwright Page; in extension mode it's a `CDPPage` (same interface, different transport). **Use `navigateTo(page, url)` instead of `page.goto(url)` in standalone mode** — it never hangs on problematic sites. In extension mode, `page.goto()` works fine.

### Locators & Interaction Methods

The Page interface includes Playwright-style locators and interaction methods:

```typescript
// Locator factory methods
await page.locator("button.submit").click();
await page.getByRole("button", { name: "Submit" }).click();
await page.getByTestId("email-input").fill("test@example.com");
await page.getByText("Sign in").click();
await page.getByLabel("Password").fill("secret");
await page.getByPlaceholder("Search...").fill("query");

// Direct selector methods
await page.click("button.submit");
await page.fill("input#email", "test@example.com");
await page.type("input#search", "query"); // Types character-by-character
await page.hover("nav a.menu");
await page.check("input[type=checkbox]");
await page.selectOption("select#country", "US");
await page.press("input", "Enter");

// Keyboard and mouse
await page.keyboard.type("Hello world");
await page.keyboard.press("Control+a");
await page.mouse.click(100, 200);
await page.mouse.wheel(0, 300); // Scroll down
```

## Navigation & Waiting

**Always use `navigateTo()` instead of `page.goto()` in standalone mode.** It never hangs — even on sites with websockets, long-polling, or heavy analytics that cause `page.goto()` to time out. In extension mode, `page.goto()` is safe (CDPPage handles timeouts internally).

```typescript
import { navigateTo } from "@/client.js";

// Resilient navigation — never throws on timeout
const result = await navigateTo(page, "https://example.com");
// result.success: true if fully loaded
// result.readyState: "complete", "interactive", etc.
// result.navigationTimedOut / result.loadTimedOut: partial failure details

// Custom timeout
await navigateTo(page, "https://slow-site.com", { timeout: 30000 });

// Skip load waiting (just commit and return immediately)
await navigateTo(page, "https://spa.com", { waitForLoad: false });
```

For waiting on specific conditions after navigation:

```typescript
await page.waitForSelector(".results"); // For specific elements
await page.waitForURL("**/success"); // For specific URL
```

**Why not `page.goto()`?** It defaults to `waitUntil: "load"`, which waits for the `load` event. Sites with persistent connections (analytics, websockets, live-updating content) may never fire this event, causing your script to hang for 30 seconds then throw. `navigateTo()` uses `waitUntil: "commit"` (server started responding) then smartly polls for readiness with a graceful timeout.

## Inspecting Page State

### Screenshots

```typescript
await page.screenshot({ path: "tmp/screenshot.png" });
await page.screenshot({ path: "tmp/full.png", fullPage: true });
```

### ARIA Snapshot (Element Discovery)

Use ARIA snapshots to discover page elements. Returns YAML-formatted accessibility tree:

```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
- main:
  - list:
    - listitem:
      - link "Article Title" [ref=e8]
      - link "328 comments" [ref=e9]
- contentinfo:
  - textbox [ref=e10]
    - /placeholder: "Search"
```

**Interpreting refs:**

- `[ref=eN]` - Element reference for interaction (visible, clickable elements only)
- `[checked]`, `[disabled]`, `[expanded]` - Element states
- `[level=N]` - Heading level
- `/url:`, `/placeholder:` - Element properties

**Interacting with refs — standalone mode:**

```typescript
const snapshot = await client.getAISnapshot("hackernews");
console.log(snapshot); // Find the ref you need

const element = await client.selectSnapshotRef("hackernews", "e2");
await element.click();
```

**Interacting with refs — extension mode (CDPPage):**

`selectSnapshotRef()` is not available in extension mode. Use CDPPage's direct ref methods instead:

```typescript
import type { CDPPage } from "@/cdp-page.js";

const page = await client.page("hackernews") as CDPPage;
const snapshot = await page.snapshot(); // ARIA tree (same format)
console.log(snapshot);

await page.clickRef("e2");              // Click by ref
await page.fillRef("e10", "search query"); // Fill input by ref
```

## CDPPage Extras (Extension Mode Only)

When using extension mode, `page` is a `CDPPage` with additional methods not on the standard `Page` interface. Access via type narrowing:

```typescript
import type { CDPPage } from "@/cdp-page.js";

const page = await client.page("mypage") as CDPPage;
```

| Method | Purpose |
|--------|---------|
| `page.snapshot()` | ARIA accessibility tree (same as `client.getAISnapshot()`) |
| `page.clickRef(ref)` | Click element by ARIA snapshot ref |
| `page.fillRef(ref, value)` | Fill input by ARIA snapshot ref |
| `page.syncUrl()` | Refresh cached URL from actual page |
| `page.cdp(method, params?)` | Raw CDP command escape hatch |

**Raw CDP escape hatch** — for anything not covered by the Page interface:

```typescript
// Execute arbitrary CDP commands
const result = await page.cdp("DOM.getDocument");
const { data } = await page.cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });

// Useful CDP methods:
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 3, mobile: true });
await page.cdp("Network.enable");
await page.cdp("Network.setExtraHTTPHeaders", { headers: { "X-Custom": "value" } });
```

## Troubleshooting Heavy JavaScript Sites

Some sites (travel, banking, sites with anti-bot measures) block CDP interactions after initial load. Symptoms:

- `navigateTo()` returns `success: false` with `loadTimedOut: true`
- `getAISnapshot()` hangs or times out
- `page.evaluate()` never returns

**The page is still usable** even when `navigateTo()` reports a timeout — it just means the page didn't fully finish loading. Use screenshots and direct selectors:

```typescript
const result = await navigateTo(page, url);
if (!result.success) {
  console.log("Page didn't fully load, proceeding with what's available");
}

// Use screenshots instead of getAISnapshot()
await page.screenshot({ path: "tmp/page.png" });

// Direct selectors still work
await page.click('button[type="submit"]');
```

The `getAISnapshot()` function has a 10-second default timeout and will fail with a helpful error message on unresponsive pages. You can adjust with `client.getAISnapshot("name", { timeout: 5000 })`.

## Tab Management (Extension Mode)

When using extension mode, tabs persist in Chrome even after scripts disconnect. Use these methods to manage tabs across sessions:

```typescript
const client = await connect({ mode: "extension" });

// See ALL browser tabs (not just your session's pages)
const tabs = await client.allTargets();
console.log(`Browser has ${tabs.length} tabs`);
// Returns: [{ tabId, targetId, url, title }, ...]

// Close orphaned tabs from previous automation runs
const result = await client.cleanup("^about:blank$");
console.log(`Closed ${result.closed} blank tabs`);

// Close a specific tab by tabId
await client.closeTarget(tabs[0].tabId);
```

**When to use:**
- Clean up tabs left over from crashed scripts
- Find tabs created by other sessions
- Close multiple tabs matching a pattern (e.g., all `example.com` tabs)

**Note:** These methods bypass session isolation intentionally. Normal `client.page()` and `client.list()` remain session-scoped.

## Archiving & PDF

**Works in both standalone and extension mode.** HAR recording auto-starts when you call `client.page()`. In standalone mode it opens a CDP session via Playwright; in extension mode the relay server captures network events server-side. The client API is identical — no mode-specific code needed.

### saveArchive — Full Page Archive

The recommended way to capture a page. Produces a `.zip` bundle with three files:

| File | Contents | Use case |
|------|----------|----------|
| `<name>.wacz` | WARC network archive | Archival replay, provenance |
| `<name>.html` | Rendered DOM snapshot | Full-text search indexing |
| `<name>.pdf` | PDF rendering (Letter) | Human-readable reference |

```typescript
const page = await client.page("research");
await navigateTo(page, "https://example.com");

// One call — stops recording, captures HTML + PDF, bundles into .zip
const archivePath = await client.saveArchive("research");
// => ~/.dev-browser/archives/research-2026-02-05T13-30-00-000Z.zip
```

Options:
```typescript
await client.saveArchive("research", {
  outputPath: "tmp/my-archive.zip",  // Custom path
  title: "Research on topic X",       // WACZ metadata
  skipPdf: true,                      // Skip PDF (e.g., headed mode)
  skipHtml: true,                     // Skip HTML capture
});
```

### saveWacz — WACZ Only

For just the network archive without HTML/PDF:

```typescript
const waczPath = await client.saveWacz("research");
```

### Manual PDF Generation

For standalone PDF generation using Playwright's `page.pdf()`:

```typescript
const page = await client.page("report");
await navigateTo(page, "https://example.com/report");

const pdfBuffer = await page.pdf({
  format: "Letter",
  printBackground: true,
  margin: { top: "1cm", bottom: "1cm" }
});

import { writeFileSync } from "fs";
writeFileSync("tmp/report.pdf", pdfBuffer);
```

**Headless mode** is required for `page.pdf()` in standalone:

```bash
cd skills/dev-browser && npx tsx -e '
import { serve } from "./src/index.js";
await serve({ headless: true });
'
```

**Extension mode:** PDF generation works but requires the page to be fully loaded. The relay intercepts `Page.printToPDF` and logs generation details.

## Tab Limits

Each session is limited to **5 tabs** to prevent runaway automation:

| Tabs | Behavior |
|------|----------|
| 1-2 | Normal operation |
| 3-4 | Warning in response: `"Consider closing unused tabs"` |
| 5 | Hard limit - new pages rejected with HTTP 429 |

Close unused pages to stay within limits:

```typescript
await client.close("old-page");
// Or in extension mode, clean up by pattern:
await client.cleanup("^about:blank$");
```

## Page Cleanup

Pages are cleaned up through multiple mechanisms to prevent accumulating thousands of tabs.

### Automatic Cleanup

**Idle timeout (15 seconds):** Pages with no CDP activity are automatically closed after 15 seconds. Activity includes any navigation, clicks, evaluations, or events. This keeps tab count minimal — Chrome's persistent profile preserves cookies and localStorage, so re-opening a page by name is cheap.

**Pinned pages** are exempt from idle cleanup. Use pinning when a human needs to interact with a tab (the idle timer can't detect human activity since it doesn't generate CDP commands):

```typescript
// Pin at creation — tab stays open until explicitly closed or unpinned
const page = await client.page("form", { pinned: true });

// Pin an existing page
await client.pin("form");

// Unpin when the human is done — resumes idle cleanup
await client.pin("form", false);
```

**Ephemeral sessions:** Use `{ ephemeral: true }` for one-off tasks. Pages auto-close on disconnect:

```typescript
const client = await connect({ ephemeral: true });
const page = await client.page("lookup");
// ... quick task ...
await client.disconnect(); // Page automatically closed
```

### Explicit Cleanup

**Close all pages in your session:**

```typescript
const client = await connect();
// ... automation work ...
await client.closeAll(); // Closes all pages in this session
await client.disconnect();
```

**Close specific pages:**

```typescript
await client.close("old-page"); // Close by name
await client.cleanup("^about:blank$"); // Close by URL pattern (extension mode)
```

### SessionEnd Hook (Recommended for Agents)

For Claude Code agents, add a SessionEnd hook to `~/.claude/settings.json` for automatic cleanup:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -X DELETE \"http://localhost:9224/sessions/$CLAUDE_SESSION_ID\" 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

This closes all pages when your Claude Code session ends, regardless of how it terminates.

### Subagent Cleanup Pattern

Subagents should explicitly clean up before returning results:

```typescript
// Subagent script pattern
const client = await connect(); // Uses parent's CLAUDE_SESSION_ID
try {
  const page = await client.page("task");
  // ... do work ...
  return result;
} finally {
  await client.closeAll(); // Clean up before returning
  await client.disconnect();
}
```

Alternatively, subagents can use ephemeral sessions to guarantee cleanup:

```typescript
const client = await connect({ ephemeral: true });
// Pages auto-close on disconnect - no explicit cleanup needed
```

## Diagnostics

### Log Files

**Server logs** are written to `~/.dev-browser/logs/` (persistent across reboots):
- `server-YYYY-MM-DD.log` — Standalone server
- `relay-YYYY-MM-DD.log` — Extension relay server

**Client/script logs** are written to `$TMPDIR/claude-skills/dev-browser/` (ephemeral, OS-managed):
- `client-YYYY-MM-DD.log` — Library diagnostics from scriptlet executions

Client logs are file-only — they never appear on stdout, keeping scriptlet output clean for agents. Warnings and errors still appear on stderr.

```bash
# Tail current day's log
tail -f ~/.dev-browser/logs/relay-$(date +%Y-%m-%d).log

# Find page creation patterns
grep "action=created" ~/.dev-browser/logs/relay-*.log
```

**Log format:**
```
[2025-01-14T12:35:00.123Z] [relay] POST /pages session=agent-123 name=search action=created total=5 sessionTotal=2
```

### Stats Endpoint

Query server state at any time:

```bash
curl http://localhost:9222/stats | jq   # Standalone
curl http://localhost:9224/stats | jq   # Extension
```

**Response:**
```json
{
  "totalPages": 8,
  "totalSessions": 2,
  "tabLimit": 5,
  "tabWarningThreshold": 3,
  "bySession": {
    "agent-123": [{"name": "search", "url": "https://..."}],
    "default": [{"name": "main", "url": "https://..."}]
  }
}
```

## Error Recovery

Page state persists after failures. Debug with:

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";

const client = await connect();
const page = await client.page("hackernews");

await page.screenshot({ path: "tmp/debug.png" });
console.log({
  url: page.url(),
  title: await page.title(),
  bodyText: await page.textContent("body").then((t) => t?.slice(0, 200)),
});

await client.disconnect();
EOF
```
