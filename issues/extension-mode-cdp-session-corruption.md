# Extension mode: CDP session corruption from reconnect loop and stale response routing

**Date:** 2026-02-14

## Problem

Extension mode is unusable due to two cascading bugs:

1. **Infinite WebSocket reconnect loop** — The extension and relay enter a rapid connect/disconnect cycle (~10ms per iteration), generating 1.2M+ log lines and an 82MB log file in minutes.
2. **Stale CDP response routing** — After the reconnect storm (or even after normal client reconnections), Playwright receives CDP responses with `id` fields that don't match any pending request, causing an assertion crash in `CRSession._onMessage`.

Together these prevent any browser automation via extension mode. Pages are created and navigated (confirmed by URL), but all CDP interaction commands (screenshot, evaluate, getAISnapshot) either crash or hang indefinitely.

## Environment

- macOS Darwin 24.3.0
- Node.js v24.13.0
- Playwright (bundled in dev-browser)
- Chrome MV3 extension

## Root Cause Analysis

### Bug 1: Reconnect Loop

**Files:** `extension/services/ConnectionManager.ts:228-244`, `skills/dev-browser/src/relay.ts:1337-1351`

The relay's `/extension` WebSocket handler closes the existing connection when a new one arrives (code 4001, "Extension Replaced"). The extension's `onclose` handler sees the close, checks `this.shouldMaintain`, and immediately calls `startMaintaining()` → `runReconnectCycle()` → `tryConnect()`. The 3-second `RECONNECT_INTERVAL` only applies to *failed* retries, not the initial attempt from `startMaintaining()`. So the successful-then-immediately-closed pattern bypasses any delay.

**Loop:** Extension connects → relay closes old connection (4001) → extension onclose fires → immediate reconnect → relay closes previous → repeat forever.

### Bug 2: Missing `browserContextId`

**Files:** `extension/services/TabManager.ts:147`, `skills/dev-browser/src/relay.ts:40-46`, Playwright's `crBrowser.js:147`

Chrome's extension `chrome.debugger` API doesn't include `browserContextId` in its `TargetInfo`. Playwright's `CRBrowser._onAttachedToTarget` asserts this field exists. When the relay forwards `Target.attachedToTarget` events, the missing field causes:

```
Error: targetInfo: {"targetId":"...","type":"page","title":"...","url":"...","attached":true}
    at CRBrowser._onAttachedToTarget (crBrowser.js:147)
```

### Bug 3: Stale CDP Response Routing

**Files:** `skills/dev-browser/src/relay.ts` (sendToPlaywright, line 400+), Playwright's `crConnection.js:134`

The dev-browser client library connects and disconnects Playwright WebSocket clients rapidly during page setup (probe → disconnect → reconnect pattern). CDP command responses from the extension arrive after the requesting client has disconnected. Although `sendToPlaywright` targets specific `clientId`s, the relay also sends events (like `Target.attachedToTarget`) to all clients in a session. When a new Playwright client connects to the same session, it receives CDP messages with `id` fields from the previous client's request/response cycle. Playwright's `CRSession._onMessage` asserts `!object.id` for messages without matching callbacks, crashing the process:

```
Error: Assertion error
    at CRSession._onMessage (crConnection.js:134)
```

Even after patching Playwright to silently ignore unexpected IDs instead of crashing, CDP interaction commands (screenshot, evaluate) hang indefinitely — likely because critical handshake responses are being dropped or misrouted.

## Partial Fixes Applied

### Fix 1: Reconnect loop (WORKING)

**File:** `extension/services/ConnectionManager.ts:228-244`

Added check for close code 4001 to skip reconnection:

```typescript
// Code 4001 means the relay replaced this connection with a newer one
// from this same extension. Don't reconnect — the new connection is already active.
if (event.code === 4001) {
  this.logger.debug("Replaced by newer connection, skipping reconnect");
  return;
}
```

This breaks the infinite loop. A small initial burst (~12 connections) still occurs at startup but settles quickly.

### Fix 2: Missing browserContextId (WORKING)

**File:** `extension/services/TabManager.ts:147`

Added synthetic `browserContextId` to target info:

```typescript
targetInfo: { ...targetInfo, browserContextId: "default", attached: true },
```

Also added field to `TargetInfo` interfaces in both `extension/utils/types.ts` and `skills/dev-browser/src/relay.ts`.

### Fix 3: Playwright assertion patch (TEMPORARY WORKAROUND)

**File:** `node_modules/playwright-core/lib/server/chromium/crConnection.js:132-134`

Replaced hard assertion with silent ignore for unexpected response IDs. Also replaced `browserContextId` assertion in `crBrowser.js:147` with a fallback to `"default"`. **These are node_modules patches and will be lost on reinstall.**

## Remaining Issue

Even with all three fixes, CDP commands to the extension hang. The relay successfully routes responses (relay logs show IDs flowing up to 134+), but Playwright never resolves its promises. The likely root cause is in how the relay manages CDP session state across Playwright client reconnections — the probe-disconnect-reconnect pattern used by `client.page()` creates a window where CDP session mappings become stale.

## Reproduction

```bash
# Start relay
~/.claude/skills/dev-browser/start.sh

# Attempt any extension-mode operation
cd skills/dev-browser && npx tsx <<'EOF'
import { connect, navigateTo } from "@/client.js";
const client = await connect({ mode: "extension" });
const page = await client.page("test");
await navigateTo(page, "https://example.com");
await page.screenshot({ path: "tmp/test.png" }); // Hangs or crashes
await client.disconnect();
EOF
```

## Suggested Fix Direction

The CDP response routing needs to ensure that:
1. Responses are never sent to a client that didn't originate the request
2. When a Playwright client disconnects and reconnects, pending CDP commands from the old client are properly cancelled (not forwarded to the new client)
3. The relay's CDP session-to-client mapping is rebuilt cleanly on each new Playwright connection, not carried over from previous connections
