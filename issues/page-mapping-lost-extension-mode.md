# Extension mode: server loses track of pages it created

## Problem

In extension mode, the relay server loses track of pages created via `client.page()`. The Chrome tabs persist and remain functional, but subsequent calls to `client.list()` return an empty array and `client.page("name")` creates a new blank tab instead of returning the existing one.

This is not about discovering external tabs - these tabs were created by the dev-browser API itself within the same Claude Code session.

## Diagnostic output

After creating pages and running multiple scripts:

```javascript
const info = await client.getServerInfo();
// { wsEndpoint: 'ws://127.0.0.1:9224/cdp', mode: 'extension', extensionConnected: true }

const pages = await client.list();
// [] - empty, even though 3 tabs created via client.page() still exist in Chrome

const sessionId = client.getSession();
// 05f7d807-ff29-4b7d-a0db-c98442c66b83 (from CLAUDE_SESSION_ID)
```

## Steps to reproduce

1. Start relay server with `./start.sh`
2. Connect in extension mode and create a named page:
   ```typescript
   const client = await connect({ mode: "extension" });
   const page = await client.page("westlaw");
   await page.goto("https://1.next.westlaw.com");
   await client.disconnect();
   ```
3. Run several more scripts using the same page (works fine for a while)
4. At some point, the mapping is lost. Running:
   ```typescript
   const client = await connect({ mode: "extension" });
   const pages = await client.list();
   console.log(pages); // [] - empty!
   const page = await client.page("westlaw");
   console.log(page.url()); // 'about:blank' - new tab created instead of finding existing
   ```

## Observations

- The session ID remains consistent (`CLAUDE_SESSION_ID` env var)
- `extensionConnected: true` throughout
- The Chrome tabs created by earlier scripts are still open, logged in, and functional
- The server simply "forgot" about them

## Suspected cause

The page name to tab ID mapping may be stored in memory only and lost when:
- The relay server process has some internal state reset
- The WebSocket connection between client and server cycles
- Some timeout or cleanup process runs

## Expected behavior

Pages created via `client.page()` should persist for the lifetime of the relay server process (or at minimum, for the session). `client.list()` should return all pages created in the current session.

## Environment

- Extension mode with relay server on port 9224
- Session ID provided via `CLAUDE_SESSION_ID` environment variable
- macOS, Chrome browser

## Workaround

Re-navigate to URLs each time, but this:
- Loses page state (scroll position, form data, navigation history)
- Requires re-authentication if session cookies aren't shared (see related issue below)

## Related issues

1. **Auth cookies not shared**: New pages created in extension mode don't share auth cookies with existing logged-in tabs. A new `client.page()` call navigates to a fresh tab that requires re-authentication even when other tabs in the same browser are logged in.

2. **Extension connection replaced**: When attempting to query browser tabs via CDP, got error `"Extension connection replaced"`. The extension connection appears unstable:
   ```
   Error: Failed to get page: {"error":"Extension connection replaced"}
   ```
   This happened even though `getServerInfo()` returned `extensionConnected: true` moments before.
