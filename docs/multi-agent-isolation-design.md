# Multi-Agent Browser Isolation: Design Document

## Goal

Allow multiple AI agents to share a single browser instance without collision. Each agent should have an isolated view of "their" tabs, see tabs created by their actions, and not interfere with other agents.

## Current Approach

The current implementation tracks tab ownership through several layers of indirection:

```
namedPages: Map<"session:pageName", tabId>
targetToAgentSession: Map<cdpSessionId, agentSession>
sessions: Map<agentSession, { clientIds, pageNames, targetSessions }>
connectedTargets: Map<cdpSessionId, targetInfo>
persistedPages: Array<{ key, targetId, tabId, url }>
```

### Problems with Current Approach

1. **CDP session volatility**: CDP's `sessionId` and `targetId` change whenever the debugger reattaches (extension reconnect, page navigation, Chrome security boundaries). We spend significant effort tracking these changes and updating mappings.

2. **Complex recovery logic**: When the extension disconnects and reconnects, we attempt to recover pages by matching URLs, reattaching debuggers, and rebuilding session mappings. This is fragile and has race conditions.

3. **Event routing complexity**: Routing CDP events to the correct agent requires maintaining reverse mappings (`targetToAgentSession`). Events for unknown sessions must be broadcast, creating potential leakage.

4. **Invisible state**: Users can't see which tabs belong to which agent. Debugging requires reading logs.

5. **No handling of spawned tabs**: When an agent's action opens a new tab (link click, popup), there's no mechanism to associate it with that agent.

## Proposed Approach: Tab Groups as Identity

Use Chrome's native Tab Groups as the organizational primitive. The tab group IS the agent's workspace.

### Core Concept

```
Agent Session ID  ←→  Chrome Tab Group (1:1)
```

- Session ID is the stable identifier agents use (e.g., `CLAUDE_SESSION_ID`)
- Tab Group is the visual, persistent container in Chrome
- Tab membership in a group determines ownership
- No need to track CDP session volatility - group membership is stable

### Data Model

**Extension storage (persistent):**
```typescript
interface SessionGroup {
  sessionId: string;      // Agent's identifier
  groupId: number;        // Chrome tab group ID
  groupName: string;      // Human-readable: "Session 1", "Research Project"
  createdAt: number;      // Timestamp for debugging/cleanup UI
}

// Stored in chrome.storage.local
sessions: SessionGroup[]
```

**Runtime state (in-memory):**
```typescript
// Tab group ID → Session ID (for fast event routing)
groupToSession: Map<number, string>

// Attached tabs with their CDP sessions
attachedTabs: Map<tabId, { sessionId: string, targetId: string }>
```

### Flows

**Agent connects with session ID:**
```
1. Client connects: POST /session { sessionId: "conv-abc123" }
2. Extension checks storage for existing mapping
3. If found:
   - Verify group still exists
   - Return group info
4. If not found:
   - Create new tab group with friendly name
   - Store mapping
   - Return group info
5. Client receives: { groupId, groupName, tabs: [...] }
```

**Agent creates a tab:**
```
1. Client: POST /pages { name: "search", sessionId: "conv-abc123" }
2. Extension:
   - Look up group for session
   - Create tab
   - Add tab to group: chrome.tabs.group({ tabIds: [tab.id], groupId })
   - Attach debugger
   - Enable CDP domains
3. Return: { tabId, targetId, sessionId }
```

**Agent action spawns a new tab:**
```
1. chrome.tabs.onCreated fires with openerTabId
2. Check if opener is in a managed group
3. If yes:
   - Add new tab to same group
   - Attach debugger
   - Send Target.attachedToTarget to owning agent
4. Agent automatically sees the new tab
```

**CDP event routing:**
```
1. Event fires for tabId X
2. Query: which group is tab X in?
3. Query: which session owns that group?
4. Route event to clients with that session ID
5. If tab not in any managed group → ignore (not our tab)
```

**Extension reconnects:**
```
1. Load session mappings from storage
2. For each mapping:
   - Check if group still exists
   - Scan tabs in group
   - Reattach debuggers
   - Rebuild runtime state
3. Agents reconnect with same session ID → see their tabs
```

**Agent cleanup:**
```
Option A - Agent-initiated:
  DELETE /session { sessionId: "conv-abc123" }
  → Close all tabs in group
  → Ungroup and delete group
  → Remove mapping

Option B - User-initiated:
  → User closes tab group in Chrome
  → Extension detects group removal
  → Cleans up mapping

No automatic timeout - tabs persist until explicit cleanup.
```

### API Changes

**New endpoints:**

```
POST /session
  Request: { sessionId: string, name?: string }
  Response: { groupId: number, groupName: string, tabs: TabInfo[] }

  Creates or retrieves a session's tab group.

DELETE /session/:sessionId
  Closes all tabs and removes the session.

GET /session/:sessionId/tabs
  Lists all tabs in the session's group.
```

**Modified endpoints:**

```
POST /pages
  Now requires sessionId (or X-DevBrowser-Session header)
  Creates tab in the session's group

DELETE /pages/:name
  Only closes tabs owned by the requesting session
```

### What This Simplifies

| Current | Proposed |
|---------|----------|
| Track CDP sessionId changes | Group membership is stable |
| Complex URL-based recovery | Groups persist naturally |
| Multiple mapping tables | One mapping: session → group |
| Invisible ownership | Visual tab groups |
| Manual event routing | Query tab's group |
| No spawned tab handling | openerTabId → same group |

### Edge Cases

**User manually moves tab between groups:**
- Tab now belongs to new group's session
- Old agent loses access, new agent gains it
- This is intentional - users have control

**User manually creates tab in agent's group:**
- Tab becomes visible to agent
- Agent can interact with it
- Useful for "here, look at this page"

**Tab group deleted by user:**
- Session mapping becomes stale
- Next agent connect creates fresh group
- Old tabs are gone (user chose this)

**Multiple agents claim same session ID:**
- They share the same group (intentional)
- Both see same tabs, same events
- Use case: agent reconnecting, or collaborative agents

### Migration Path

1. Implement new tab group logic alongside existing code
2. New sessions use tab groups
3. Existing sessions continue with old logic
4. Eventually deprecate old approach

### Visual Result

```
Chrome Tab Bar:
┌─────────────────────────────────────────────────────────┐
│ [Session 1      ▼] [Research      ▼] [Personal tabs...] │
│ ├─ Google        │ ├─ Wikipedia    │                    │
│ ├─ Search Result │ ├─ Paper.pdf    │                    │
│ └─ Product Page  │ └─ Notes        │                    │
└─────────────────────────────────────────────────────────┘

Agent A (Session 1): sees Google, Search Result, Product Page
Agent B (Research):  sees Wikipedia, Paper.pdf, Notes
Neither sees the other's tabs or personal tabs.
```

## Summary

The current approach fights against CDP's volatility by maintaining complex mappings that must be constantly updated. The proposed approach embraces Chrome's native tab groups as the ownership primitive, resulting in:

- **Simpler code**: One mapping instead of five
- **More reliable**: Group membership doesn't change on debugger reattach
- **Better UX**: Users see which tabs belong to which agent
- **Natural semantics**: Spawned tabs inherit parent's group
- **User control**: Standard Chrome UI for managing groups

The key insight is that we were building a shadow organizational system when Chrome already has one built in.
