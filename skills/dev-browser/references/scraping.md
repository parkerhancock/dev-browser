# Data Scraping Guide

For large datasets (followers, posts, search results), **capture and replay network requests** rather than scrolling and parsing the DOM. This is faster, more reliable, and handles pagination automatically.

## Why Not Scroll?

Scrolling is slow, unreliable, and wastes time. APIs return structured data with pagination built in. Always prefer API replay.

## Pick the Capture Method for Your Mode

The two modes capture traffic differently:

| Mode | Capture method | Why |
|------|---------------|-----|
| **Standalone** (port 9222) | `page.on("request"/"response")` | Real Playwright page — event listeners work |
| **Extension** (port 9224) | HAR recording + `client.getHarEntries()` | `page.on()` **throws** in extension mode |

In extension mode, calling `page.on(...)` throws:

> `page.on() is not supported in extension mode. Network traffic is captured automatically via HAR recording — use client.getHarEntries(name) to inspect it live, or client.stopHarRecording(name) to collect the full HAR.`

If you hit that error, jump to [Extension Mode: HAR-Based Capture](#extension-mode-har-based-capture) below. For API discovery against the user's logged-in Chrome, the extension-mode HAR path is the recommended approach.

## Start Small, Then Scale

**Don't try to automate everything at once.** Work incrementally:

1. **Capture one request** - verify you're intercepting the right endpoint
2. **Inspect one response** - understand the schema before writing extraction code
3. **Extract a few items** - make sure your parsing logic works
4. **Then scale up** - add pagination loop only after the basics work

This prevents wasting time debugging a complex script when the issue is a simple path like `data.user.timeline` vs `data.user.result.timeline`.

## Extension Mode: HAR-Based Capture

**Recommended for API discovery.** Extension mode runs in the user's real Chrome, so requests carry their logged-in cookies and auth headers — the traffic you capture is exactly what the authenticated app sends.

HAR recording auto-starts when you call `client.page(name)` (pass `{ record: false }` to skip). The recorder lives on the relay server, not in your script, so it survives across separate script runs: one script can drive the app and a later script can inspect the traffic. `client.getHarEntries(name)` returns the entries captured so far **without stopping the recording**.

### Script 1: Drive the App

```typescript
import { connect } from "@/client.js";

const client = await connect({ mode: "extension" });
const page = await client.page("app"); // HAR recording auto-starts

await page.goto("https://example.com/dashboard");
await page.click("a.load-more"); // Trigger the XHR/fetch calls you want to see

console.log("recording?", await client.isRecordingHar("app")); // true
await client.disconnect(); // Recording keeps running on the relay
```

### Script 2: Inspect the Captured Traffic

Run this as a **separate invocation** — the recorder is still active:

```typescript
import { connect } from "@/client.js";
import * as fs from "node:fs";

const client = await connect({ mode: "extension" });

const { entries, total } = await client.getHarEntries("app");
console.log(`${total} entries captured so far`);

// Find JSON API calls (XHR/fetch traffic)
const apiCalls = entries.filter(
  (e) =>
    e.response.content.mimeType?.includes("json") &&
    e.request.url.includes("/api/")
);

for (const e of apiCalls) {
  console.log(e.request.method, e.request.url.substring(0, 100));
}

// Save one response body to inspect the schema
if (apiCalls.length > 0) {
  fs.writeFileSync("tmp/api-response.json", apiCalls[0].response.content.text ?? "");
  // Save the request too — headers are needed for replay
  fs.writeFileSync(
    "tmp/request-details.json",
    JSON.stringify(
      {
        url: apiCalls[0].request.url,
        method: apiCalls[0].request.method,
        headers: Object.fromEntries(apiCalls[0].request.headers.map((h) => [h.name, h.value])),
      },
      null,
      2
    )
  );
}

await client.disconnect(); // Recording still running — keep driving and re-inspecting
```

### Incremental Polling with `since`

`getHarEntries` accepts `{ since: number }` — an index into the buffer. Pass the `total` from a previous call to get only the entries captured since then:

```typescript
const first = await client.getHarEntries("app");
// ... drive the app some more ...
const delta = await client.getHarEntries("app", { since: first.total });
console.log(`${delta.entries.length} new entries`);
```

### Stopping and Collecting the Full HAR

When you're done, `stopHarRecording` returns the complete HAR and resets the recorder:

```typescript
const har = await client.stopHarRecording("app");
fs.writeFileSync("tmp/session.har", JSON.stringify({ log: har }, null, 2));
```

Other HAR client methods, for reference:

```typescript
await client.isRecordingHar("app");    // async — queries the relay, sees recordings from earlier runs
await client.startHarRecording("app"); // no-op success if already recording (extension mode)
```

### HTTP Escape Hatch

The relay endpoints are directly curl-able. Pass the session as a `?session=<id>` query param (alternative to the `X-DevBrowser-Session` header):

```bash
curl 'http://localhost:9224/har/status?page=app&session=default'
# => {"recording":true,"entries":42}

curl 'http://localhost:9224/har/entries?page=app&session=default&since=0'
# => {"recording":true,"total":42,"entries":[...]}
```

Endpoints: `POST /har/start`, `POST /har/stop`, `GET /har/status?page=<name>`, `GET /har/entries?page=<name>&since=<n>`.

## Standalone Mode: `page.on` Event Listeners

**Standalone only.** In standalone mode, `page` is a real Playwright page, so event listeners work directly. (In extension mode this recipe throws — use the HAR workflow above.)

### 1. Capture Request Details

First, intercept a request to understand URL structure and required headers:

```typescript
import { connect, waitForPageLoad } from "@/client.js";
import * as fs from "node:fs";

const client = await connect();
const page = await client.page("site");

let capturedRequest = null;
page.on("request", (request) => {
  const url = request.url();
  // Look for API endpoints (adjust pattern for your target site)
  if (url.includes("/api/") || url.includes("/graphql/")) {
    capturedRequest = {
      url: url,
      headers: request.headers(),
      method: request.method(),
    };
    fs.writeFileSync("tmp/request-details.json", JSON.stringify(capturedRequest, null, 2));
    console.log("Captured request:", url.substring(0, 80) + "...");
  }
});

await page.goto("https://example.com/profile");
await waitForPageLoad(page);
await page.waitForTimeout(3000);

await client.disconnect();
```

### 2. Capture Response to Understand Schema

Save a raw response to inspect the data structure:

```typescript
page.on("response", async (response) => {
  const url = response.url();
  if (url.includes("UserTweets") || url.includes("/api/data")) {
    const json = await response.json();
    fs.writeFileSync("tmp/api-response.json", JSON.stringify(json, null, 2));
    console.log("Captured response");
  }
});
```

Then analyze the structure to find:

- Where the data array lives (e.g., `data.user.result.timeline.instructions[].entries`)
- Where pagination cursors are (e.g., `cursor-bottom` entries)
- What fields you need to extract

## Replay API with Pagination (Both Modes)

Once you understand the schema — whether it came from HAR entries or `page.on` — replay requests directly. `page.evaluate(fetch)` works identically in both modes and inherits the page's auth:

```typescript
import { connect } from "@/client.js";
import * as fs from "node:fs";

const client = await connect();
const page = await client.page("site");

const results = new Map(); // Use Map for deduplication
const headers = JSON.parse(fs.readFileSync("tmp/request-details.json", "utf8")).headers;
const baseUrl = "https://example.com/api/data";

let cursor = null;
let hasMore = true;

while (hasMore) {
  // Build URL with pagination cursor
  const params = { count: 20 };
  if (cursor) params.cursor = cursor;
  const url = `${baseUrl}?params=${encodeURIComponent(JSON.stringify(params))}`;

  // Execute fetch in browser context (has auth cookies/headers)
  const response = await page.evaluate(
    async ({ url, headers }) => {
      const res = await fetch(url, { headers });
      return res.json();
    },
    { url, headers }
  );

  // Extract data and cursor (adjust paths for your API)
  const entries = response?.data?.entries || [];
  for (const entry of entries) {
    if (entry.type === "cursor-bottom") {
      cursor = entry.value;
    } else if (entry.id && !results.has(entry.id)) {
      results.set(entry.id, {
        id: entry.id,
        text: entry.content,
        timestamp: entry.created_at,
      });
    }
  }

  console.log(`Fetched page, total: ${results.size}`);

  // Check stop conditions
  if (!cursor || entries.length === 0) hasMore = false;

  // Rate limiting - be respectful
  await new Promise((r) => setTimeout(r, 500));
}

// Export results
const data = Array.from(results.values());
fs.writeFileSync("tmp/results.json", JSON.stringify(data, null, 2));
console.log(`Saved ${data.length} items`);

await client.disconnect();
```

## Key Patterns

| Pattern                        | Mode       | Description                                            |
| ------------------------------ | ---------- | ------------------------------------------------------ |
| `client.getHarEntries(name)`   | Both       | Peek at captured traffic without stopping recording    |
| `client.stopHarRecording(name)`| Both       | Collect the full HAR and reset the recorder            |
| `page.on('request')`           | Standalone | Capture outgoing request URL + headers                 |
| `page.on('response')`          | Standalone | Capture response data to understand schema             |
| `page.evaluate(fetch)`         | Both       | Replay requests in browser context (inherits auth)     |
| `Map` for deduplication        | Both       | APIs often return overlapping data across pages        |
| Cursor-based pagination        | Both       | Look for `cursor`, `next_token`, `offset` in responses |

## Tips

- **Extension mode**: `page.context().cookies()` doesn't work - pull auth headers from HAR entries (`entry.request.headers`) instead
- **HAR headers are arrays**: convert with `Object.fromEntries(entry.request.headers.map(h => [h.name, h.value]))` before passing to `fetch`
- **Rate limiting**: Add 500ms+ delays between requests to avoid blocks
- **Stop conditions**: Check for empty results, missing cursor, or reaching a date/ID threshold
- **GraphQL APIs**: URL params often include `variables` and `features` JSON objects - capture and reuse them
