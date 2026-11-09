# Plan: package dev-browser with Satchel

**Date:** 2026-11-09 (rewritten after the research recorded below)
**Status:** approved by Parker on 2026-11-09, with Q1 to Q3 settled as the plan assumed (D6 to D8).
**Owner:** Parker

## Problem

dev-browser reaches agents through hand-made links into one checkout on one
Mac:

- **Skill:** a symlink at `~/.claude/skills/dev-browser`.
- **MCP server:** an entry in `~/.claude.json` that runs `mcp-server/bin/dev-browser.mjs`.
- **webfetch agent:** a stale January copy in `~/.claude/agents`.
- **Hooks:** none registered.
- **Extension:** loaded unpacked from a folder a fresh clone has to build.
- **Relay:** started by shell scripts.

Satchel (`tools/satchel`) generates Claude and Codex plugin manifests and
marketplaces from one `satchel.yaml`, but plugins can't install runtime
dependencies within the hosts' MCP startup limits:

- **Claude Code** waits 30 s (`MCP_TIMEOUT`) and doesn't retry a stdio server
  that misses it.
- **Codex** waits 10 s (`startup_timeout_sec`), and a plugin can't raise it.
- **Codex hooks** run only for plugins installed by hand in its desktop app,
  after the user trusts them.

dev-browser needs about a minute of `npm ci` plus a Chromium download on first
use. So the plugin ships only light files, and a one-time setup installs the
runtime outside any startup path. That's the pattern `gcp-enterprise-ocr`
already uses with its loopback MCP server.

## Design

1. **Plugin.** Satchel generates a plugin containing:
   - the skill;
   - the webfetch agent;
   - an MCP entry that runs `node ./mcp-shim.mjs`;
   - `scripts/setup.mjs`;
   - on Claude only, a SessionStart hook (R9).
2. **Shim.** `mcp-shim.mjs` uses Node built-ins only and starts in well under
   a second. It speaks MCP over stdio to the host and forwards each message to
   the local MCP host's `/mcp` endpoint, with the token from
   `~/.dev-browser/token`.
3. **Setup.** `node <plugin>/scripts/setup.mjs`, also dependency-free:
   - installs the runtime into `~/.dev-browser/app`;
   - runs `npm ci` and `npx patchright install chromium` there;
   - with permission, registers a login service that runs the MCP host and the
     extension relay.
4. **MCP host.** `dev-browser mcp --http`, hardened (R4). It starts the
   standalone browser server on demand (R5), and connects to the relay when the
   extension is in use.
5. **Scripts.** The skill and the agent run scripts from `~/.dev-browser/app`.

## Goals

- G1. One plugin install per host (Claude Code or Codex) plus one `setup` run
  per machine gives the skill, the webfetch agent, and the MCP tools.
- G2. No host waits on an install. A session started before setup gets tools
  that say exactly what to run.
- G3. Development on this Mac stays live: the runtime can point at the checkout.
- G4. Per-session page persistence works without any hook.
- G5. The extension has a download that matches the fork.

## Non-goals

- Publishing npm packages.
- The npm-workspace and `exports` restructuring. The runtime keeps the repo
  layout.
- The Chrome Web Store.
- A hosted remote MCP service, so the ChatGPT and Anthropic targets are
  disabled.
- Windows. Setup supports macOS (launchd) and Linux (systemd user units).

## Requirements

- R1. The repo shall have a `satchel.yaml` that declares:
  - components: `./skills`, `./agents`, `./commands`, `./.mcp.json`, and
    `./hooks/hooks.json` for Claude;
  - Claude and Codex targets, with marketplaces sourced from
    `parkerhancock/dev-browser`;
  - every other target disabled, each with a `notApplicable` reason.

  `satchel check .` and `satchel smoke .` shall pass, and the generated outputs
  shall be committed.

- R2. `.mcp.json` shall run `node -e` with a one-line loader that imports
  `mcp-shim.mjs` from `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, or the working
  directory. The command is a bare executable, as Codex requires, and no path
  depends on either host expanding a variable inside `args` or `cwd`. Verified
  under Claude Code with `--plugin-dir`; Codex is verified in T7.
- R3. `mcp-shim.mjs` shall:
  - use only Node built-ins;
  - relay stdio JSON-RPC to streamable HTTP, carrying the `Mcp-Session-Id`
    header and handling both JSON and SSE responses;
  - send `X-DevBrowser-Token`, and `X-DevBrowser-Session` from
    `CLAUDE_CODE_SESSION_ID` when it's set (G4);
  - read the endpoint from `DEV_BROWSER_MCP_URL` (default
    `http://127.0.0.1:9225/mcp`).

  If the host isn't running, the shim shall still complete the MCP handshake at
  once and list the tools from a bundled schema snapshot. When the runtime is
  installed, it starts the host in the background, and the first tool call
  waits for it (up to 45 s; tool calls aren't under the startup limit). When
  the runtime is missing, every call returns an error naming the exact setup
  command, including the plugin's own path.

- R4. `dev-browser mcp --http` shall bind loopback only, require the token on
  every request, and reject requests with an http(s) `Origin`, matching the
  relay. When a request carries `X-DevBrowser-Session`, that connection shall
  use that session instead of `mcp-<id>`.
- R5. When a tool needs standalone mode and no server answers on 9222, the MCP
  host shall start one headless, the way `scripts/fetch.ts` does today. That
  logic moves into the library and is reused. Extension mode keeps requiring
  the relay and the extension.
- R6. `scripts/setup.mjs` shall:
  1. copy the plugin's runtime files into `~/.dev-browser/app/<version>` and
     point `~/.dev-browser/app/current` at it; `--link <checkout>` points at a
     checkout instead (G3);
  2. run `npm ci` in `skills/dev-browser` and `mcp-server`, and
     `npx patchright install chromium`;
  3. write `~/.dev-browser/app/current/VERSION`;
  4. after confirmation, or with `--service`, install a launchd agent or systemd
     user unit that runs the MCP host on 9225 and the relay on 9224, and start
     it;
  5. print the result, and the Chrome extension download for extension mode.

  A second run at the same version does nothing but verify. `--uninstall` shall
  stop the MCP host, the relay, and the standalone server; remove the login
  service; and delete `~/.dev-browser/app`. It shall keep the token, browser
  profiles, and recordings in `~/.dev-browser` unless `--purge` is also given,
  and say what it kept.

- R7. The CLI shall gain `dev-browser start`, `stop`, `restart`, and `status` for
  the MCP host, the relay, and the standalone server. These are idempotent
  background starts using `~/.dev-browser/*.pid`. `server.sh`, `start.sh`, and
  `stop.sh` go, along with their doc references.
- R8. SKILL.md, AGENTS.md, and `agents/webfetch.md` shall run scripts from
  `~/.dev-browser/app/current`, and say to run setup when that's missing.
- R9. On Claude Code, a SessionStart hook shall compare the plugin's version with
  `VERSION` and, on a mismatch, start setup in the background without the
  service step. Errors are ignored. Codex users rerun setup by hand after
  updates.
- R10. The client shall use `CLAUDE_CODE_SESSION_ID` when `CLAUDE_SESSION_ID`
  isn't set. `expose-session-id.sh` and `inject-session-id.sh` go.
- R11. A CI job shall build the extension on version tags and attach
  `dev-browser-extension-<version>.zip` to the release. SKILL.md and setup's
  output shall link to the fork's releases.
- R12. The plugin shall not ship `block-webfetch` (D6).
- R13. The plugin shall include a `/dev-browser:setup` command that runs
  `scripts/setup.mjs` from the plugin's own root and passes through its
  arguments (`--service`, `--link`, `--uninstall`), so nobody has to find the
  plugin's install path. It ships for Claude, and for Codex if Satchel's Codex
  adapter supports commands; T4 checks. The shim's setup message (R3) names
  the command where the host has it, and the full `node` path otherwise.

## Acceptance criteria

- A1 (R1, R2). `satchel check . --release`, `satchel smoke .`, and
  `claude plugin validate .` pass.
- A2 (R3). Before setup, the plugin's tools appear in both hosts within their
  startup limits. A call returns the setup command.
- A3 (R3–R6). After setup on a machine with no prior install, `navigate` and
  `screenshot` work from Claude Code and from Codex. The standalone server
  starts on first use.
- A4 (R4). A request without the token gets 401. A request with
  `Origin: https://example.com` gets 403. Two sessions with different
  `CLAUDE_CODE_SESSION_ID` values keep separate pages, and the same ID across
  two connections shares them.
- A5 (R6). A second setup run at the same version finishes in under 2 s and
  changes nothing. `--link` makes edits to the checkout take effect after
  `dev-browser restart`.
- A6 (R7). `start` twice leaves one of each process, `stop` stops them, and
  `status` reports all three.
- A7 (R11). A tag push attaches the extension zip, and it loads unpacked.
- A8 (R6). After `--uninstall`, no dev-browser process or login service
  remains, `~/.dev-browser/app` is gone, and the token and profiles are still
  there. With `--purge`, `~/.dev-browser` is gone too.
- A9 (R13). In a fresh Claude Code session with only the plugin installed,
  `/dev-browser:setup` completes setup, and A3 then passes.
- Checks for every task: `npx tsc --noEmit` and `npm test` in
  `skills/dev-browser` and `mcp-server`, `npm run test:run` in `extension`, and
  `satchel check .`.

## Decisions

- D1. Use Satchel for manifests and marketplaces. It matches carrel,
  patent-client-agents, and gcp-enterprise-ocr, and adds Codex.
- D2. Don't publish npm packages. There's one user, the name may clash with
  upstream, and publishing is public.
- D3. Use a stdio shim over HTTP, not an HTTP MCP entry. Plugin MCP configs
  can't read the token file, and the shim can serve helpful errors before
  setup. Rejected: an unauthenticated loopback endpoint, which any web page
  could POST to.
- D4. Install the runtime in `~/.dev-browser/app`, not the plugin root. Plugin
  roots change on every update, and the Bash tool doesn't get the plugin-root
  variables, so skills need one stable path.
- D5. Use a login service for the MCP host and the relay. Both are light; the
  host starts the browser itself on demand. Without the service, the user runs
  `dev-browser start`.
- D6. The plugin doesn't block the built-in WebFetch (was Q1).
- D7. This is a hard fork of SawyerHood/dev-browser; the generated marketplace
  carries Parker's name, and upstream merges stop (was Q2).
- D8. Targets are Claude and Codex (was Q3).

## Research (2026-11-09)

- **Local-folder installs.**
  - Claude Code's docs say a relative-path plugin from a marketplace added by
    local path loads in place, with edits applied at the next session or
    `/reload-plugins`. `--plugin-dir` also loads in place, for one session.
  - On this Mac, though, `gcp-enterprise-ocr`, set up the same way, sits as a
    copy in `~/.claude/plugins/cache/.../0.5.1`, from September 2.
  - Codex copies local plugins to `~/.codex/plugins/cache/<mkt>/<plugin>/local/`
    and needs a restart to see edits.
  - D4 makes this matter less: the runtime, not the plugin copy, runs the code.
- **Startup timeouts.** Claude Code waits 30 s and doesn't retry a stdio server
  that misses it; you can reconnect from `/mcp`. Codex waits 10 s, and a plugin
  can't raise that.
- **Variables.**
  - Codex expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in MCP configs, gives
    hooks those names plus the `CLAUDE_` ones, and requires a stdio command to
    be a bare executable or a contained `./` path.
  - Claude Code expands `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in
    hooks, MCP configs, and skill and agent Markdown, but not in Bash.
  - Both hosts keep per-plugin data folders across updates.
- **Session IDs.** Claude Code sets `CLAUDE_CODE_SESSION_ID` natively in Bash,
  hook, and MCP subprocesses. `CLAUDE_SESSION_ID` on this Mac comes from the
  global `~/.claude/hooks/set-session-env.sh`. I haven't checked what Codex
  sets.
- **MCP host today.** `dev-browser mcp --http` has no token check. The MCP tools
  don't start a browser server on their own.

## Open questions

- Q4. Codex's session variable, if any, for R3's `X-DevBrowser-Session`. Without
  one, Codex sessions get a session per connection, which is today's HTTP
  behavior.
- Q5. Should setup install the login service by default, or only with
  `--service`? The plan asks interactively.

## Tasks

- T1 (R7, A6). CLI `start`, `stop`, `restart`, and `status`; retire the shell
  scripts. **Done 2026-11-09.**
- T2 (R4, R5, R10, A4). Harden `mcp --http`, honor `X-DevBrowser-Session`, add
  on-demand standalone start, and add the `CLAUDE_CODE_SESSION_ID` fallback. **Done 2026-11-09.**
- T3 (R3, A2). Write `mcp-shim.mjs` and a schema snapshot of the tools, with a
  test that the snapshot matches the live tool list. Test the shim against a
  running host and against none. **Done 2026-11-09.**
- T4 (R1, R2, R9, R12, R13, A1). Add `satchel.yaml`, `.mcp.json`, the Claude
  hook, and the setup command. Generate outputs, replacing the upstream
  `marketplace.json`. **Done 2026-11-09.** Notes:
  agents are left undeclared because Satchel 0.4.0 writes `"agents": "./agents/"`,
  which `claude plugin validate` rejects; Claude finds `agents/` by default. The
  Claude marketplace uses a GitHub source so `satchel check --release` passes.
  Because `.mcp.json` sits at the repo root, Claude Code also offers it as a
  project MCP server in this repo. No plugin icon yet (a validator warning).
- T5 (R6, R8, A3, A5, A8, A9). Write `scripts/setup.mjs`, including
  `--uninstall` and `--purge`, and the launchd and systemd service files.
  Repoint the docs and the agent to `~/.dev-browser/app/current`.
- T6 (R11, A7). Add the extension release job and fix the download links.
- T7. Move this Mac over:
  1. install the plugin in Claude Code and Codex;
  2. run setup with `--link` to the checkout;
  3. verify A3;
  4. retire the skill symlink, the `~/.claude.json` entry, the agent copy, and
     the running `start.sh` relay, asking Parker before each.
