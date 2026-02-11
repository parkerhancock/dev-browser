# Named Pages Not Persisted in Extension Mode

## Problem

When using extension mode, named pages created via `client.page("amazon")` are not tracked correctly. This leads to:

1. **Tab accumulation**: Each call to `client.page("someName")` creates a new Chrome tab, even if the name was used before
2. **Lost names**: `client.list()` returns auto-generated names (`tab-12345`) instead of the original names
3. **Failed closes**: `client.close("amazon")` returns 404 because the name→tabId mapping doesn't exist

## Root Cause

In `src/relay.ts`, the `/pages` endpoints don't maintain a name→tabId mapping:

### POST /pages (line 493)
- Creates a new tab via extension
- Returns the name to the client
- **Does NOT store the name→tabId mapping**

### GET /pages (line 471)
- Queries extension for tabs in session
- Returns them as `tab-${tabId}` format
- **Original names are lost**

### DELETE /pages/:name
- Tries to find page by name
- **Fails with 404 because mapping was never stored**

## Reproduction

```typescript
const client = await connect();

// Create named page
const page1 = await client.page("amazon");
await page1.goto("https://amazon.com");

// Disconnect and reconnect
await client.disconnect();
const client2 = await connect();

// Try to reuse the same page - CREATES A NEW TAB!
const page2 = await client2.page("amazon");

// List pages - shows tab-12345, not "amazon"
console.log(await client2.list());  // ['tab-1631111898', 'tab-1631111902', ...]

// Try to close - FAILS
await client2.close("amazon");  // 404 error
```

## Impact

In a typical session, this caused **34+ zombie tabs** in Chrome that:
- Cannot be closed via the API
- Consume browser memory
- Must be manually closed by the user

## Suggested Fix

Add a name→tabId map in the relay that persists for the agent session:

```typescript
// In relay.ts
const pageNameToTabId = new Map<string, Map<string, number>>();  // session -> (name -> tabId)

// POST /pages - store the mapping
const result = await sendToExtension({ method: "createTab", ... });
const sessionMap = pageNameToTabId.get(agentSession) ?? new Map();
sessionMap.set(name, result.tabId);
pageNameToTabId.set(agentSession, sessionMap);

// GET /pages - return names where available
const sessionMap = pageNameToTabId.get(agentSession);
const pages = result.tabs.map(t => {
  // Find name for this tabId, or use auto-generated
  for (const [name, tabId] of sessionMap?.entries() ?? []) {
    if (tabId === t.tabId) return name;
  }
  return `tab-${t.tabId}`;
});

// DELETE /pages/:name - look up tabId by name
const sessionMap = pageNameToTabId.get(agentSession);
const tabId = sessionMap?.get(name);
if (tabId) {
  await sendToExtension({ method: "closeTab", params: { tabId } });
  sessionMap.delete(name);
}
```

## Workaround

Until fixed, agents should:
1. Always use the same page name (reduces tab creation)
2. Do all work in a single script execution
3. Manually close Chrome tabs when done
4. Document this limitation in skill instructions
