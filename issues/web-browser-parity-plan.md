# Plan: web-browser-use parity with Claude in Chrome / Codex browser-use / desktop apps

**Date:** 2026-11-06
**Status:** plan, not started — pick up from P0
**Context:** reverse-engineering docs live outside this repo at
`/Users/parkerhancock/Projects/openjev-mlx/research/docs/` (`claude-code-browser-use.md`,
`codex-desktop-app-browser-computer-use.md`, `dev-browser-web-parity-plan.md` — the latter
mirrors this file). Vendor reference tool surface (Claude in Chrome, 23 tools):
`tabs_context, navigate, read_page, get_page_text, find, form_input, browser_batch,
javascript, resize_window, upload_image, tabs_create, tabs_close, read_console_messages,
read_network_requests, file_upload, switch_browser, list_connected_browsers`.
Scope: **web browser use only** (no computer use, no harness features). Security fixes
are §4 and should land before or with P0.

Repo conventions (from root `AGENTS.md`): use Node.js/npm (not Bun); before marking any
code change done run `cd skills/dev-browser && npx tsc --noEmit` and `npm test`; use
`import type` for type-only imports; `@/` aliases `skills/dev-browser/src/`.

## P0 — MCP server packaging (the big one)

Vendor browser use is model-facing MCP tools; this repo is agent-script-only. Add
`mcp-server/` (new package at repo root, stdio + streamable-HTTP) wrapping
`skills/dev-browser/src/client.ts` with tools mirroring the vendor set:
`tabs_context, navigate, read_page, get_page_text, find, form_input, browser_batch,
javascript, screenshot, resize_window, file_upload, tabs_create, tabs_close,
read_console_messages, read_network_requests, switch_browser, list_connected_browsers`.
Session param defaults to the harness session id so per-conversation isolation works via
the existing `X-DevBrowser-Session` mechanism (`src/types.ts:11-15`). Keep the script API
as the engine — MCP tools are thin wrappers, not a rewrite.

## P1 — library gaps (each small; all paths under `skills/dev-browser/src/`)

| # | Feature | Current state | Change |
|---|---|---|---|
| 1 | `browser_batch` (many actions, one call) | one script per action | `POST /batch` on server (`index.ts`) + relay (`relay.ts`); `client.batch(name, ops[])` |
| 2 | `read_console_messages` w/ regex filter | page console not captured (only extension's own log, `relay.ts:1624`) | capture `Runtime.consoleAPICalled` + `Log.entryAdded` per target in `relay-registry.ts`; `client.console(name, {pattern?})` |
| 3 | `read_network_requests` live tail | HAR only (`har.ts`) | `client.network(name, {pattern?})` live method/url/status log |
| 4 | `find` in page | none | `client.find(name, text)` → matches + snapshot refs (`snapshot/browser-script.ts`) |
| 5 | bulk `form_input` | `page.fill` per field | `client.form(name, {selector: value})` |
| 6 | `file_upload` | no `setInputFiles` in `cdp-page.ts` | add `page.setFiles(selector, paths)` to unified `Page` (`page.ts`); extension: `DOM.setFileInputFiles`, standalone: Playwright |
| 7 | JS dialogs auto-dismiss | none | dismiss on `Page.javascriptDialogOpening` in both modes; configurable |
| 8 | downloads in extension mode | partial (`relay.ts:452,602,1086`) | serve bytes via `GET /download/:id`, auto-clean; `page.waitForDownload()` |
| 9 | `read_page`/`get_page_text` first-class | only inline in webfetch agent | `client.markdown(name)` / `client.text(name)` (Turndown already used) |
| 10 | multi-browser (`switch/list_browsers`) | extension = whichever browser is running; standalone = Chromium only | standalone: `serve({browser})` → Playwright `channel: "chrome"\|"msedge"\|"brave"`; extension: label each WS connection with its browser (`extension/services/ConnectionManager.ts`), `client.listBrowsers()`, `connect({browser})` |
| 11 | per-origin permissions + per-origin CDP allowlist (`fullCdpAccess`) | raw `page.cdp()` only | `client.grantPermissions(origin, [...])` (`Browser.grantPermissions`); relay-side per-origin CDP method policy |
| 12 | named browser profiles | one `profileDir` (`index.ts:74-80`) | `serve({profile: "work"})` → `.browser-data-work/`; extension: launch with `--profile-directory=` |
| 13 | rich `tabs_context` | `client.list()` + `allTargets()` | MCP tool combining both + active-tab marker |
| 14 | health probe | `/stats` exists | add `GET /health` (mode, extensionConnected, uptime) |
| 15 | clear browsing data | none | `client.clearBrowsingData({types})` → `Browser.clearBrowserData` / `Storage.clearDataForOrigin` |

## P2 — policy enforced at the relay choke point

- Per-session `permissionMode` (strict default; permissive must be explicit opt-in).
- Per-session domain allow/block list, fail-closed, enforced in `relay.ts` before routing
  navigate/CDP to the extension.
- Per-origin `fullCdpAccess` toggle: default off; when off, relay blocks raw-CDP
  passthrough except an allowlisted method set.
- Per-origin state export/import: `client.exportOriginState(origin)` / `importOriginState`.

## P3 — packaging/UX

- Single `dev-browser` CLI (`serve` | `relay` | `mcp` | `browsers`) replacing
  `skills/dev-browser/{server,start,stop}.sh`.
- Update `skills/dev-browser/SKILL.md` with the MCP tool list and the vendor-tool →
  dev-browser mapping table (source: P1 table above).

## §4 Security track (do before/with P0 — relay currently has no auth)

`relay.ts:103` binds 127.0.0.1 only and `src/types.ts:11-15` treats the session as a bare
name — any local process can drive tabs on 9224 while the relay runs. Fixes:
(1) token file `~/.dev-browser/token` generated on first start, required on all HTTP
requests and the WS upgrade, read by `client.ts`; (2) reject WS upgrades carrying an
`Origin` header; (3) consider a signed native-messaging host in place of the extension's
`debugger` permission (vendor precedent: `allowed_origins` + 0600 sockets + peer tokens).

## Effort sketch

P0 ~1-2 days (client API is complete; mostly schemas + session plumbing). P1 #1-9 each
< 100 lines against existing relay/client; #10 is the largest. P2 is relay middleware +
a JSON policy file. P3 is packaging. Extension changes needed only for #10b and #8.

## Done criteria

For each landed item: `npx tsc --noEmit` clean, `npm test` green, plus a vitest case per
new endpoint/client method (see `src/__tests__/`, `extension/__tests__/`).
