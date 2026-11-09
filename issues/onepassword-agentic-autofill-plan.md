# Plan: 1Password agentic autofill in standalone dev-browser

**Date:** 2026-11-08
**Status:** out of scope (decided 2026-11-09). The OAuth client requires a paid
1Password Business account, about $9 per user per month, kept active for as
long as the connection is used. There's also a possible partner agreement,
which isn't worth it for this library. Sign-in automation stays with Claude in
Chrome's own 1Password autofill in extension mode. This document is kept as a
record of the verified findings in case that changes.
**Owner:** Parker

## Problem

Standalone and Docker dev-browser can't sign in to anything safely. Claude in
Chrome signs in through "1Password for Claude," but that path accepts only a
code-signed partner app on 1Password's allowlist. 1Password's partner preview,
the integration Browserbase uses, offers the same capability through the stock
browser extension. The extension's service worker exposes
`api.agenticAutofill.v1`, authenticated with a per-user OAuth connection.
1Password's software decrypts the login, fills it, submits the form, and
returns only a status.

Verified on 2026-11-08:

- I loaded extension 8.12.44.33 (Chrome Web Store stable build, unpacked) into
  patchright's Chromium on macOS.
- The service worker exposed `initialization`, `agenticMode`
  (`enable`, `disable`), and `agenticAutofill` (`createAccessRequest`,
  `getAccessRequestStatus`, `fillCredential`), with state `ready`.
- No policy was set. The API was turned on by 1Password's server feature flag
  `prereg-b5x-credential-brokering-agentic-autofill-remote-browser`.
- The extension source also accepts the managed-storage policy
  `AgenticAutofillRemoteBrowser: true`.
- Every call requires `accessToken` and `integrationKey`.
- `fillCredential` refuses to fill unless Agentic Mode is on in that tab and
  the tab's domain is one of the login's saved websites.

Sources are 1Password's partner docs (`https://www.1password.dev/agentic-autofill/partners/`:
connect, access-requests, approval, fill, extension-api, keys-and-tokens,
disconnect) and `https://docs.browserbase.com/integrations/1password/agentic-autofill`.
All of these are labeled "Partner preview."

## Goals

- G1. In a standalone dev-browser page, the agent signs in with a 1Password
  Login item. Parker approves each request in the 1Password app. Neither the
  agent nor dev-browser receives the password or one-time code.
- G2. The MCP server offers tools named like Claude in Chrome's:
  `request_credentials`, `autofill_credential`, `list_granted_credentials`,
  `release_credentials`, and `enter_verification_code`.
- G3. Nothing from a fill appears in network capture, WACZ archives,
  screenshots, GIF frames, or tool output.

## Non-goals

- Extension mode. Claude in Chrome's own autofill covers the user's real
  Chrome.
- Docker and remote servers. The approval link has to open on the Mac that
  runs the 1Password app, and v1 refuses otherwise.
- Passkeys, item types other than Login, and sign-in-provider pickers. 1Password
  doesn't support them in this API.
- Revoking a single grant at 1Password. The API offers only a full disconnect.
- `--browser chrome`. Chrome 137 and later ignore `--load-extension`, so v1
  supports only the bundled Chromium.

## Requirements

- R1. When the standalone server starts with the `onePassword` option (CLI:
  `--onepassword`), it shall load the 1Password extension. Without the option
  it shall not load it. The option is off by default.
- R2. The extension shall be the stable Chrome Web Store build, downloaded from
  Google's update service. Its CRX3 signature shall be verified, and its signing
  key shall hash to `aeblfdkhhhdcdjpifhhbdiojplfjncoa`. It shall be loaded
  unpacked with no manifest `key`, so it gets an ID that the 1Password desktop
  app's native-messaging host doesn't allow.
- R3. If the extension in dev-browser connects to the 1Password desktop app
  (that is, it shows as linked or unlocked), then the server shall unload it
  and refuse the credential tools. A dev-browser profile must never hold the
  full vault.
- R4. When `request_credentials` is called with a goal of up to 140 characters
  and 1 to 5 entries of `{website, reason?, keywords?}`, the server shall:
  - create an access request;
  - open its `appLink` on the Mac with `open`;
  - poll on 1Password's documented schedule (5 s, then every 2/5/10 s up to
    120 s);
  - return each entry's status (`granted`, `denied`, `pending`, or `failed`)
    and an opaque local handle.

  The tool result shall never contain the `appLink`, the grant `reference`,
  or any token.
- R5. When `autofill_credential(page, handle)` is called, the server shall:
  - enable Agentic Mode for that tab;
  - resolve the tab's Chrome tab ID;
  - lock the page;
  - call `fillCredential`;
  - wait for the navigation that follows, up to 15 s;
  - unlock the page.

  It shall return only a status or error code (`fill_submitted`,
  `noExistingCredentials`, `autosubmitFailed`, and so on).
- R6. While a page is locked, every MCP tool that reads or drives that page
  shall wait for the lock, and fail with "page busy signing in" if the lock
  lasts longer than the fill timeout. That covers `screenshot`, `computer`,
  `read_page`, `find`, `get_page_text`, `javascript`, `form_input`, network
  bodies, console, and GIF frames.
- R7. Network capture shall drop request bodies and `Authorization` headers for
  requests from a locked page. This lasts from the lock until the first
  navigation after submit finishes, or 15 s at most. WACZ archives are built
  from those same entries.
- R8. When `enter_verification_code(page)` is called, the server shall show a
  native macOS dialog with hidden input that names the site. It shall type the
  code into the focused element with `Input.insertText`, apply the same lock
  and redaction, and return only a status.
- R9. If the server isn't bound to loopback, or there's no logged-in GUI
  session, the credential tools shall return "requires a local server on the
  Mac running 1Password."
- R10. Parker creates the connection with the CLI command
  `dev-browser onepassword connect`. The client secret, access and refresh
  tokens, and integration key shall be stored in the macOS Keychain.
  - Token refreshes shall be serialized, and every refresh shall store the new
    rotated refresh token.
  - An `invalid_grant` error shall make the tools answer "reconnect with
    `dev-browser onepassword connect`".
  - `dev-browser onepassword disconnect` shall call
    `/v1alpha1/oauth-integrations/self:revoke` and delete the Keychain items.
- R11. `release_credentials` shall forget local handles. Its result shall say
  that grants stay valid at 1Password for up to 30 days, and that `disconnect`
  revokes everything.
- R12. The server shall keep a CDP session attached to the extension worker,
  because the worker otherwise suspends after about 30 s. It shall also wait
  for `api.initialization.v1.whenSettled()` to return `ready`. If
  `agenticAutofill` is missing because the flag is off, the tools shall say
  "1Password hasn't enabled agentic autofill for this browser."

## Acceptance criteria

- A1 (R4–R8, R11). Tests use a fake extension fixture,
  `src/__tests__/fixtures/fake-1password/`. It is an MV3 worker that exposes
  the same `globalThis.api` surface and fills a sentinel password into a local
  test form. Given that fixture, the full request → approve → fill flow
  succeeds. The sentinel never appears in any tool result, HAR entry, WACZ
  record, or console capture. A tool call made during the fill waits for the
  lock.
- A2 (R2, R3). Given the real extension, the download is verified and loaded,
  the API reports `ready`, and the extension's desktop-app state is not
  connected.
- A3 (G1). This is a live run with Parker present. He connects, approves one
  Login item, and the agent signs in. Then `grep` for the password across
  `~/.dev-browser/`, the HAR, and the transcript finds nothing.
- Checks: `cd skills/dev-browser && npx tsc --noEmit && npm test`, then
  `cd mcp-server && npx tsc --noEmit && npm test`.

## Decisions

- D1. Use the extension's partner API, not the `op` CLI. The extension decrypts
  and fills, so the password never passes through dev-browser or the agent's
  shell. Rejected: an `op` broker, because it reads plaintext into our process.
- D2. Use a static HTTPS callback page. 1Password rejects `localhost` redirects,
  and the `integration_key` arrives in the URL fragment, which servers never
  see.
  - The page forwards the query and fragment, still as a fragment, to
    `http://127.0.0.1:<port>/onepassword/callback` with `location.replace`.
  - A localhost page then posts them to the server.
  - The server checks `state` and exchanges the code using HTTP Basic auth and
    the PKCE verifier.
  - The static page holds no secrets. A leaked `code` is useless without the
    client secret and the verifier.
- D3. Resolve the tab ID inside the extension worker with
  `chrome.tabs.query({})`, matching the page URL. If more than one tab
  matches, set a unique temporary `document.title` over CDP, match on that,
  and then restore the title. Playwright doesn't expose Chrome tab IDs.
- D4. Keep a path-derived extension ID (R2, R3). Loading the stable ID would
  let the extension pair with Parker's desktop app and unlock the whole vault
  inside an automated browser.

## Known limits (these go in SKILL.md)

- Any process running as Parker, including the agent's Bash, can read the
  Keychain items that dev-browser creates. With the access token and the
  integration key, a program could request new grants, which still need
  approval, and could fill already-granted logins into any tab. Whether those
  values let a program decrypt granted logins outside the extension isn't
  documented. Assume they do, for grants already approved (30 days).
- The destination site's scripts see whatever was filled. 1Password accepts
  this risk too.
- The page lock covers MCP tools only. A script that uses `client.ts` directly
  could read the page during a fill.
- The feature depends on a partner-preview API and a 1Password server flag.
  Either can change without notice.
- Loading the extension changes the browser's fingerprint and adds 1Password
  telemetry hosts. That's one reason it's off by default.

## Phase 0 (Parker, before T3)

1. Get access to a 1Password Business account where you can register an OAuth
   client (Integrations > OAuth Application). The partner docs say the option
   may need a 1Password contact to turn it on. The firm's account is probably
   the wrong place for it.
2. Confirm your personal account is an Individual or Families account in the US
   region. Business accounts don't get the consent screen.
3. Choose the callback host. I recommend a GitHub Pages page in a public repo.
4. Check whether using the partner preview outside Browserbase needs an
   agreement with 1Password.

## Tasks

- T1 (R1–R3, R12, A2). Download and verify the CRX, add the opt-in launch
  flags (merged into the single `--disable-features` switch), keep the worker
  alive, and probe its state. This needs no 1Password account.
- T2 (R4–R9, R11, A1). Build the fake extension fixture, the broker (worker
  calls, polling, tab resolution), the page lock, network redaction, and the
  MCP tools. Tests run against the fixture.
- T3 (R10). Build the OAuth `connect` and `disconnect` CLI, Keychain storage,
  refresh handling, and the callback page. Needs Phase 0.
- T4 (A3). Run the live acceptance test with Parker, then update `SKILL.md`,
  `AGENTS.md`, and the MCP tool docs.

## Open questions

- Q1. Does the extension in dev-browser try to link to the desktop app over the
  loopback relay that 1Password's Claude security doc describes? T1 answers this.
- Q2. Can tokens plus the integration key decrypt granted logins outside the
  extension? This affects the threat model. 1Password's docs don't say.
- Q3. Will the server flag stay on for unpacked copies? On Linux, the
  managed-policy fallback is `/etc/chromium/policies/managed/*.json`. macOS has
  no fallback without MDM.
