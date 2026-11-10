<p align="center">
  <img src="assets/header.png" alt="Dev Browser" width="100%">
</p>

<p align="center">
  <a href="https://github.com/parkerhancock/dev-browser/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/parkerhancock/dev-browser/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node.js 22 or later" src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg">
  <img alt="Claude Code and Codex" src="https://img.shields.io/badge/plugin-Claude%20Code%20%7C%20Codex-8A2BE2.svg">
</p>

# dev-browser

Browser automation for coding agents, with pages that stay open between steps.

dev-browser gives Claude Code and Codex a real browser to work in. An agent can open your app, click through a flow, read the page, check the console and network log, take a screenshot, and then come back on the next turn to the same page in the same state. Pages have names and persist across tool calls, scripts, and sessions, so the agent never re-navigates just to look again.

It drives a browser in one of two modes. Standalone mode launches its own Chromium, headless by default, for testing local apps and reading public sites. Extension mode drives your everyday Chrome through a small extension, for sites where you're already signed in.

## Highlights

- 27 MCP tools modeled on the browser tools built into Claude's apps: navigate, read the page, find elements, fill forms, click and type, screenshot, run JavaScript, read console and network logs, manage tabs, emulate phones and dark mode, record GIFs, and run your dev servers.
- Named pages that persist between steps, with a separate namespace for each agent session, so several agents can share one browser.
- A TypeScript library with a Playwright-compatible `Page` API, for multi-step scripts that run in one go.
- A standalone browser built on [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) with a launch recipe that removes the usual automation tells. Driving Google Chrome, it passes the [rebrowser bot detector](https://bot-detector.rebrowser.net).
- Detection of Cloudflare, DataDome, hCaptcha, Turnstile, and reCAPTCHA challenges on every navigation. dev-browser reports challenges to the agent and never solves them.
- One-shot fetching to Markdown, with a no-browser tier that uses Chrome's TLS fingerprint and falls back to the browser when a site blocks it.
- HAR recording on every page, and WACZ, HTML, and PDF archives in one call.
- A service mode: token-authenticated HTTP, CDP, and MCP on one port, with a Dockerfile.

## Quick start

You need Claude Code or Codex, Node.js 22 or later, and macOS or Linux.

1. Install the plugin.

   In Claude Code:

   ```
   /plugin marketplace add parkerhancock/dev-browser
   /plugin install dev-browser@dev-browser
   ```

   In Codex:

   ```bash
   codex plugin marketplace add parkerhancock/dev-browser
   codex plugin add dev-browser@dev-browser
   ```

2. Run setup once per machine. In Claude Code, run `/dev-browser:setup`. In Codex, dev-browser's tools answer with the exact setup command until you've run it (`node <plugin folder>/scripts/setup.mjs`). Setup installs the runtime into `~/.dev-browser`, downloads the browser, and asks whether to start dev-browser when you log in. It takes a minute or two.

3. Ask for something.

   > Open localhost:3000, sign up with a test account, and tell me what breaks.

   > Screenshot the pricing page as a phone in dark mode.

   > Fetch https://example.com/docs/auth and summarize the token flow.

The browser starts the first time a tool needs it. After a plugin update, Claude Code reruns setup in the background; in Codex, run setup again.

## How it works

```mermaid
flowchart LR
  agent["Claude Code or Codex"] -->|stdio MCP| shim["mcp-shim.mjs<br/>(in the plugin)"]
  shim -->|HTTP + token| host["MCP host<br/>:9225"]
  host --> serve["Standalone server :9222<br/>patchright Chromium"]
  host --> relay["Extension relay<br/>:9224"]
  relay -->|WebSocket| ext["Extension in<br/>your Chrome"]
  scripts["Your scripts<br/>(TypeScript library)"] --> serve
  scripts --> relay
```

The plugin itself is light: a skill, a fetch agent, a setup command, and a shim with no dependencies that the agent's host starts as its MCP server. The shim forwards everything to the MCP host, a long-running process that setup installs. The MCP host owns the browser connections and starts the standalone server the first time a tool needs it.

Because the MCP host and the browsers outlive any one agent session, pages persist. In Claude Code, each session gets its own namespace for page names, keyed by the session ID, so two agents can both have a page called `main` without colliding. To share pages between agents, connect with the same explicit session name.

## Standalone and extension modes

Standalone mode is the default. dev-browser launches Chromium (or Chrome or Edge, with `--browser`) with a persistent profile in `~/.dev-browser`, headless unless you ask for a window. Each page opens in its own window, so pages stay visible to their own scripts, and the browser reports a normal user agent, viewport, and pointer. Use it for local development, testing, and public sites.

Extension mode drives tabs in your everyday Chrome, with your cookies and sign-ins. Use it for sites behind a login.

1. Download `dev-browser-extension-<version>.zip` from the [latest release](https://github.com/parkerhancock/dev-browser/releases/latest).
2. Unzip it somewhere permanent.
3. In `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose the folder.
4. Click the dev-browser toolbar icon and switch it to **Active**.

The extension connects to the extension relay. Setup's login item starts the relay; without it, run `~/.dev-browser/bin/dev-browser start relay`. While the extension is connected, tools work in your Chrome, and `switch_browser` moves between the two modes mid-session.

## MCP tools

| Group                   | Tools                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Navigation and tabs     | `navigate` (also back, forward, and `force` past "Leave site?" dialogs), `tabs_context`, `tabs_create`, `tabs_select`, `tabs_close` |
| Reading                 | `read_page`, `find`, `get_page_text`, `screenshot`, `read_console_messages`, `read_network_requests`                                |
| Acting                  | `computer` (mouse, keyboard, zoom), `ref_action`, `form_input`, `file_upload`, `upload_image`, `javascript`                         |
| Batching                | `browser_batch`, `cdp_batch`                                                                                                        |
| Emulation and recording | `resize_window` (phone and tablet presets, dark mode), `gif_creator`                                                                |
| Dev servers             | `preview_start`, `preview_list`, `preview_logs`, `preview_stop` (from your project's `.claude/launch.json`)                         |
| Browsers                | `switch_browser`, `list_connected_browsers`                                                                                         |

`read_page` returns the page's accessibility tree with a ref for each element, and `ref_action`, `form_input`, `computer`, and the upload tools act on those refs.

## Scripting

For multi-step work, the agent (or you) writes a short TypeScript script against the library. The page survives the script, so the next one starts where this one stopped.

```typescript
import { connect, navigateTo } from "@/client.js";

const client = await connect(); // standalone; pass { mode: "extension" } for your Chrome
const page = await client.page("checkout"); // created on first use, reused after

await navigateTo(page, "http://localhost:3000/cart");
await page.getByRole("button", { name: "Checkout" }).click();
console.log(await page.locator("h1").textContent());

await client.disconnect(); // the page stays open for the next script
```

Run scripts from the installed runtime:

```bash
cd ~/.dev-browser/app/current/skills/dev-browser && npx tsx my-script.ts
```

`navigateTo` never throws on slow pages: it returns the HTTP status, any bot challenge, and a classified error (timeout, DNS, TLS, or connection). The client also offers accessibility snapshots, `find`, Markdown and text extraction, HAR entries, downloads, cookie and storage export, and `saveArchive()`, which bundles WACZ, rendered HTML, and a PDF into one zip. The [skill guide](skills/dev-browser/SKILL.md) documents the full API.

## Fetching pages

In Claude Code, the `dev-browser:webfetch` agent fetches a URL and answers questions about it. It runs a CLI you can also call directly:

```bash
cd ~/.dev-browser/app/current/skills/dev-browser
npx tsx scripts/fetch.ts https://example.com --engine=auto
```

With `--engine=auto`, it makes one fast HTTP request with Chrome's TLS fingerprint, and loads the page in the browser only when that request is blocked, fails, or returns an empty app shell. The main content prints to stdout as Markdown. The exit code is 0 when the page loaded, 1 when navigation failed, and 2 when a bot challenge is still showing. Other flags include `--format` (markdown, html, text, or json), `--fresh` for a throwaway profile, `--headed`, `--proxy`, `--screenshot`, `--wacz`, and `--mode=extension`.

## Command line

Setup installs the CLI at `~/.dev-browser/bin/dev-browser`. Add `~/.dev-browser/bin` to your `PATH` to call it as `dev-browser`.

```bash
dev-browser start [relay|serve|mcp]    # run in the background; safe to repeat (default: relay)
dev-browser stop [relay|serve|mcp]     # stop what start launched (default: all)
dev-browser restart [relay|serve|mcp]
dev-browser status [--json]

dev-browser serve [--headed] [--browser chrome|msedge] [--profile NAME] [--proxy URL] \
                  [--locale de-DE] [--timezone Europe/Berlin] [--host 0.0.0.0] [--mcp]
dev-browser relay [--mcp]
dev-browser mcp [--http PORT]
```

## Configuration

| Variable                                                                   | Default                                | Effect                                                                                  |
| -------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `DEV_BROWSER_DIR`                                                          | `~/.dev-browser`                       | Where the token, profiles, logs, and runtime live                                       |
| `DEV_BROWSER_SERVE_PORT`, `DEV_BROWSER_RELAY_PORT`, `DEV_BROWSER_MCP_PORT` | 9222, 9224, 9225                       | Ports for the standalone server, extension relay, and MCP host                          |
| `DEV_BROWSER_TOKEN`                                                        | the contents of `~/.dev-browser/token` | The shared token, for clients on another machine                                        |
| `DEV_BROWSER_PROXY`                                                        | none                                   | Proxy for the standalone browser (`http://user:pass@host:port` or `socks5://host:port`) |
| `DEV_BROWSER_DIALOG_POLICY`                                                | `dismiss`                              | How the relay answers JavaScript dialogs: `dismiss`, `accept`, or `ignore`              |
| `DEV_BROWSER_IDLE_TIMEOUT_MS`                                              | 60000                                  | How long the relay keeps an unnamed, idle tab before closing it                         |

An optional `~/.dev-browser/policy.json` limits navigation to listed domains and raw CDP to a safe set of methods; the [skill guide](skills/dev-browser/SKILL.md#security--policy) describes its fields.

To skip Claude Code's permission prompts for dev-browser's tools, add `"mcp__plugin_dev-browser_dev-browser"` to `permissions.allow` in `~/.claude/settings.json`.

## Security

- Every request to the standalone server, the extension relay, and the MCP host needs the token in `~/.dev-browser/token`, which is readable only by you. Requests that carry a web page's `Origin` are refused, so sites you visit can't drive your browser.
- The servers listen on 127.0.0.1. `serve --host 0.0.0.0` exposes the standalone server for containers, still behind the token.
- Chromium's own debug port stays on loopback. Remote clients reach the browser only through the server's authenticated `/cdp` proxy.
- Extension mode acts in your real, signed-in Chrome, so an agent there can do anything you could. A policy file can confine it to the domains you list.

## Running as a service

The Dockerfile runs the standalone server, its HTTP API, and MCP on one port, with the profile and token in a volume.

```bash
docker build -t dev-browser .
docker run -d -p 9222:9222 -v dev-browser-data:/data dev-browser
docker exec <container> cat /data/token
```

Connect the library with `connect("http://host:9222", { token })`, or add the MCP endpoint `http://host:9222/mcp` with the header `X-DevBrowser-Token: <token>`. The image drives Google Chrome by default; on Apple Silicon, build with `--build-arg BROWSER=chromium`, because Chrome has no Linux ARM64 build.

## Troubleshooting

If a tool says dev-browser isn't set up, run `/dev-browser:setup` in Claude Code, or the command the tool prints.

If setup stops with a Node.js version error, install Node 22 or later. dev-browser uses Node's built-in WebSocket, which older versions lack.

If extension mode fails on a login form with "Cannot access a chrome-extension:// URL of different extension", a password manager's inline menu is open in the page, and Chrome blocks dev-browser while another extension's frame is present. Close the menu, use standalone mode for that form, or, on pages you control, add `data-1p-ignore` to the field.

If a tool reports a bot challenge in standalone mode, try extension mode, which uses your real Chrome and its history with the site.

`dev-browser status` shows each server's state, and `~/.dev-browser` holds the logs: `relay.log`, `serve.log`, `mcp.log`, and `setup.log`.

## Development

```bash
git clone https://github.com/parkerhancock/dev-browser
cd dev-browser
(cd skills/dev-browser && npm ci) && (cd mcp-server && npm ci) && (cd extension && npm ci)
node scripts/setup.mjs --link .   # make this checkout the installed runtime
```

With `--link`, your edits take effect after `dev-browser restart mcp relay`.

| Path                                | Contents                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `skills/dev-browser/`               | The library, the standalone server, the extension relay, the fetch CLI, and the agent skill                |
| `mcp-server/`                       | The MCP tools, the MCP host, and the `dev-browser` CLI                                                     |
| `extension/`                        | The Chrome extension (WXT)                                                                                 |
| `scripts/setup.mjs`, `mcp-shim.mjs` | Setup and the plugin's MCP entry point, both free of dependencies                                          |
| `satchel.yaml`                      | Plugin packaging for Claude Code and Codex, built with [Satchel](https://github.com/parkerhancock/satchel) |

Each package runs its own checks: `npx tsc --noEmit` and `npm test` in `skills/dev-browser` and `mcp-server`, and `npm run test:run` in `extension`. After changing an MCP tool, regenerate the shim's tool list with `npm run snapshot-tools` in `mcp-server`. To release, bump `version` in `satchel.yaml`, regenerate the plugin files with Satchel, and push a matching `v<version>` tag; the release workflow attaches the extension zip. [AGENTS.md](AGENTS.md) maps the code in more detail, and [CONTRIBUTING.md](CONTRIBUTING.md) covers proposing changes.

## Acknowledgments

dev-browser began as [Sawyer Hood's dev-browser](https://github.com/SawyerHood/dev-browser), which introduced persistent named pages for agents. His [evaluation](https://github.com/SawyerHood/dev-browser-eval) found that design finished a reference task in 3m 53s for $0.88, against 4m 31s and $1.45 for Playwright MCP. This fork adds the patchright standalone engine, the MCP tools, the extension mode improvements, the fetch tiers, and the plugin packaging; it hasn't been re-measured.

[dev-terminal](https://github.com/parkerhancock/dev-terminal) applies the same persistent-session idea to terminals and TUIs.

## License

[MIT](LICENSE)
