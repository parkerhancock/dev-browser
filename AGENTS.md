# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

Always use Node.js/npm instead of Bun.

```bash
# Install dependencies (from skills/dev-browser/ directory)
cd skills/dev-browser && npm install

# Start the dev-browser server
cd skills/dev-browser && npm run start-server

# Run dev mode with watch
cd skills/dev-browser && npm run dev

# Run tests (uses vitest)
cd skills/dev-browser && npm test

# Run TypeScript check
cd skills/dev-browser && npx tsc --noEmit
```

## Important: Before Completing Code Changes

**Always run these checks before considering a task complete:**

1. **TypeScript check**: `npx tsc --noEmit` - Ensure no type errors
2. **Tests**: `npm test` - Ensure all tests pass
3. **Tool snapshot**: after adding, removing, or changing an MCP tool, run `cd mcp-server && npm run snapshot-tools`. The plugin's shim serves `mcp-shim-tools.json` before setup, and a test fails while it's stale.

Run checks in `skills/dev-browser`, `mcp-server`, and `extension` (`npm run test:run` there) for whatever you changed.

Common TypeScript issues in this codebase:

- Use `import type { ... }` for type-only imports (required by `verbatimModuleSyntax`)
- Browser globals (`document`, `window`) in `page.evaluate()` callbacks need `declare const document: any;` since DOM lib is not included

## Project Architecture

### Overview

This is a browser automation tool designed for developers and AI agents. It solves the problem of maintaining browser state across multiple script executions - unlike Playwright scripts that start fresh each time, dev-browser keeps pages alive and reusable.

### Structure

All source code lives in `skills/dev-browser/`:

- `src/index.ts` - Server: launches persistent Chromium context, exposes HTTP API for page management
- `src/relay.ts` - Relay server for extension mode: `serveRelay()` builds the context, auth middleware, and routes, then starts the server
- `src/relay/context.ts` - `createRelayContext()`: the relay's shared state (including the `live` connection state), CDP routing to the extension, page recovery, idle cleanup, policy checks
- `src/relay/routes-*.ts` - HTTP route groups, each `register*(app, ctx)`: status, pages, tabs, cdp, capture (console and HAR), snapshot
- `src/relay/extension-socket.ts` - The extension's WebSocket: connection, recovery, and forwarded CDP events
- `src/relay/types.ts` - Relay options, results, and extension message types
- `src/relay-registry.ts` - Target registry: manages page/session/target lifecycle state (4 Maps, explicit state machine)
- `src/client.ts` - Client: `connect()` and the public client types; picks a mode and re-exports the helpers below
- `src/client/standalone.ts` - Standalone client: Playwright connected over CDP to the server
- `src/client/extension.ts` - Extension client: HTTP RPC to the relay, pages are `CDPPage`
- `src/client/shared.ts` - Helpers both clients use (server HTTP calls, text/Markdown, find, origin state, downloads)
- `src/client/navigation.ts` - `waitForPageLoad()` and `navigateTo()`
- `src/client/archive.ts` - `saveWacz()` and `saveArchive()`
- `src/page.ts` - Unified `Page`, `Locator`, `Keyboard`, `Mouse` interfaces (Playwright-compatible subset)
- `src/cdp-page.ts` - `CDPPage` implementation: full Page interface via CDP over HTTP RPC (extension mode)
- `src/cdp-helpers.ts` - Key code mapping, element coordinate resolution, modifier bitmask utilities
- `src/har.ts` - HAR recording: processes CDP Network events into HAR entries
- `src/launch-args.ts` - Standalone launch recipe on top of patchright (headless mode, disabled features, viewport)
- `src/browser-cdp.ts` - Browser-level CDP connection (opens each page in its own window)
- `src/challenge.ts` - Bot-challenge detection (Cloudflare, DataDome, captchas, short 403s) and navigation error kinds
- `src/fetch.ts` - `fetchPage()`: one-shot fetch to Markdown/HTML/text with optional screenshot and WACZ
- `src/http-fetch.ts` - `httpFetch()`: the no-browser tier (impit, Chrome TLS fingerprint), same result shape
- `src/markdown.ts` - HTML to Markdown and text helpers
- `src/types.ts` - Shared TypeScript types for API requests/responses
- `src/snapshot/` - ARIA snapshot utilities for LLM-friendly page inspection
- `scripts/start-server.ts` - Entry point to start standalone server
- `scripts/start-relay.ts` - Entry point to start relay server (extension mode)
- `scripts/fetch.ts` - Fetch CLI used by the webfetch agent
- `tmp/` - Directory for temporary automation scripts

Outside the skill, at the repo root:

- `mcp-server/` - MCP tools and the `dev-browser` CLI (`src/server.ts` tools, `src/http.ts` streamable HTTP host, `src/daemon.ts` background start/stop/status, `src/tool-snapshot.ts`)
- `mcp-shim.mjs` - The plugin's MCP entry point: dependency-free stdio shim that forwards to the MCP host on :9225, starts it when the runtime is installed, and answers from `mcp-shim-tools.json` with the setup command when it isn't
- `extension/` - The Chrome extension for extension mode (WXT)
- `satchel.yaml` - Plugin package source for Claude Code and Codex. After editing it, `skills/`, `commands/`, `hooks/`, or `.mcp.json`, run `uv run --project ../satchel satchel generate .` and `... satchel check . --release`. `.claude-plugin/`, `.codex-plugin/`, and `.agents/plugins/` are generated; don't edit them by hand. Bump `version` in `satchel.yaml` for every release, and set the same version in `extension/` with `npm version <version> --no-git-tag-version` (a test checks they match): Claude Code's `plugin update` and the SessionStart update hook only act on a version change, and the release workflow requires the `v<version>` tag to match.
- `.mcp.json` - The plugin's MCP server: a `node -e` loader that runs `mcp-shim.mjs` from `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` (or the working directory), so one file works under both hosts
- `scripts/setup.mjs` - Dependency-free setup: copies the runtime to `~/.dev-browser/app/<version>` (or `--link`s a checkout), installs dependencies and the browser, writes `~/.dev-browser/bin/dev-browser`, optional login item (`--service`), `--update`, `--uninstall [--purge]`. Tests set `DEV_BROWSER_SETUP_DRY=1`
- `commands/setup.md` - `/dev-browser:setup` (Claude Code)
- `.github/workflows/release.yml` - On a `v<version>` tag matching `satchel.yaml`'s version, builds the extension and attaches `dev-browser-extension-<version>.zip` to the GitHub release
- `hooks/session-start.mjs` - Reruns setup in the background when the plugin's version and the installed runtime's differ

### Path Aliases

The project uses `@/` as a path alias to `./src/`. This is configured in both `package.json` (via `imports`) and `tsconfig.json` (via `paths`).

```typescript
// Import from src/client.ts
import { connect } from "@/client.js";

// Import from src/index.ts
import { serve } from "@/index.js";
```

### How It Works

1. **Server** (`serve()` in `src/index.ts`):
   - Launches Chromium with patchright's `launchPersistentContext` (preserves cookies, localStorage). Patchright is a Playwright fork that hides automation; `src/launch-args.ts` holds the rest of the launch recipe, and its `page.evaluate` runs in an isolated world
   - Exposes HTTP API on port 9222 for page management
   - Exposes CDP WebSocket endpoint on port 9223
   - Pages are registered by name and persist until explicitly closed

2. **Client** (`connect()` in `src/client.ts`):
   - Connects to server's HTTP API
   - Returns a unified `Page` interface regardless of mode
   - **Standalone mode:** Returns Playwright's real Page (structurally satisfies our `Page` interface)
   - **Extension mode:** Returns `CDPPage` (implements `Page` via HTTP RPC to relay's `/cdp` endpoint)

3. **Key API Endpoints**:
   - `GET /` - Returns CDP WebSocket endpoint
   - `GET /pages` - Lists all named pages
   - `POST /pages` - Gets or creates a page by name (body: `{ name: string }`)
   - `DELETE /pages/:name` - Closes a page

### Unified Page API

Both modes return the same `Page` interface. Scripts work identically regardless of mode.

```
Standalone: client.page("x") → Playwright Page (satisfies Page interface structurally)
Extension:  client.page("x") → CDPPage        (implements Page interface via CDP)
```

The `Page` interface is a Playwright-compatible subset (~45 methods + keyboard/mouse/locators). A compile-time test verifies Playwright's Page structurally satisfies our interface.

Extension-mode `CDPPage` also exposes extras not on the `Page` interface: `snapshot()`, `clickRef()`, `fillRef()`, `syncUrl()`, and a public `cdp()` escape hatch. Access via type narrowing (`page as CDPPage`).

### Usage Pattern

```typescript
import { connect } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("my-page"); // Gets existing or creates new
await page.goto("https://example.com");
await page.click("button.submit");
await page.fill("input#email", "test@example.com");
const text = await page.locator("h1").textContent();
// Page persists for future scripts
await client.disconnect(); // Disconnects CDP but page stays alive on server
```

## Node.js Guidelines

- Use `npx tsx` for running TypeScript files
- Use `dotenv` or similar if you need to load `.env` files
- Use `node:fs` for file system operations
