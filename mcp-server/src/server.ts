/**
 * dev-browser MCP server — model-facing tools over the dev-browser client.
 *
 * Mirrors the vendor web-browser-use tool surface (tabs_context, navigate,
 * read_page, get_page_text, find, form_input, browser_batch, javascript,
 * screenshot, resize_window, file_upload, tabs_create, tabs_close,
 * read_console_messages, read_network_requests, switch_browser,
 * list_connected_browsers) as thin wrappers around the script API in
 * skills/dev-browser/src/client.ts. The client stays the engine.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  connect,
  CDPPage,
  detectChallenge,
  type DevBrowserClient,
  type BatchOp,
} from "../../skills/dev-browser/src/client.js";
import { authHeaders, devBrowserDir } from "../../skills/dev-browser/src/auth.js";
import {
  COMPUTER_ACTIONS,
  computerAction,
  type ComputerInput,
} from "../../skills/dev-browser/src/computer.js";

export type BrowserMode = "standalone" | "extension";

const PORTS: Record<BrowserMode, number> = { standalone: 9222, extension: 9224 };
const DEFAULT_PAGE = "main";

export interface ServerOptions {
  /** Force a mode; default probes extension (9224) then standalone (9222). */
  mode?: BrowserMode;
  /** Agent session id; default CLAUDE_SESSION_ID or a generated id. */
  session?: string;
}

export interface BrowserState {
  forcedMode?: BrowserMode;
  activeMode?: BrowserMode;
  session: string;
  clients: Map<BrowserMode, DevBrowserClient>;
}

export function createState(options: ServerOptions = {}): BrowserState {
  return {
    forcedMode: options.mode,
    session:
      options.session ??
      process.env.CLAUDE_SESSION_ID ??
      `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clients: new Map(),
  };
}

/** Probe a dev-browser server's /health with a short timeout. */
async function probeHealth(
  mode: BrowserMode
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS[mode]}/health`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMode(state: BrowserState): Promise<BrowserMode> {
  if (state.forcedMode) return state.forcedMode;
  if (state.activeMode) return state.activeMode;
  const ext = await probeHealth("extension");
  if (ext && ext.extensionConnected) {
    state.activeMode = "extension";
    return "extension";
  }
  const standalone = await probeHealth("standalone");
  if (standalone) {
    state.activeMode = "standalone";
    return "standalone";
  }
  if (ext) {
    // Relay up but extension not connected — still usable for info, but
    // page operations will fail with a clear message from the relay.
    state.activeMode = "extension";
    return "extension";
  }
  throw new Error(
    "No dev-browser server is running. Start one with `dev-browser serve` " +
      "(standalone Chromium on :9222) or `dev-browser relay` (Chrome " +
      "extension mode on :9224)."
  );
}

async function getClient(state: BrowserState): Promise<DevBrowserClient> {
  const mode = await resolveMode(state);
  let client = state.clients.get(mode);
  if (!client) {
    client = await connect({ mode, session: state.session });
    state.clients.set(mode, client);
  }
  return client;
}

// ---- Content helpers ----

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

function textResult(value: unknown): ToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Return a PNG to the model and keep a copy under ~/.dev-browser/screenshots. */
function imageResult(page: string, buffer: Buffer, message?: string): ToolResult {
  const dir = join(devBrowserDir(), "screenshots");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${page}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  writeFileSync(path, buffer);
  return {
    content: [
      { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
      { type: "text", text: [message, `Saved to ${path}`].filter(Boolean).join("\n") },
    ],
  };
}

/**
 * Run code with REPL semantics. page.evaluate() rejects top-level await in both
 * modes, so this goes through CDP, where replMode allows it.
 */
async function evaluateRepl(
  client: DevBrowserClient,
  page: string,
  code: string
): Promise<unknown> {
  const { results } = await client.batch(page, [
    {
      method: "Runtime.evaluate",
      params: { expression: code, returnByValue: true, awaitPromise: true, replMode: true },
    },
  ]);
  const { result, error } = results[0]!;
  if (error) throw new Error(error);
  const { result: remote, exceptionDetails } = result as {
    result: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return remote.value;
}

/** Whether a navigate target already names its scheme (data:, about:blank, https://...). */
function hasScheme(url: string): boolean {
  return url.includes("://") || /^(data|about|blob|javascript|file|chrome):/i.test(url);
}

function errorResult(err: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

/** Wrap a handler with uniform error reporting. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const pageParam = z
  .string()
  .optional()
  .describe(`Named page/tab to act on (default: "${DEFAULT_PAGE}")`);

export function buildServer(state: BrowserState): McpServer {
  const server = new McpServer({ name: "dev-browser", version: "0.0.1" });

  // Internal dispatch used by browser_batch
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();

  function tool(
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>
  ): void {
    const wrapped = safe(handler);
    handlers.set(name, wrapped);
    server.tool(name, description, shape, wrapped as never);
  }

  const pageName = (args: Record<string, unknown>): string =>
    typeof args.page === "string" && args.page.length > 0
      ? args.page
      : DEFAULT_PAGE;

  // --------------------------------------------------------------------
  // Tools
  // --------------------------------------------------------------------

  tool(
    "tabs_context",
    "List the current browser context: mode, named pages in this session, and every open browser tab.",
    {},
    async () => {
      const client = await getClient(state);
      const [info, pages, targets] = await Promise.all([
        client.getServerInfo(),
        client.list(),
        client.allTargets().catch(() => []),
      ]);
      return textResult({
        mode: info.mode,
        extensionConnected: info.extensionConnected,
        session: state.session,
        namedPages: pages,
        allTabs: targets,
      });
    }
  );

  tool(
    "navigate",
    "Navigate a named page to a URL (creates the page if needed). Also accepts \"back\" and \"forward\". Reports a bot challenge or block page (Cloudflare, DataDome, captcha, short 403) when it detects one.",
    {
      url: z.string().describe('URL to open, or "back" / "forward"'),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(pageName(args));
      const url = String(args.url);
      let response = null;
      if (url === "back") await p.goBack();
      else if (url === "forward") await p.goForward();
      else response = await p.goto(hasScheme(url) ? url : `https://${url}`);
      const challenge = await detectChallenge(p, response).catch(() => null);
      return textResult({ url: p.url(), title: await p.title(), ...(challenge ? { challenge } : {}) });
    }
  );

  tool(
    "read_page",
    "Read the page as an ARIA accessibility snapshot with interaction refs like [ref=e12]. Prefer this over screenshots for text and structure.",
    { page: pageParam },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      return textResult(await client.getAISnapshot(pageName(args)));
    }
  );

  tool(
    "get_page_text",
    "Extract the page's visible text (or Markdown with format=\"markdown\").",
    {
      page: pageParam,
      format: z.enum(["text", "markdown"]).optional().describe("Default: text"),
      max_chars: z.number().optional().describe("Truncate output (default 50000)"),
    },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      const raw =
        args.format === "markdown"
          ? await client.markdown(pageName(args))
          : await client.text(pageName(args));
      const maxChars = typeof args.max_chars === "number" ? args.max_chars : 50000;
      return textResult(
        raw.length > maxChars
          ? `${raw.slice(0, maxChars)}\n\n[truncated: ${raw.length} chars total]`
          : raw
      );
    }
  );

  tool(
    "find",
    "Find elements whose accessibility-tree line contains the query (case-insensitive). Returns up to 20 matches with refs for ref_action.",
    {
      query: z.string().describe("Text to look for in role/name/text"),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      return textResult(await client.find(pageName(args), String(args.query)));
    }
  );

  tool(
    "ref_action",
    "Click or fill an element by its ref from read_page/find (e.g. \"e12\").",
    {
      action: z.enum(["click", "fill"]),
      ref: z.string().describe("Ref id like e12"),
      value: z.string().optional().describe("Value for fill"),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(pageName(args));
      const ref = String(args.ref);
      if (p instanceof CDPPage || "clickRef" in p) {
        const cdpPage = p as unknown as CDPPage;
        if (args.action === "click") await cdpPage.clickRef(ref);
        else await cdpPage.fillRef(ref, String(args.value ?? ""));
      } else {
        const el = await client.selectSnapshotRef(pageName(args), ref);
        if (!el) throw new Error(`Ref "${ref}" not found — call read_page first`);
        if (args.action === "click") await el.click();
        else await el.fill(String(args.value ?? ""));
      }
      return textResult({ success: true, action: args.action, ref });
    }
  );

  tool(
    "form_input",
    "Fill several form fields in one call: a map of CSS selector to value.",
    {
      fields: z.record(z.string()).describe('{"#email": "x@y.com", ...}'),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      await client.fillForm(
        pageName(args),
        args.fields as Record<string, string>
      );
      return textResult({ success: true, filled: Object.keys(args.fields as object) });
    }
  );

  tool(
    "javascript",
    "Execute JavaScript in the page and return the result (REPL semantics: the last expression's value is returned; top-level await works).",
    {
      code: z.string(),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      const name = pageName(args);
      await client.page(name);
      const result = await evaluateRepl(client, name, String(args.code));
      return textResult(result === undefined ? "undefined" : result);
    }
  );

  tool(
    "screenshot",
    "Take a screenshot of the page. Returns the image and saves a PNG under ~/.dev-browser/screenshots.",
    {
      page: pageParam,
      full_page: z.boolean().optional().describe("Capture the full scrollable page"),
    },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(pageName(args));
      const buffer = await p.screenshot({ fullPage: args.full_page === true });
      return imageResult(pageName(args), buffer);
    }
  );

  tool(
    "computer",
    "Use the mouse and keyboard on the page, or look at it. Coordinates are viewport " +
      "pixels and match this tool's screenshots. Click actions and hover take `coordinate` " +
      "or a `ref` from read_page/find.",
    {
      action: z.enum(COMPUTER_ACTIONS),
      coordinate: z.array(z.number()).optional().describe("[x, y] target"),
      ref: z.string().optional().describe("Ref id like e12; required for scroll_to"),
      start_coordinate: z
        .array(z.number())
        .optional()
        .describe("[x, y] drag start for left_click_drag"),
      text: z
        .string()
        .optional()
        .describe('Text for type; space-separated keys for key, e.g. "cmd+a Backspace"'),
      repeat: z.number().optional().describe("Times to repeat the keys for key (1-100)"),
      modifiers: z
        .string()
        .optional()
        .describe('Keys held during a click, e.g. "shift" or "cmd+shift"'),
      scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
      scroll_amount: z.number().optional().describe("Wheel ticks for scroll (default 3)"),
      duration: z.number().optional().describe("Seconds for wait (0-10)"),
      region: z
        .array(z.number())
        .optional()
        .describe("[x0, y0, x1, y1] viewport region for zoom"),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(pageName(args));
      const { message, image } = await computerAction(p, args as unknown as ComputerInput);
      return image ? imageResult(pageName(args), image, message) : textResult(message);
    }
  );

  tool(
    "resize_window",
    "Set the page viewport size.",
    {
      width: z.number(),
      height: z.number(),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(pageName(args));
      await p.setViewportSize({
        width: Number(args.width),
        height: Number(args.height),
      });
      return textResult({ success: true, width: args.width, height: args.height });
    }
  );

  tool(
    "file_upload",
    "Set the files of a file input element (absolute paths on this machine).",
    {
      selector: z.string().describe("CSS selector of the <input type=file>"),
      files: z.array(z.string()).describe("Absolute file paths"),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(pageName(args));
      await p.setInputFiles(String(args.selector), args.files as string[]);
      return textResult({ success: true, files: args.files });
    }
  );

  tool(
    "tabs_create",
    "Create (or get) a named page/tab.",
    { page: z.string().describe("Name for the new page") },
    async (args) => {
      const client = await getClient(state);
      const p = await client.page(String(args.page));
      return textResult({ success: true, page: args.page, url: p.url() });
    }
  );

  tool(
    "tabs_close",
    "Close a named page/tab.",
    { page: z.string() },
    async (args) => {
      const client = await getClient(state);
      await client.close(String(args.page));
      return textResult({ success: true, closed: args.page });
    }
  );

  tool(
    "read_console_messages",
    "Read console output (console API calls, exceptions, browser log) captured for a page. pattern is a regex on the message text. In standalone mode, console API capture starts on the first call (earlier messages are replayed) and is detectable by bot checks from then on.",
    {
      page: pageParam,
      pattern: z.string().optional(),
      since: z.number().optional().describe("Previous `total` for incremental reads"),
    },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      return textResult(
        await client.getConsoleMessages(pageName(args), {
          pattern: args.pattern as string | undefined,
          since: args.since as number | undefined,
        })
      );
    }
  );

  tool(
    "read_network_requests",
    "Live network log for a page (method, URL, status). pattern is a regex on the URL.",
    {
      page: pageParam,
      pattern: z.string().optional(),
      since: z.number().optional().describe("Previous `total` for incremental reads"),
    },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      return textResult(
        await client.getNetworkRequests(pageName(args), {
          pattern: args.pattern as string | undefined,
          since: args.since as number | undefined,
        })
      );
    }
  );

  tool(
    "browser_batch",
    "Execute several of this server's tools sequentially in one call. Stops on the first error. Each action is {tool, input}.",
    {
      actions: z
        .array(
          z.object({
            tool: z.string(),
            input: z.record(z.unknown()).optional(),
          })
        )
        .describe("Tool calls to run in order"),
    },
    async (args) => {
      const actions = args.actions as Array<{
        tool: string;
        input?: Record<string, unknown>;
      }>;
      const results: Array<{ tool: string; result?: unknown; error?: string }> = [];
      const images: ToolResult["content"] = [];
      for (const action of actions) {
        if (action.tool === "browser_batch") {
          results.push({ tool: action.tool, error: "browser_batch cannot be nested" });
          break;
        }
        const handler = handlers.get(action.tool);
        if (!handler) {
          results.push({ tool: action.tool, error: `Unknown tool: ${action.tool}` });
          break;
        }
        const result = await handler(action.input ?? {});
        images.push(...result.content.filter((c) => c.type === "image"));
        const text = result.content
          .map((c) => (c.type === "text" ? c.text : "[image]"))
          .join("\n");
        if (result.isError) {
          results.push({ tool: action.tool, error: text });
          break;
        }
        results.push({ tool: action.tool, result: text });
      }
      return { content: [...textResult(results).content, ...images] };
    }
  );

  tool(
    "cdp_batch",
    "Execute several raw CDP commands against a page in one round trip. Each op is {method, params}. Stops on the first error.",
    {
      ops: z.array(
        z.object({
          method: z.string(),
          params: z.record(z.unknown()).optional(),
        })
      ),
      page: pageParam,
    },
    async (args) => {
      const client = await getClient(state);
      await client.page(pageName(args));
      return textResult(
        await client.batch(pageName(args), args.ops as BatchOp[])
      );
    }
  );

  tool(
    "switch_browser",
    "Switch between the standalone Chromium server (:9222) and the Chrome extension relay (:9224).",
    { mode: z.enum(["standalone", "extension"]) },
    async (args) => {
      const mode = args.mode as BrowserMode;
      const health = await probeHealth(mode);
      if (!health) {
        throw new Error(
          `No ${mode} server reachable on :${PORTS[mode]}. Start it with ` +
            `\`dev-browser ${mode === "extension" ? "relay" : "serve"}\`.`
        );
      }
      state.forcedMode = mode;
      state.activeMode = mode;
      return textResult({ success: true, mode, health });
    }
  );

  tool(
    "list_connected_browsers",
    "List reachable dev-browser servers and their status.",
    {},
    async () => {
      const [standalone, extension] = await Promise.all([
        probeHealth("standalone"),
        probeHealth("extension"),
      ]);
      return textResult({
        active: state.activeMode ?? state.forcedMode ?? null,
        standalone: standalone ?? "not running",
        extension: extension ?? "not running",
      });
    }
  );

  return server;
}
