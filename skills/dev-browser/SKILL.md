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

### Proxy, Locale, and Time Zone

Standalone servers take `dev-browser serve --proxy http://user:pass@host:port` (or `DEV_BROWSER_PROXY`), `--proxy-bypass`, `--locale de-DE`, and `--timezone Europe/Berlin`; `serve()` takes the same as `proxy`, `locale`, and `timezoneId`. Match the locale and time zone to the proxy's exit country, since a mismatch is a bot signal.

### Fetch Script

```bash
cd skills/dev-browser && npx tsx scripts/fetch.ts "https://example.com" [--format=markdown|html|text|json] [--engine=browser|http|auto] [--timeout=30000] [--mode=standalone|extension] [--fresh] [--headed] [--browser=chrome] [--proxy=url] [--screenshot=out.png] [--wacz=out.wacz]
```

- Prints the page's main content (article, main, else body) as Markdown with absolute links. A status line goes to stderr naming the engine that served it.
- Exit codes: 0 loaded, 1 navigation failed (the error says dns, tls, connection, or timeout), 2 a bot challenge or block page is still showing.
- Engines: `browser` (default) loads the page; `http` sends one request with Chrome's TLS fingerprint and no browser, in well under a second, and returns JSON and other non-HTML bodies as they are; `auto` tries HTTP first and loads the browser when the response is blocked, failed, or has less text than a rendered page would.
- Standalone mode runs headless and starts the server if needed. `--fresh` uses a private browser with a throwaway profile, so no cookies carry over; `--headed`, `--browser`, and `--proxy` apply to it. Extension mode uses your Chrome and its signed-in sessions.
- It waits for client-rendered pages to fill in, and gives an automatic challenge such as Cloudflare's "Just a moment" up to 10s to clear on its own. It never solves captchas.

From a script, `fetchPage(client, url, options)` in `@/fetch.js` and `httpFetch(url, options)` in `@/http-fetch.js` return the same result object, and `needsBrowser(result)` says when an HTTP result should be retried in a browser. `navigateTo()` results carry `status`, `challenge`, `textLength`, and `error`. The MCP `navigate` tool reports a `challenge` when it detects one.

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
6. **Standalone evaluate is isolated**: standalone mode runs on patchright, which hides automation from sites. Its `page.evaluate()` sees the DOM but not the page's own JS globals (`window.someAppState` is `undefined`). To read page globals, use the MCP `javascript` tool or pass `false` as a third argument, `page.evaluate(fn, arg, false)`; sites can detect both.

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

For scraping large datasets, capture and replay network requests rather than scrolling the DOM. Capture is mode-specific: standalone pages support `page.on("request"/"response")`; in extension mode `page.on()` throws — use HAR recording and `client.getHarEntries()` instead. See [references/scraping.md](references/scraping.md) for the complete guide covering request capture in both modes, schema discovery, and paginated API replay.

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
const adopted = await client.page("bank", { tabId: 123 }); // Extension: bind a name to an open tab (tabId from allTargets())

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
const snapshot = await client.getAISnapshot("name"); // Get accessibility tree
const element = await client.selectSnapshotRef("name", "e5"); // Get element by ref

// Archiving & HAR (recording auto-starts on page(); pass { record: false } to skip)
import { saveArchive, saveWacz } from "@/client.js";
const archivePath = await saveArchive(client, "name"); // .zip with WACZ + HTML + PDF
const waczPath = await saveWacz(client, "name");        // WACZ only
await client.isRecordingHar("name");                     // Check if recording (async)
const { entries, total } = await client.getHarEntries("name"); // Peek at entries without stopping
const newer = await client.getHarEntries("name", { since: total }); // Only entries after `total`
const har = await client.stopHarRecording("name");       // Stop, return full HAR, reset
await client.startHarRecording("name");                  // Start (no-op if already recording in extension mode)

// Console & network (capture starts with recording — i.e. on page() by default)
const { messages } = await client.getConsoleMessages("name", { pattern: "error" });
const { requests, total: nTotal } = await client.getNetworkRequests("name", { pattern: "/api/" });

// Find elements by snapshot text (refs work with clickRef/fillRef/selectSnapshotRef)
const matches = await client.find("name", "Sign in"); // [{ ref: "e12", line: "- button \"Sign in\" [ref=e12]" }]

// Bulk form fill + file upload
await client.fillForm("name", { "#email": "x@y.com", "#password": "..." });
await page.setInputFiles("input[type=file]", ["/abs/path/file.pdf"]);

// Page content as text or Markdown
const text = await client.text("name");
const md = await client.markdown("name");

// Batched CDP commands (one round trip; stops on first error)
const { results } = await client.batch("name", [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } },
  { method: "Page.captureScreenshot" },
]);

// Permissions, browsing data, per-origin state
await client.grantPermissions("name", "https://example.com", ["geolocation"]);
await client.clearBrowsingData("name", { origin: "https://example.com" }); // or no origin: all cookies + cache
const state = await client.exportOriginState("name", "https://example.com"); // cookies + localStorage (page must be on that origin for localStorage)
await client.importOriginState("name", state);

// Downloads: trigger, then wait for completion. The record's `path` is the
// file on this machine (extension mode: the user's Downloads folder, reported
// browser-wide by chrome.downloads; standalone: Playwright's temp dir).
await page.click("a.download-link");
const dl = await client.waitForDownload(); // matches downloads started ≤60s ago; { since?, timeoutMs? }
console.log(dl.path, dl.fileSize);
const all = await client.getDownloads({ since: Date.now() - 300_000 });

// Which browser is connected (extension mode: chrome | msedge | brave | ...)
const browsers = await client.listBrowsers(); // [{ browser: "msedge", version, connected: true }]
// Or require a specific one at connect time:
const edgeClient = await connect({ mode: "extension", browser: "msedge" }); // throws if another browser is connected
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

## MCP Server & CLI

`mcp-server/` (repo root) packages the client as model-facing MCP tools and a single CLI:

```bash
dev-browser serve     # standalone Chromium server on :9222 (--headed, --profile NAME, --browser chrome|msedge, --port, --host, --mcp)
dev-browser relay     # Chrome-extension relay on :9224 (--port, --mcp)
dev-browser mcp       # MCP server on stdio (--http PORT for streamable HTTP, --mode, --session)
dev-browser browsers  # show which servers are reachable
```

`--mcp` mounts the MCP streamable-HTTP endpoint at `/mcp` on the same port, behind the server's token auth, so one process serves both the library HTTP API and MCP. Over HTTP, each MCP connection gets its own dev-browser session (`mcp-<id>`), the HTTP equivalent of the per-conversation isolation `CLAUDE_SESSION_ID` gives stdio.

Run it from `mcp-server/` with `node bin/dev-browser.mjs <cmd>` (or install the package to get the `dev-browser` bin). The MCP server auto-detects the mode: extension relay first (if its extension is connected), standalone otherwise; `switch_browser` changes it at runtime. The session defaults to `CLAUDE_SESSION_ID` for per-conversation isolation.

Vendor tool → dev-browser mapping (every MCP tool is a thin wrapper over the client API, which stays the engine):

| MCP tool | Backed by |
|---|---|
| `tabs_context` | `client.list()` + `client.allTargets()` + `getServerInfo()` |
| `navigate` | `client.page(name)` + `page.goto()` / `goBack()` / `goForward()` |
| `read_page` | `client.getAISnapshot(name)` + `filterSnapshot()` (`filter: "interactive"`, `depth`, `ref_id`, `max_chars`) |
| `get_page_text` | `client.text(name)` / `client.markdown(name)` |
| `find` | `client.find(name, query)` |
| `ref_action` | `page.clickRef/fillRef` (extension) / `selectSnapshotRef` (standalone) |
| `form_input` | `setRefValue(page, ref, value)` (inputs, selects, checkboxes, contenteditable) or `client.fillForm(name, fields)` |
| `browser_batch` | sequential dispatch of this server's own tools |
| `cdp_batch` | `client.batch(name, ops)` (`POST /batch` on the relay) |
| `javascript` | `page.evaluate(code)` |
| `screenshot` | `page.screenshot()` (also saved under `~/.dev-browser/screenshots`) |
| `computer` | `computerAction(page, input)` over `page.mouse` / `page.keyboard` / `page.screenshot()`: clicks, type, key, scroll, drag, hover, zoom, wait. Coordinates are CSS pixels and match its screenshots, including on HiDPI displays |
| `resize_window` | `client.emulate(name, options)`: size, `mobile`/`tablet`/`desktop` presets (touch + Android UA), `color_scheme` |
| `file_upload` | `page.setInputFiles()` by selector, or by ref (`DOM.setFileInputFiles` in extension mode) |
| `tabs_create` / `tabs_close` / `tabs_select` | `client.page(name)` / `client.close(name)` / `Page.bringToFront` |
| `read_console_messages` | `client.getConsoleMessages(name, { pattern, since })`, plus `only_errors` and `limit` |
| `read_network_requests` | `client.getNetworkRequests(name, { pattern, since })`; `request_id` returns headers and body from `client.getHarEntries()` |
| `gif_creator` | `encodeGif(frames)` (`src/gif.ts`): records a frame after each action on the page, with click markers, and exports a GIF |
| `upload_image` | Set a file on a file input by ref, or drop it on an element by ref or coordinate (`dropFile()` in `src/ref-actions.ts`) |
| `preview_start` / `preview_list` / `preview_logs` / `preview_stop` | Dev servers from the project's `.claude/launch.json` (`mcp-server/src/preview.ts`): start or reuse one, open it in a page, read its output, stop it |
| `switch_browser` / `list_connected_browsers` | `/health` probes on :9222 and :9224 (includes the `browser` label) |

Downloads and browser identity are also exposed over HTTP in both modes: `GET /downloads?since=<ms>` lists downloads (standalone tracks them per session; the relay reports the extension's `chrome.downloads`, which is browser-wide — downloads the user starts by hand also appear), `GET /download/:id` serves a completed download's bytes, and `GET /browsers` reports the browser label. In standalone mode completed downloads are copied into `<profile>/downloads/` so the bytes stay servable; extension-mode files stay in the user's Downloads folder and are never deleted. `client.saveDownload(id, destPath)` fetches the bytes to a local file — a `DownloadRecord`'s `path` is a path on the server's machine, so use `saveDownload` whenever the browser runs remotely.

## Remote / Docker

The standalone server is deployable as a service: the repo-root `Dockerfile` runs `dev-browser serve --host 0.0.0.0 --mcp --profile-dir /data` on the Playwright base image, with the token and browser profile persisted under the `/data` volume. One port (9222) serves everything:

- **Library**: `connect("http://host:9222", { token })` — or set `DEV_BROWSER_TOKEN` instead of passing it. The client derives the CDP WebSocket URL from the HTTP URL it dialed and carries the token as `?token=` on the upgrade.
- **MCP**: `http://host:9222/mcp` (streamable HTTP) with header `X-DevBrowser-Token: <token>`, e.g. `claude mcp add --transport http dev-browser http://host:9222/mcp --header "X-DevBrowser-Token: $TOKEN"`.

Chromium's own CDP debug port stays on loopback inside the container; the only way in is the server's authenticated `/cdp` WebSocket proxy, which also shields the browser from remote Playwright clients misconfiguring download paths (`Browser.setDownloadBehavior` is answered at the proxy, never forwarded).

## Security & Policy

- **Token auth**: both servers generate `~/.dev-browser/token` (0600) on first start and require it (`X-DevBrowser-Token` header or `?token=`) on every HTTP request and WS upgrade. The client reads the same file automatically — nothing to configure on the same machine; remotely, pass `token` to `connect()` or set `DEV_BROWSER_TOKEN`. `/extension` upgrades also accept a `chrome-extension://` Origin in place of the token and always reject http(s) Origins.
- **Policy**: `~/.dev-browser/policy.json` (optional) is enforced at the relay before any CDP command is routed. `{"defaultMode": "strict", "allowedDomains": ["example.com"], "blockedDomains": [...], "cdpMethodAllowlist": [...], "fullCdpAccessOrigins": [...], "sessions": {"<id>": {...}}}`. Strict mode fails closed: navigation only to allowlisted domains, raw CDP limited to the safe set unless the page's origin has full access. No file means permissive (plus the blocklist still applies if present); a malformed file fails closed.
- **JS dialogs** are auto-dismissed at the relay (`DEV_BROWSER_DIALOG_POLICY=dismiss|accept|ignore`).

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
| `await page.frames()` | Discover main, same-process, and out-of-process frames |
| `page.syncUrl()` | Refresh cached URL from actual page |
| `page.cdp(method, params?, options?)` | Raw CDP command escape hatch |

For controls inside cross-origin frames, select the frame and use its DOM helpers:

```typescript
const frames = await page.frames();
const transactions = frames.find((frame) =>
  frame.url().includes("transactions")
);
if (!transactions) throw new Error("Transactions frame not found");

console.log(await transactions.title());
await transactions.click("button[data-testid='export']");
```

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

**Works in both standalone and extension mode.** HAR recording auto-starts when you call `client.page()` (pass `{ record: false }` to skip). In standalone mode it opens a CDP session via Playwright; in extension mode the relay server captures network events server-side. The client API is identical — no mode-specific code needed.

In extension mode the relay owns recording state, so a recording started by one script run stays active for later runs: a fresh `client.page()` re-attaches instead of erroring, and `await client.isRecordingHar(name)` reports the true state. To inspect captured traffic without stopping the recording, use `client.getHarEntries(name)` — see [references/scraping.md](references/scraping.md).

### saveArchive — Full Page Archive

The recommended way to capture a page. Produces a `.zip` bundle with three files:

| File | Contents | Use case |
|------|----------|----------|
| `<name>.wacz` | WARC network archive | Archival replay, provenance |
| `<name>.html` | Rendered DOM snapshot | Full-text search indexing |
| `<name>.pdf` | PDF rendering (Letter) | Human-readable reference |

```typescript
import { saveArchive } from "@/client.js";

const page = await client.page("research");
await navigateTo(page, "https://example.com");

// One call — stops recording, captures HTML + PDF, bundles into .zip
const archivePath = await saveArchive(client, "research");
// => ~/.dev-browser/archives/research-2026-02-05T13-30-00-000Z.zip
```

Options:
```typescript
await saveArchive(client, "research", {
  outputPath: "tmp/my-archive.zip",  // Custom path
  title: "Research on topic X",       // WACZ metadata
  skipPdf: true,                      // Skip PDF (e.g., headed mode)
  skipHtml: true,                     // Skip HTML capture
});
```

### saveWacz — WACZ Only

For just the network archive without HTML/PDF:

```typescript
import { saveWacz } from "@/client.js";

const waczPath = await saveWacz(client, "research");
```

### Manual PDF Generation

For standalone PDF generation using Playwright's `page.pdf()`:

```typescript
const page = await client.page("report");
await navigateTo(page, "https://example.com/report");

const pdfBuffer = await page.pdf({
  format: "Letter",
  printBackground: true,
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

**Idle timeout (60 seconds):** Anonymous tabs — targets not bound to a named page — are automatically closed after 60 seconds with no CDP activity (override with `DEV_BROWSER_IDLE_TIMEOUT_MS`). Named pages are never closed by the idle timer: they survive between script runs and are capped by the 5-tab session limit, so close them explicitly when done.

**Pinned pages** are also exempt from idle cleanup, and pinning is persisted so it survives extension reconnects and relay restarts. Use pinning when a human needs to interact with a tab:

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
