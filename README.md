<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

A browser automation plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that lets Claude control your browser to test and verify your work as you develop.

**Key features:**

- **Persistent pages** - Navigate once, interact across multiple scripts
- **Flexible execution** - Full scripts when possible, step-by-step when exploring
- **LLM-friendly DOM snapshots** - Structured page inspection optimized for AI
- **Stealth WebFetch replacement** - Bypass bot protection that blocks built-in WebFetch
- **Resilient navigation** - `navigateTo()` never hangs on sites with websockets or heavy analytics
- **One-call archiving** - `saveArchive()` captures WACZ + rendered HTML + PDF in a single `.zip`
- **Auto HAR recording** - Network traffic recording starts automatically, no setup needed

## WebFetch Replacement

This plugin includes a stealth web fetcher that replaces Claude Code's built-in WebFetch. Sites with bot protection (Cloudflare, etc.) that return 403s or CAPTCHAs to the standard fetcher work seamlessly with dev-browser.

**How it works:**

1. A PreToolUse hook automatically blocks built-in WebFetch
2. Requests route to the `webfetch` agent (runs on Haiku for cost efficiency)
3. The agent uses a real browser to fetch pages, bypassing bot detection
4. Content is converted to markdown and processed to answer your question

**Zero configuration required.** The browser server auto-starts on first fetch. Just install the plugin and ask Claude to fetch any URL.

```
> "Fetch https://example.com/pricing and summarize the plans"
> "What does the documentation at docs.example.com say about authentication?"
```

**Mode priority:**

| Mode | Port | Stealth Level | Notes |
|------|------|---------------|-------|
| Extension | 9224 | Best | Uses your real Chrome with logged-in sessions |
| Standalone | 9222 | Good | Auto-starts fresh Chromium if extension unavailable |

For maximum stealth (real browser fingerprint, existing cookies), install the Chrome extension.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [Node.js](https://nodejs.org) (v18 or later) with npm

## Installation

### Claude Code

```
/plugin marketplace add sawyerhood/dev-browser
/plugin install dev-browser@sawyerhood/dev-browser
```

Restart Claude Code after installation.

### Amp / Codex

Copy the skill to your skills directory:

```bash
# For Amp: ~/.claude/skills | For Codex: ~/.codex/skills
SKILLS_DIR=~/.claude/skills  # or ~/.codex/skills

mkdir -p $SKILLS_DIR
git clone https://github.com/sawyerhood/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser $SKILLS_DIR/dev-browser
rm -rf /tmp/dev-browser-skill
```

**Amp only:** Start the server manually before use:

```bash
cd ~/.claude/skills/dev-browser && npm install && npm run start-server
```

### Chrome Extension (Optional)

The Chrome extension allows Dev Browser to control your existing Chrome browser instead of launching a separate Chromium instance. This gives you access to your logged-in sessions, bookmarks, and extensions.

**Installation:**

1. Download `extension.zip` from the [latest release](https://github.com/sawyerhood/dev-browser/releases/latest)
2. Unzip the file to a permanent location (e.g., `~/.dev-browser-extension`)
3. Open Chrome and go to `chrome://extensions`
4. Enable "Developer mode" (toggle in top right)
5. Click "Load unpacked" and select the unzipped extension folder

**Using the extension:**

1. Click the Dev Browser extension icon in Chrome's toolbar
2. Toggle it to "Active" - this enables browser control
3. Ask Claude to connect to your browser (e.g., "connect to my Chrome" or "use the extension")

When active, Claude can control your existing Chrome tabs with all your logged-in sessions, cookies, and extensions intact.

### Multi-Agent Support

Multiple Claude Code instances can share the same relay server without conflicts. Each instance automatically gets an isolated session with its own page namespace.

> **Note:** This plugin includes a SessionStart hook that enables automatic session persistence. Due to a [Claude Code limitation](https://github.com/anthropics/claude-code/issues/12634), plugin hooks aren't discovered on updates—only on fresh installs. If you're updating from a previous version and pages aren't persisting across scripts, uninstall and reinstall the plugin:
> ```
> /plugin uninstall dev-browser@dev-browser
> /plugin install dev-browser@dev-browser
> ```

**Start the shared relay:**

```bash
./skills/dev-browser/start.sh
```

The script is idempotent - run it from any Claude Code instance and it will either start the relay or confirm it's already running.

**Session isolation:**

```typescript
// Each connect() auto-generates a unique session ID
const client = await connect();
const page = await client.page("github"); // Isolated to this session

// To share pages between sessions, use the same session ID:
const client = await connect("http://localhost:9222", { session: "shared-workspace" });
```

**Stop the relay:**

```bash
./skills/dev-browser/stop.sh
```

## Permissions

To skip permission prompts, add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Skill(dev-browser:dev-browser)", "Bash(npx tsx:*)"]
  }
}
```

Or run with `claude --dangerously-skip-permissions` (skips all prompts).

## Usage

Just ask Claude to interact with your browser:

> "Open localhost:3000 and verify the signup flow works"

> "Go to the settings page and figure out why the save button isn't working"

## Benchmarks

| Method                  | Time    | Cost  | Turns | Success |
| ----------------------- | ------- | ----- | ----- | ------- |
| **Dev Browser**         | 3m 53s  | $0.88 | 29    | 100%    |
| Playwright MCP          | 4m 31s  | $1.45 | 51    | 100%    |
| Playwright Skill        | 8m 07s  | $1.45 | 38    | 67%     |
| Claude Chrome Extension | 12m 54s | $2.81 | 80    | 100%    |

_See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

### How It's Different

| Approach                                                         | How It Works                                      | Tradeoff                                               |
| ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp)    | Observe-think-act loop with individual tool calls | Simple but slow; each action is a separate round-trip  |
| [Playwright Skill](https://github.com/lackeyjb/playwright-skill) | Full scripts that run end-to-end                  | Fast but fragile; scripts start fresh every time       |
| **Dev Browser**                                                  | Stateful server + agentic script execution        | Best of both: persistent state with flexible execution |

## Resilient Navigation

`navigateTo()` replaces `page.goto()` as the default navigation method. It uses a two-phase approach that works reliably on any site:

1. **Phase 1:** Navigate with `waitUntil: "commit"` (server started responding)
2. **Phase 2:** Smart load polling via `document.readyState` + Performance API with graceful timeout

Unlike `page.goto()`, it never throws on timeout — it returns a result object so your script can continue:

```typescript
import { connect, navigateTo } from "@/client.js";

const client = await connect();
const page = await client.page("research");

const result = await navigateTo(page, "https://example.com");
// result.success — fully loaded?
// result.navigationTimedOut / result.loadTimedOut — partial failure details
// Page is always usable regardless of timeout

await page.screenshot({ path: "tmp/page.png" });
await client.disconnect();
```

This solves the common problem where `page.goto()` hangs for 30 seconds on sites with websockets, long-polling, or persistent analytics connections, causing agent scripts to fail and need rewriting.

## Page Archiving

HAR recording starts automatically when you call `client.page()`. When you're done, `saveArchive()` bundles everything into a single `.zip`:

| File | Contents | Use case |
|------|----------|----------|
| `<name>.wacz` | WARC network archive | Archival replay, provenance |
| `<name>.html` | Rendered DOM snapshot | Full-text search indexing |
| `<name>.pdf` | PDF rendering (Letter) | Human-readable reference |

```typescript
const client = await connect();
const page = await client.page("research");
await navigateTo(page, "https://example.com");

// One call: stops recording, captures HTML + PDF, bundles into .zip
const archivePath = await client.saveArchive("research");
// => ~/.dev-browser/archives/research-2026-02-05T13-30-00-000Z.zip

await client.disconnect();
```

For just the network archive without HTML/PDF, use `saveWacz()`:

```typescript
const waczPath = await client.saveWacz("research");
```

The recording lifecycle is fully automatic:
- **`page()`** — auto-starts HAR recording (opt out with `{ record: false }`)
- **`saveArchive()` / `saveWacz()`** — stops recording and saves
- **`close()` / `disconnect()`** — silently cleans up any active recordings

## Related Projects

- [dev-terminal](https://github.com/parkerhancock/dev-terminal) - Terminal/PTY automation with persistent sessions. The terminal equivalent of dev-browser for TUI apps, CLI workflows, and interactive shell sessions.

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
