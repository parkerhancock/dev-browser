# Plan: package dev-browser with Satchel

**Date:** 2026-11-09
**Status:** draft. Open questions Q1 to Q3 need Parker's answers before T2.
**Owner:** Parker

## Problem

dev-browser reaches agents through hand-made links into one checkout on one
Mac:

- **Skill:** `~/.claude/skills/dev-browser` is a symlink into the repo.
- **MCP server:** `~/.claude.json` runs `node …/mcp-server/bin/dev-browser.mjs mcp`.
- **webfetch agent:** `~/.claude/agents/webfetch.md` is a January copy that
  predates `--engine=auto`.
- **Hooks:** `hooks/hooks.json` isn't registered anywhere.
- **Extension:** loaded unpacked from `extension/.output/chrome-mv3`, which a
  fresh clone has to build. SKILL.md's download link points at upstream
  releases, which lack this fork's extension fixes.
- **Relay:** runs through `start.sh` and `stop.sh`, because the CLI has no
  background mode.
- **Plugin manifest:** `.claude-plugin/marketplace.json` still names the
  upstream author, and nothing installs from it.

Satchel (`tools/satchel`) generates plugin manifests and marketplaces for
Claude, Codex, and other hosts from one `satchel.yaml`, the way carrel and
patent-client-agents ship. It covers skills, agents, hooks, and MCP. It
doesn't install runtime dependencies, so dev-browser needs a bootstrap step,
following carrel's SessionStart `bootstrap-runtime` hook.

## Goals

- G1. One command per machine installs the skill, the webfetch agent, and the
  MCP server, and later updates them together.
- G2. The first use installs Node dependencies and patchright's Chromium with
  no manual step. Later sessions skip that work.
- G3. Development on this Mac stays live: edits in the checkout take effect
  without a release.
- G4. The extension has a download that matches the fork.

## Non-goals

- Publishing npm packages (rejected, D2).
- The npm-workspace and `exports` restructuring. The plugin keeps the repo
  layout, so the MCP server's relative imports keep working. It's cleanup for
  later, not a prerequisite.
- The Chrome Web Store.
- A hosted remote MCP service, so the ChatGPT and Anthropic targets are
  disabled as not applicable.
- The Docker image, which stays as it is.

## Requirements

- R1. The repo shall have a `satchel.yaml` that declares:
  - components: `./skills`, `./agents`, `./hooks/hooks.json`, `./.mcp.json`;
  - Claude and Codex targets, with marketplaces sourced from
    `parkerhancock/dev-browser`;
  - Copilot, Cowork, ChatGPT, Anthropic, Vibe, and Antigravity disabled, each
    with a `notApplicable` reason.

  `satchel check .` and `satchel smoke .` shall pass, and the generated
  manifests shall be committed as build outputs.

- R2. `scripts/bootstrap` shall:
  - run `npm ci` in `skills/dev-browser` and `mcp-server`;
  - run `npx patchright install chromium`;
  - create a stable link, `~/.dev-browser/app`, to the plugin root;
  - write a stamp keyed to the lockfiles' hash, so a later run with an
    unchanged stamp exits in under a second;
  - take a lock, so concurrent runs wait instead of installing twice.
- R3. The SessionStart hook shall run the bootstrap in the background with
  errors ignored, as carrel does.
- R4. The MCP config shall start the server through `scripts/run-mcp`, which
  runs the bootstrap first. This covers a session where the server starts
  before the hook finishes.
- R5. SKILL.md and `agents/webfetch.md` shall refer to `~/.dev-browser/app`
  instead of `~/.claude/skills/dev-browser`, so they work from a plugin
  install, a checkout, or Codex alike.
- R6. The CLI shall gain `dev-browser start [relay|serve]`, `stop`, and
  `status`. These are idempotent background starts, using the same pidfile and
  log locations as `start.sh`. The shell scripts and their doc references then
  go.
- R7. A CI job shall build the extension on version tags and attach
  `dev-browser-extension-<version>.zip` to the GitHub release. SKILL.md shall
  link to the fork's releases.
- R8. The plugin shall not ship `block-webfetch` (Q1) or `expose-session-id`
  (D3).

## Acceptance criteria

- A1 (R1). `satchel check . --release` and `satchel smoke .` pass, and
  `claude plugin validate .` passes.
- A2 (R2–R4). On a machine with no `node_modules`, installing the plugin and
  opening a session leaves the MCP tools working, from both the hook path and
  the run-mcp path. A second session's bootstrap exits immediately.
- A3 (R5). The webfetch agent and a SKILL.md script example run unchanged from
  a plugin install and from the checkout.
- A4 (R6). `dev-browser start relay` twice leaves one relay running.
  `dev-browser stop` stops it. `status` reports both servers.
- A5 (G3). On this Mac, with a local-directory marketplace pointing at the
  checkout, an edit to the MCP server shows up after restarting the session.
- A6 (R7). A tag push produces a release with the extension zip, and it loads
  unpacked in Chrome.

## Decisions

- D1. Use Satchel instead of hand-maintaining `.claude-plugin/`. It matches
  carrel and patent-client-agents and adds Codex for free.
- D2. Don't publish npm packages. There's one user, the `dev-browser` name may
  clash with upstream, and publishing is public. The plugin carries the source
  instead.
- D3. Drop `expose-session-id.sh`. Claude Code already sets
  `CLAUDE_SESSION_ID` in the Bash environment; it's set in this session with
  the hook unregistered.
- D4. Keep `node_modules` inside the plugin root, where the relative imports
  expect it. A plugin update replaces the root, and the stamp check reinstalls.
  Patchright's browsers live in the shared cache
  (`~/Library/Caches/ms-playwright`) and survive updates.

## Open questions

- Q1. Should the plugin block the built-in WebFetch and route fetches to the
  webfetch agent? The plan assumes no. Blocking applies to every session with
  the plugin enabled.
- Q2. Hard fork? Generating the marketplace under Parker's name makes it one in
  practice. The plan assumes yes, so upstream merges stop.
- Q3. Targets: Claude and Codex (assumed), or Claude only?
- Q4. Does Claude Code copy a local-directory marketplace plugin into its cache
  or use it in place? T5 answers this. If it copies, development uses the
  checkout's own MCP entry instead.
- Q5. Is the first-run `npm ci` (about a minute) within the MCP startup
  timeout? If not, `run-mcp` serves a stub that tells the user to retry, and
  the hook's background install finishes the job.
- Q6. Codex's variable for the plugin root in MCP configs and hooks. Satchel
  normalizes some of these; `satchel check --host` confirms.

## Tasks

- T1 (R6, A4). Add CLI `start`, `stop`, and `status`. Move the docs to them and
  remove `server.sh`, `start.sh`, and `stop.sh`. This is independent of
  Satchel and can go first.
- T2 (R1, R8, A1). Add `satchel.yaml`, the plugin hooks file, and `.mcp.json`.
  Generate and commit the outputs, replacing the upstream `marketplace.json`.
- T3 (R2–R4, A2). Write `scripts/bootstrap` and `scripts/run-mcp`, with a test
  that runs the bootstrap against a temporary copy of the repo.
- T4 (R5, A3). Repoint SKILL.md, AGENTS.md, and `agents/webfetch.md` to
  `~/.dev-browser/app`.
- T5 (A5). Install on this Mac from a local-directory marketplace, then retire
  the manual links: the skill symlink, the `~/.claude.json` entry, and the
  agent copy. Ask Parker before each removal.
- T6 (R7, A6). Add the release job for the extension zip and update the
  SKILL.md link.
- Checks for every task: `npx tsc --noEmit` and `npm test` in
  `skills/dev-browser` and `mcp-server`, `npm run test:run` in `extension`, and
  `satchel check .`.
