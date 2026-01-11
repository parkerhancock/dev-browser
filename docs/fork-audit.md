# Fork Audit: Changes Worth Preserving

This documents the changes made since forking from upstream (SawyerHood/dev-browser) and which ones should be preserved in the new tab-group-based implementation.

## Commits Since Upstream

| Commit | Description | Verdict |
|--------|-------------|---------|
| `52c26d4` | Timeout handling for getAISnapshot | **KEEP** - Defensive fix for heavy JS sites |
| `0b49b4a` | Preserve session state across reconnects | **REPLACE** - Tab groups handle this |
| `acb9ecc` | Remove automatic tab activation | **KEEP** - Prevents tab flipping |
| `b7ca586` | Persist page mappings | **REPLACE** - Tab groups handle this |
| `6dcd1f9` | SessionStart hook for CLAUDE_SESSION_ID | **KEEP** - Essential for session identity |
| `ffa04f5` | Separate ports (9222/9224) | **KEEP** - Clean mode separation |
| `4a108d7` | Session ID in WebSocket URL | **KEEP** - Playwright can't send headers |
| `648f049` | Enable CDP domains on attach | **KEEP** - Real bug fix |
| `cc0a0a6` | Extension mode docs | **KEEP** - Useful docs |
| `8b01dba` | Add dev-terminal to related projects | **KEEP** - Minor docs |
| `4aa50c9` | Multi-agent session isolation | **PARTIAL** - Keep start.sh/stop.sh, replace relay logic |

## Changes to KEEP

### 1. SessionStart Hook (`hooks/`)
```
hooks/hooks.json
hooks/expose-session-id.sh
```
Exports `CLAUDE_SESSION_ID` environment variable from Claude Code session events. Essential for identifying which agent is which.

### 2. Separate Ports for Modes
- Standalone server: port 9222
- Extension relay: port 9224
- Client `mode` option: `connect({ mode: "extension" })`

Allows both modes to run simultaneously.

### 3. Session ID in WebSocket URL Path
```
/cdp/:session/:clientId
```
Playwright's `connectOverCDP` can't send custom headers, so session ID goes in the URL path.

### 4. Enable CDP Domains on Attach
In `TabManager.attach()`:
```typescript
await chrome.debugger.sendCommand(debuggee, "Page.enable");
await chrome.debugger.sendCommand(debuggee, "Network.enable");
await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
```
Without this, navigation events aren't captured because domains aren't enabled until Playwright sends enable commands - which may be too late.

### 5. No Automatic Tab Activation
When accessing a page via `client.page()`, don't call `chrome.tabs.update({ active: true })`. Prevents disruptive tab flipping when multiple agents work.

### 6. Snapshot Timeout Handling
`getAISnapshot()` with configurable timeout (default 10s) and health check (3s). Heavy JS sites can block CDP indefinitely.

### 7. Daemon Management Scripts
```
start.sh  - Idempotent relay startup
stop.sh   - Clean relay shutdown
```

## Changes to REPLACE

### Complex Session Tracking in relay.ts
Current approach:
```typescript
namedPages: Map<"session:name", tabId>
targetToAgentSession: Map<cdpSessionId, agentSession>
sessions: Map<agentSession, SessionState>
connectedTargets: Map<cdpSessionId, ConnectedTarget>
persistedPages: PersistedPage[]
```

Replace with:
```typescript
// Extension storage
sessionGroups: Map<sessionId, groupId>

// Runtime (rebuilt from tab group membership)
groupToSession: Map<groupId, sessionId>
```

### Persistence Layer
Current `persistence.ts` with JSON file storage for page mappings.

Replace with:
- Chrome's `chrome.storage.local` for session→group mappings
- Tab group membership for tab ownership (inherently persistent)

### Recovery Logic
Current `recoverPersistedPages()` with URL matching and reattachment.

Replace with:
- Scan tab groups on extension connect
- Rebuild runtime state from group membership
- No URL matching needed - group membership IS ownership

## Files to Cherry-Pick or Recreate

From commits:
- `hooks/hooks.json` - SessionStart hook config
- `hooks/expose-session-id.sh` - Session ID extraction
- `start.sh`, `stop.sh` - Daemon management
- Timeout logic from `client.ts` (getAISnapshot)
- CDP domain enabling from `TabManager.ts`
- Port separation from `relay.ts`, `client.ts`
- Session URL path from `relay.ts`

## Implementation Order

1. Reset to upstream/main
2. Create feature branch `feature/tab-group-isolation`
3. Cherry-pick or recreate:
   - Hooks (session ID)
   - Port separation
   - Daemon scripts
4. Implement new tab group architecture
5. Add back defensive fixes (timeout, CDP domains, no activation)
