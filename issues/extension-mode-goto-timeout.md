# Extension mode: page.goto() times out even though page loads in browser

**Date:** 2026-01-08

## Problem

When using extension mode, `page.goto()` times out waiting for navigation events even though the page successfully loads in the browser. The extension creates tabs and navigates correctly from the user's perspective, but the Playwright client never receives the load/commit events.

## Environment

- Mode: Extension mode (connecting to user's existing Chrome browser)
- Relay server: Running and connected (`Relay ready` confirmed)
- Extension: Connected (no "Extension not connected" error after activation)

## Steps to Reproduce

1. Start relay server with `./skills/dev-browser/start.sh`
2. Activate Chrome extension
3. Run a simple navigation script:

```typescript
import { connect } from "@/client.js";

const client = await connect();
const page = await client.page("test");

// This times out even though page loads in browser
await page.goto("https://example.com", { timeout: 10000 });
```

## Observed Behavior

- `client.list()` works and returns `[]` (no pages)
- `client.page("name")` successfully creates a page
- `page.goto()` times out with:
  ```
  page.goto: Timeout 10000ms exceeded.
  Call log:
    - navigating to "https://example.com/", waiting until "load"
  ```
- The page **does** load correctly in the user's browser
- Tried `waitUntil: "commit"` - same timeout
- Tried `waitUntil: "domcontentloaded"` - same timeout

## Expected Behavior

`page.goto()` should resolve once the page loads, allowing subsequent operations like `page.screenshot()` and `getAISnapshot()`.

## Workaround Attempted

Tried skipping `goto` and just working with existing page state, but `page.title()`, `page.url()`, and `getAISnapshot()` also hang/timeout, suggesting the extension-to-relay communication for page state is not working.

## Additional Context

This was tested with Google Flights and example.com - both exhibit the same behavior. The user confirmed visually that both pages loaded correctly in their browser.

## Possible Causes

1. Extension not properly emitting navigation lifecycle events to the relay
2. Relay not forwarding events to the Playwright client
3. Event listener mismatch between what Playwright expects and what the extension emits
4. Chrome extension API limitations in capturing load events for tabs it didn't create
