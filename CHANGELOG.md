# Changelog

## [2.0.0] - 2026-11-09

The first release of this fork. It installs as a plugin for Claude Code and
Codex, and needs Node.js 22 or later.

### Added

- Plugin packaging for Claude Code and Codex, built with Satchel, with a
  `/dev-browser:setup` command, a `dev-browser:webfetch` agent, and a
  SessionStart hook that updates the runtime after a plugin update.
- `scripts/setup.mjs`, which installs the runtime into `~/.dev-browser`,
  downloads the browser, and optionally adds a login item; also `--link`,
  `--update`, `--uninstall`, and `--purge`.
- A dependency-free MCP shim, and an MCP host that requires the token,
  rejects web origins, pins sessions by header, and starts the standalone
  browser on demand.
- 27 MCP tools modeled on Claude's built-in browser tools, including
  `computer`, `form_input` by ref, dev-server previews, GIF recording with
  overlays, image upload, device and dark-mode emulation, and forced
  navigation past "Leave site?" dialogs.
- `dev-browser start`, `stop`, `restart`, and `status` for running the
  servers in the background.
- Bot-challenge detection, a one-shot fetch to Markdown, and a no-browser
  HTTP tier with Chrome's TLS fingerprint.
- Proxy, locale, and time zone options for standalone servers.
- Token auth, an authenticated CDP proxy, MCP over HTTP, and a Dockerfile
  for running the standalone server as a service.
- A domain and CDP-method policy file, console capture, batched CDP calls,
  and download tracking in both modes.
- A release workflow that attaches the Chrome extension to version tags.

### Changed

- Standalone mode runs on patchright with a launch recipe that hides
  automation; driving Google Chrome, it passes the rebrowser bot detector.
- The library's client and the relay are split into modules by mode and by
  route group.

### Fixed

- Extension mode reattaches when Chrome drops the debugger from a tab that
  is still open, as happens when a password manager's inline menu appears.
- Input reaches background tabs in extension mode, and top-level `await`
  works in the MCP `javascript` tool.

### Removed

- The `server.sh`, `start.sh`, and `stop.sh` scripts, replaced by the CLI.
- The hook that blocked Claude Code's built-in WebFetch.

## [1.0.1] - 2025-12-10

### Added

- Support for headless mode

## [1.0.0] - 2025-12-10

### Added

- Initial release
