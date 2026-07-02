# Extension mode: `page.on("request"/"response")` is not implemented, but the scraping guide depends on it

**Date:** 2026-07-02

## Problem

The documented workflow for API discovery / data scraping
(`skills/dev-browser/references/scraping.md`) is built entirely around Playwright
event listeners:

```typescript
page.on("request", (request) => { ... });
page.on("response", async (response) => { ... });
```

In **extension mode**, `page` is a `CDPPage`, which does **not** implement `.on()`.
It is `undefined`, so the listener is never registered and no error is thrown —
the capture silently produces nothing.

```typescript
const client = await connect({ mode: "extension" });
const page = await client.page("x") as CDPPage;
console.log(typeof (page as any).on); // "undefined"
```

This is the single most important capability for the task I was doing
(discovering a SPA's backing JSON API by observing its XHR/fetch traffic), and
the skill's own reference doc points you straight at an API that doesn't exist in
the mode most real work uses (extension mode = the user's logged-in Chrome).

## Impact

- No first-class way to observe network traffic in extension mode.
- `scraping.md` is misleading in extension mode: the recipe appears to run
  (no exception) but captures nothing.
- The only documented fallback is the server-side HAR recorder, which is itself
  broken across script runs — see
  `extension-mode-har-state-desync.md`.

## Environment

- macOS Darwin 25.3.0
- Node.js v24.13.0
- Extension mode (relay on port 9224), Chrome MV3 extension
- `CDPPage` from `skills/dev-browser/src/cdp-page.ts`

## Reproduction

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";
import type { CDPPage } from "@/cdp-page.js";
const client = await connect({ mode: "extension" });
const page = await client.page("t") as CDPPage;
console.log("has .on?", typeof (page as any).on); // "undefined"
await client.disconnect();
EOF
```

## Suggested fix direction

Pick one (in rough order of value):

1. **Implement `page.on("request"|"response"|"requestfinished")` on `CDPPage`.**
   The relay already subscribes to CDP `Network.*` events server-side to build
   HAR (`relay.ts` `handleHarNetworkEvent`). Expose those same events to the
   client over the existing RPC channel and dispatch them through a normal
   `EventEmitter` on `CDPPage`. This makes `scraping.md` work verbatim in both
   modes and is the least-surprising outcome.

2. **If `.on()` won't be implemented in extension mode,** add a clear guard: have
   `CDPPage.on` throw `"page.on() is not supported in extension mode — use HAR
   recording (client.startHarRecording) or inject a fetch/XHR interceptor"`, and
   update `scraping.md` with an explicit extension-mode section showing the
   supported path.

## Workaround I fell back to

Inject a `fetch` + `XMLHttpRequest` interceptor into the page via
`page.evaluate()`, store captures on a `window.__cap` global, drive the app, then
read the global back. This works but is fragile: the interceptor is wiped on
every navigation, so injection and interaction must happen in one script with no
`goto` in between.

## Resolution (2026-07-02)

`CDPPage.on()` now throws with guidance instead of silently not existing:
`page.on() is not supported in extension mode. Network traffic is captured
automatically via HAR recording — use client.getHarEntries(name) to inspect it
live, or client.stopHarRecording(name) to collect the full HAR.` The supported
capture path is the relay-side HAR recorder (state desync fixed separately, see
`extension-mode-har-state-desync.md`), plus a new live-peek API:
`client.getHarEntries(name, { since })` returns buffered entries without
stopping the recording, backed by a new `GET /har/entries?page=<name>&since=<n>`
relay endpoint. `references/scraping.md` was rewritten to be mode-aware, with
the extension-mode HAR workflow as the recommended path for API discovery.
