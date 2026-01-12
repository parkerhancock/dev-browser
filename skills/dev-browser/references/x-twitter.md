# X (Twitter) Automation

X has aggressive anti-bot measures. This guide documents working patterns discovered through testing.

## Key Constraints

1. **ARIA snapshots trigger detection** — `getAISnapshot()` causes pages to become unresponsive
2. **Rate limiting** — ~6 profile visits per session before blocking
3. **Tab closure** — X closes tabs when detecting rapid `fill()` operations
4. **Session state** — Relay must be restarted between batches to clear bad state

## Working Pattern: CSS Selectors Only

Use `data-testid` attributes and CSS selectors instead of ARIA snapshots:

```typescript
// Profile "More" menu (the ... button)
await page.click('[data-testid="userActions"]');

// Menu items by role + text
await page.click('[role="menuitem"]:has-text("Add/remove from Lists")');

// Save/Done buttons
await page.click('[data-testid="listDoneBtn"], button:has-text("Save")');

// Follow button
await page.click('[data-testid="follow"]');
```

## Add Account to List (Working Code)

```typescript
async function addToList(page, handle, listName) {
  // 1. Navigate with commit-only (don't wait for full load)
  await page.goto(`https://x.com/${handle}`, {
    waitUntil: "commit",
    timeout: 15000
  });
  await page.waitForTimeout(4000);

  // 2. Click More menu
  await page.click('[data-testid="userActions"]', { timeout: 5000 });
  await page.waitForTimeout(1000);

  // 3. Click Add/remove from Lists
  await page.click('[role="menuitem"]:has-text("Add/remove from Lists")', {
    timeout: 3000
  });
  await page.waitForTimeout(1500);

  // 4. Click list name to toggle checkbox
  await page.click(`text="${listName}"`, { timeout: 3000 });
  await page.waitForTimeout(500);

  // 5. Save
  await page.click('button:has-text("Save")', { timeout: 3000 });
  await page.waitForTimeout(1000);
}
```

## Batch Processing Pattern

Process accounts in batches of ~6, restarting relay between batches:

```typescript
const ACCOUNTS = ["handle1", "handle2", ...];
const BATCH_SIZE = 6;

for (let i = 0; i < ACCOUNTS.length; i += BATCH_SIZE) {
  const batch = ACCOUNTS.slice(i, i + BATCH_SIZE);

  const client = await connect({ mode: "extension" });
  const page = await client.page("worker");

  for (const handle of batch) {
    await addToList(page, handle, "AI Governance");
    await page.waitForTimeout(2000); // Human-like delay
  }

  await client.disconnect();

  // Restart relay between batches
  if (i + BATCH_SIZE < ACCOUNTS.length) {
    execSync('./stop.sh && sleep 2 && ./start.sh');
  }
}
```

## What NOT to Do

```typescript
// DON'T: Use ARIA snapshots - triggers detection
const snapshot = await client.getAISnapshot("page"); // ❌

// DON'T: Use fill() for form inputs - triggers tab closure
await page.fill('input[name="name"]', "text"); // ❌

// DON'T: Process more than ~6 accounts without relay restart
for (const h of allAccounts) { ... } // ❌ Will fail after ~6

// DON'T: Use short timeouts - X loads slowly
await page.waitForTimeout(1000); // ❌ Too short, use 4000+
```

## What DOES Work

```typescript
// DO: Use CSS selectors with data-testid
await page.click('[data-testid="userActions"]'); // ✅

// DO: Type slowly for form inputs
await page.keyboard.type("text", { delay: 100 }); // ✅

// DO: Use commit-only navigation
await page.goto(url, { waitUntil: "commit" }); // ✅

// DO: Wait 4-5 seconds after navigation
await page.waitForTimeout(4000); // ✅

// DO: Restart relay between batches
./stop.sh && sleep 2 && ./start.sh // ✅
```

## Known data-testid Values

| Element | Selector |
|---------|----------|
| Profile More menu (...) | `[data-testid="userActions"]` |
| Follow button | `[data-testid="follow"]` |
| Unfollow button | `[data-testid="unfollow"]` |
| List Done/Save button | `[data-testid="listDoneBtn"]` |
| Tweet/Post button | `[data-testid="tweetButton"]` |
| Reply button | `[data-testid="reply"]` |
| Retweet button | `[data-testid="retweet"]` |
| Like button | `[data-testid="like"]` |

## Error Recovery

If X becomes unresponsive:

1. Stop the relay: `./stop.sh`
2. Wait 2+ seconds
3. Restart: `./start.sh`
4. Create fresh page with new session

```typescript
// After errors, always escape any open dialogs
await page.keyboard.press("Escape").catch(() => {});
```

## List Management URLs

| Action | URL Pattern |
|--------|-------------|
| View list | `x.com/i/lists/{listId}` |
| Edit list | `x.com/i/lists/{listId}/edit` |
| List members | `x.com/i/lists/{listId}/members` |
| Create list | `x.com/i/lists/create` |
| Your lists | `x.com/{username}/lists` |
