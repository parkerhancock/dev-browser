# Extension mode: named page silently rebinds to `about:blank` after idle cleanup or relay restart

**Date:** 2026-07-02

## Problem

In extension mode, a named page (e.g. `client.page("docketnav")`) that was
previously navigated to a real URL comes back bound to **`about:blank`** in a
later script run. The name is still known to the relay — `client.list()` returns
`["docketnav"]` — but the target it points at is a fresh/blank tab, not the live
one. The original tab is left **orphaned** in Chrome. Calling `page.goto()` then
navigates the blank tab (or spawns yet another), so every script has to
re-navigate from scratch and orphan tabs pile up against the 5-tab limit.

This is distinct from the two existing issues:

- `named-pages-not-persisted.md` and `page-mapping-lost-extension-mode.md`
  describe `client.list()` returning `[]` (name lost entirely).
- **Here the name survives, but its target binding is stale/blank.** `list()`
  returns the name; `page.syncUrl()` returns `about:blank`.

`{ pinned: true }` did **not** prevent it.

## Concrete evidence

After several script runs (and one relay restart to pick up a new build), a
single diagnostic script showed the name correctly mapped **but a duplicate
orphan tab left behind**:

```
client.list(): [ 'docketnav' ]
client.page("docketnav").url(): https://search.docketnavigator.com/patent/custom-search

ALL browser tabs (client.allTargets()):
  * tabId=1631157978  https://search.docketnavigator.com/patent/search?intro=true   <-- ORPHAN (original)
  * tabId=1631157997  https://search.docketnavigator.com/patent/custom-search        <-- current binding
    ... 9 unrelated tabs ...
```

Two DocketNavigator tabs exist; the relay only tracks the newer one. Earlier runs
showed the stronger form of the symptom: a fresh script's
`client.page("docketnav")` → `page.syncUrl()` returned `about:blank` even though
the live app tab (…978) was sitting right there in the browser.

## Root cause (from relay log)

The relay log shows two mechanisms that strand a named page:

**1. Idle-timeout cleanup closes the backing tab.**

```
[relay] Idle timeout: closing 8635D84B52B2D43B9FD9ABC87D6A91DB (inactive for 354s)
[relay] Target detached: pw-...-tab-99 (no named page - immediate cleanup)
```

Between separate `npx tsx` invocations there is no CDP activity, so the idle
timer fires and the target is closed. The name→target binding is not
re-established against the surviving Chrome tab on next access; a new/blank
target is used instead. (Note: the skill docs say the idle timeout is 15s, but
the log shows ~300s — worth reconciling.)

**2. Relay restart / extension reconnect recovery marks pages "stale".**

```
[relay] Extension disconnected
[relay] Extension connected
[relay] Attempting to recover 1 persisted pages...
[relay] Found 12 available targets
[relay] Tab not found for <session>:<page> (about:blank)
[relay] Recovery complete: 0 recovered, 1 stale
```

On restart the recovery pass looks for the persisted page's tab, doesn't match it
among available targets, logs `about:blank`, and marks it **stale** rather than
re-binding to the live tab. Restarting the relay to pick up a new build (which I
did in this session) triggers exactly this, which is why the page blanked right
after the restart.

## Impact

- Every script must defensively re-`goto()` the target URL; you can't rely on a
  named page surviving between runs, which is the core promise of the tool.
- Orphan tabs accumulate (each re-navigation can leave the previous tab behind),
  pushing toward the hard 5-tab session limit.
- `{ pinned: true }` does not exempt the page from the blanking in practice.
- Network/HAR capture keyed by page name still works (the recorder is
  server-side), but interaction/navigation state is lost.

## Environment

- macOS Darwin 25.3.0
- Node.js v24.13.0
- Extension mode (relay on port 9224), Chrome MV3 extension

## Reproduction

```bash
# Script 1 — create + navigate a named page
cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";
import type { CDPPage } from "@/cdp-page.js";
const client = await connect({ mode: "extension" });
const page = await client.page("repro", { pinned: true }) as CDPPage;
await page.goto("https://example.com/");
await page.syncUrl();
console.log("navigated to:", page.url());
await client.disconnect();
EOF

# Wait past the idle timeout (or restart the relay: ./stop.sh && ./start.sh)

# Script 2 — same name, fresh client
cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";
import type { CDPPage } from "@/cdp-page.js";
const client = await connect({ mode: "extension" });
console.log("list:", await client.list());          // ["repro"] — name retained
const page = await client.page("repro") as CDPPage;
await page.syncUrl();
console.log("url now:", page.url());                  // about:blank (expected: example.com)
console.log("orphan tabs:", (await client.allTargets()).filter(t => /example\.com/.test(t.url)));
await client.disconnect();
EOF
```

## Suggested fix direction

1. **Rebind named pages to surviving Chrome tabs on access.** When
   `client.page(name)` resolves a name whose target was idle-closed, match it back
   to the existing tab (by last-known URL or a stored tabId) instead of handing
   back a blank target.
2. **Fix restart recovery matching.** The `Attempting to recover N persisted
   pages` pass reports `0 recovered, N stale` even when the live tab is present in
   `Found M available targets`. Recovery should match persisted pages against
   available targets (URL/tabId) and re-bind rather than marking stale.
3. **Actually exempt pinned pages from idle cleanup** (or document that pinning
   does not survive across separate client connections, if that is intended).
4. **Reconcile the idle timeout value** — docs say 15s, relay logs show ~300s.
5. Consider not orphaning the old tab: if a named page must rebind, reuse or close
   the prior tab so duplicates don't accumulate toward the 5-tab limit.

## Resolution (2026-07-02)

Fixed. Four defects were confirmed behind the symptom:

1. **Idle cleanup closed named pages' tabs and deleted their persistence
   entry**, guaranteeing a blank tab on next access. Named pages are now never
   idle-closed — the idle timer only reaps anonymous targets (never-named
   tabs from createTarget races). Named tabs are capped by the session
   TAB_LIMIT and cleaned up explicitly.
2. **Restart recovery matched tabs by exact URL only**, and the tracked URL
   drifts (SPA redirects) between debounced saves — plus a persisted
   `about:blank` could match any blank tab. Recovery now matches by tabId
   first (the only stable key — the extension reports placeholder targetIds),
   falls back to last-known URL, and never matches on `about:blank`.
3. **Recovery hardcoded `pinned: false`**, so pinning evaporated on any
   extension reconnect (why `{ pinned: true }` "didn't help"). The pinned flag
   is now persisted to pages.json and preserved through recovery, reuse, and
   `PATCH /pages`.
4. **`POST /pages` created a fresh blank tab** when the name's CDP session was
   gone. It now first tries to rebind to the surviving Chrome tab from
   persistence (tabId, then URL), logging `action=rebound`, so orphans no
   longer accumulate.

The idle timeout is 60s (env `DEV_BROWSER_IDLE_TIMEOUT_MS`), not the 15s the
docs claimed; SKILL.md corrected. Regression tests in
`src/__tests__/relay-recovery.test.ts` reproduce all three scenarios
(verified failing pre-fix). Tests also now use an isolated `DEV_BROWSER_DIR`
so running the suite can no longer prune real persisted pages.
