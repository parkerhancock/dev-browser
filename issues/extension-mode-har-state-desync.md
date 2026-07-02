# Extension mode: HAR recorder state desyncs between client and server across script runs

**Date:** 2026-07-02

## Problem

The server-side HAR recorder is the intended extension-mode replacement for
Playwright `page.on("request"/"response")` (see
`extension-mode-no-request-response-events.md`). But its state is unusable across
separate script executions — which is dev-browser's whole model, since each
`npx tsx` invocation is a fresh client against long-lived server-side pages.

Observed contradictions within a single Claude Code session (same
`CLAUDE_SESSION_ID`, same persisted `docketnav` page):

- `client.isRecordingHar("docketnav")` returns **false**
- `GET /stats` reports **`harRecorders: 1`**
- `client.startHarRecording("docketnav")` throws **409 "HAR recording already active"**
- `client.stopHarRecording("docketnav")` throws **"No HAR recording active for page"**

So the client thinks it is not recording, refuses to start (server says it is),
and refuses to stop (client-local set says it is not). There is no way to reach
the buffered data or to reset the recorder.

## Root cause

The client tracks recording state in a **closure-local, in-memory `Set`** that is
recreated empty on every `connect()`, while the server tracks it in a
**process-global map** that persists across client connections.

`skills/dev-browser/src/client.ts`, `connectExtensionMode`:

```typescript
// Track which pages have HAR recording (for isRecordingHar check)
const harPages = new Set<string>();   // <-- per-connection, dies on disconnect

async function stopRecording(name: string): Promise<HarLog> {
  if (!harPages.has(name)) {
    throw new Error(`No HAR recording active for page "${name}"`); // never hits server
  }
  ...
}
```

`skills/dev-browser/src/relay.ts`:

```typescript
const harRecorders = new Map<string, RelayHarState>(); // process-global, survives reconnects
```

Failure sequence:

1. **Run 1** — `client.page("docketnav")` auto-starts HAR. Server adds to
   `harRecorders`; client adds to `harPages`. Client disconnects; `harPages` is
   garbage-collected, **server recorder persists**.
2. **Run 2** — fresh client, empty `harPages`.
   - `page()` auto-start POSTs `/har/start` → server returns **409**; client
     catches the non-ok response and silently skips, so `harPages` stays empty.
   - `isRecordingHar()` reads the empty client set → **false**.
   - `startHarRecording()` → **409** from server.
   - `stopRecording()` guards on the empty client set and **throws before ever
     calling `/har/stop`**, so the server recorder can never be drained or reset.

Secondary papercut: the HTTP endpoints resolve session from the
`X-DevBrowser-Session` **header** (`getAgentSession` in `src/types.ts`), not a
query param. Manual `curl` attempts with `?session=...` silently fall back to the
`"default"` session, so `GET /har/status?...` reports `recording:false` even
though a recorder exists under the real session. This makes the endpoints hard to
drive by hand as an escape hatch.

## Impact

Server-side HAR recording — the only documented extension-mode network-capture
path — cannot be relied on across script runs. Combined with the missing
`page.on` (`extension-mode-no-request-response-events.md`), extension mode has no
working network-capture primitive.

## Environment

- macOS Darwin 25.3.0
- Node.js v24.13.0
- Extension mode (relay on port 9224)

## Reproduction

```bash
# Run twice as SEPARATE invocations (simulates the normal script-per-step model)
cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";
const client = await connect({ mode: "extension" });
const page = await client.page("repro");            // auto-starts HAR server-side
console.log("recording?", client.isRecordingHar("repro"));
await client.disconnect();
EOF

cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";
const client = await connect({ mode: "extension" });
const page = await client.page("repro");
console.log("recording?", client.isRecordingHar("repro")); // false
try { await client.startHarRecording("repro"); } catch (e) { console.log("start:", e.message); } // 409
try { await client.stopHarRecording("repro"); }  catch (e) { console.log("stop:",  e.message); } // "No HAR recording active"
await client.disconnect();
EOF
```

## Suggested fix direction

1. **Make the client stateless about recording; treat the server as source of
   truth.** `isRecordingHar` should query `GET /har/status`; `stopHarRecording`
   should always POST `/har/stop` and surface the server's 404 rather than
   guarding on a local set; `startHarRecording` should treat 409 as "already
   recording" (success/no-op) instead of a silent skip.
2. **Make auto-start idempotent.** On `page()`, a 409 from `/har/start` should be
   treated as already-recording (add to any local cache), not swallowed.
3. **Provide a reset/force-stop path** so a recorder orphaned by a previous
   client can be drained. Even a `POST /har/stop` that succeeds regardless of
   client-local state would unblock manual recovery.
4. Consider having `GET /har/status` accept the session via query param as an
   alternative to the header, so the endpoints are usable as a manual escape
   hatch.

## Resolution (2026-07-02)

Fixed in commit 8b114b9. The relay is now the source of truth for
extension-mode HAR state and the client is stateless: `isRecordingHar()` is
async and queries `GET /har/status`, `stopHarRecording()` always POSTs
`/har/stop` and surfaces the server's response, and `startHarRecording()`
(including the `page()` auto-start) treats an already-active recording as a
no-op success instead of a 409. Recorders started by one script run are
therefore visible and drainable from later runs. The relay HAR endpoints also
accept the session as a `?session=<id>` query param as an alternative to the
`X-DevBrowser-Session` header, so `curl` works as a manual escape hatch.
