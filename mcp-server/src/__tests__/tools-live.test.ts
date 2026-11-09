/**
 * Drives the MCP tools against a real standalone server (headless Chromium)
 * on private ports, so each tool's options are checked end to end.
 */

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

process.env.DEV_BROWSER_DIR = mkdtempSync(join(tmpdir(), "dev-browser-mcp-live-"));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serve, type DevBrowserServer } from "../../../skills/dev-browser/src/index.js";
import { connect, type DevBrowserClient } from "../../../skills/dev-browser/src/client.js";
import { loadToken } from "../../../skills/dev-browser/src/auth.js";
import { buildServer, createState } from "../server.js";
import { PreviewManager } from "../preview.js";

const port = 21000 + Math.floor(Math.random() * 4000);

const FORM = `<!doctype html><title>Form</title>
<label>Name <input id="name"></label>
<select id="size"><option value="s">Small</option><option value="l">Large</option></select>
<label><input type="checkbox" id="agree"> Agree</label>
<input type="file" id="upload" aria-label="Upload">
<button>Send</button>
<div id="drop" style="position:absolute;left:0;top:300px;width:200px;height:100px;background:#eee">Drop here</div>
<script>
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    drop.dataset.got = f.name + ":" + f.size + ":" + f.type;
  });
</script>
<script>console.error("boom"); console.log("fine"); fetch("/data.json");</script>`;

let server: DevBrowserServer;
let browserClient: DevBrowserClient;
let site: Server;
let origin = "";
let mcp: Client;
let previews: PreviewManager;

type Content = Array<{ type: string; text?: string; data?: string }>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await mcp.callTool({ name, arguments: { page: "live", ...args } });
  const text = (result.content as Content).map((c) => c.text ?? "[image]").join("\n");
  if (result.isError) throw new Error(text);
  return text;
}

const js = async (code: string): Promise<unknown> => JSON.parse(await call("javascript", { code: `JSON.stringify(${code})` }));

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === "/unsaved") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<title>Draft</title><textarea id=draft></textarea>" +
          "<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>"
      );
      return;
    }
    if (req.url === "/data.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"answer":42}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FORM);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  server = await serve({
    port,
    cdpPort: port + 4000,
    headless: true,
    profileDir: mkdtempSync(join(tmpdir(), "dev-browser-mcp-live-profile-")),
  });
  browserClient = await connect(`http://127.0.0.1:${port}`, { session: "mcp-live", token: loadToken()! });
  const state = createState({ mode: "standalone", session: "mcp-live" });
  state.clients.set("standalone", browserClient);
  const project = mkdtempSync(join(tmpdir(), "dev-browser-mcp-live-project-"));
  mkdirSync(join(project, ".claude"));
  const appPort = port + 2;
  writeFileSync(
    join(project, ".claude", "launch.json"),
    JSON.stringify({
      configurations: [
        {
          name: "app",
          runtimeExecutable: process.execPath,
          runtimeArgs: ["-e", `require("http").createServer((q, r) => r.end("<title>Dev app</title>")).listen(${appPort})`],
          port: appPort,
        },
      ],
    })
  );
  state.previews = new PreviewManager(project);
  previews = state.previews;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(state).connect(serverTransport);
  mcp = new Client({ name: "live-test", version: "0.0.1" });
  await mcp.connect(clientTransport);
  await call("navigate", { url: `${origin}/form` });
}, 60000); // Launching Chromium can pass the 10 s default while other test files run

afterAll(async () => {
  for (const s of previews?.list() ?? []) await previews.stop(s.id);
  await browserClient?.disconnect();
  await server?.stop();
  site?.close();
});

const refFor = async (pattern: RegExp): Promise<string> => {
  const snapshot = await call("read_page", { filter: "interactive" });
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  if (!line) throw new Error(`No line matching ${pattern} in:\n${snapshot}`);
  return /\[ref=(e\d+)\]/.exec(line)![1]!;
};

describe("MCP tools on a live standalone browser", () => {
  test("read_page lists interactive elements and one subtree", async () => {
    const interactive = await call("read_page", { filter: "interactive" });
    expect(interactive).toMatch(/textbox "Name"/);
    expect(interactive).toMatch(/button "Send"/);
    expect(interactive).not.toMatch(/generic/);
    const ref = await refFor(/button "Send"/);
    expect(await call("read_page", { ref_id: ref })).toMatch(/^- button "Send"/);
  });

  test("form_input sets text, select, and checkbox by ref", async () => {
    await call("form_input", { ref: await refFor(/textbox "Name"/), value: "Ada" });
    await call("form_input", { ref: await refFor(/combobox/), value: "Large" });
    await call("form_input", { ref: await refFor(/checkbox "Agree"/), value: true });
    expect(
      await js(`[document.querySelector("#name").value, document.querySelector("#size").value, document.querySelector("#agree").checked]`)
    ).toEqual(["Ada", "l", true]);
  });

  test("file_upload sets files by ref", async () => {
    await call("file_upload", { ref: await refFor(/button "Upload"/), files: [join(process.cwd(), "package.json")] });
    expect(await js(`document.querySelector("#upload").files[0].name`)).toBe("package.json");
  });

  test("resize_window emulates a phone, dark mode, and returns to desktop", async () => {
    await call("resize_window", { preset: "mobile", color_scheme: "dark" });
    const phone = (await js(
      `[navigator.maxTouchPoints, /Android/.test(navigator.userAgent), matchMedia("(prefers-color-scheme: dark)").matches, screen.width]`
    )) as unknown[];
    expect(phone).toEqual([5, true, true, 375]);
    await call("resize_window", { preset: "desktop" });
    const desktop = (await js(`[navigator.maxTouchPoints, /Android/.test(navigator.userAgent), innerWidth, innerHeight]`)) as unknown[];
    expect(desktop).toEqual([0, false, 1440, 900]);
  });

  test("read_console_messages filters to errors", async () => {
    await call("navigate", { url: `${origin}/form` });
    const { messages } = JSON.parse(await call("read_console_messages", { only_errors: true }));
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["boom"]);
  });

  test("read_network_requests returns a response body by id", async () => {
    let requests: Array<{ id: number; url: string }> = [];
    for (let i = 0; i < 20 && !requests.some((r) => r.url.endsWith("/data.json")); i++) {
      requests = JSON.parse(await call("read_network_requests", { pattern: "data\\.json" })).requests;
      await new Promise((r) => setTimeout(r, 250));
    }
    const id = requests.find((r) => r.url.endsWith("/data.json"))!.id;
    const detail = JSON.parse(await call("read_network_requests", { request_id: id }));
    expect(detail).toMatchObject({ status: 200, body: '{"answer":42}' });
  });

  test("preview_start runs a launch.json server and opens it", async () => {
    const started = JSON.parse(await call("preview_start", { name: "app", page: "dev" }));
    expect(started).toMatchObject({ title: "Dev app", server: { name: "app", status: "running" } });
    expect(JSON.parse(await call("preview_list"))).toHaveLength(1);
    await call("preview_stop", { server_id: started.server.id });
    expect(JSON.parse(await call("preview_list"))).toEqual([]);
  });

  test("upload_image sets a file input by ref and drops on a zone", async () => {
    await call("navigate", { url: `${origin}/form` });
    const image = join(process.cwd(), "..", "assets", "header.png");
    const size = statSync(image).size;
    await call("upload_image", { path: image, ref: await refFor(/button "Upload"/), filename: "shot.png" });
    expect(await js(`document.querySelector("#upload").files[0].name`)).toBe("shot.png");
    await call("upload_image", { path: image, coordinate: [100, 350] });
    expect(await js(`document.querySelector("#drop").dataset.got`)).toBe(`header.png:${size}:image/png`);
  });

  test("gif_creator records actions and exports a GIF", async () => {
    await call("gif_creator", { action: "start_recording" });
    await call("computer", { action: "left_click", coordinate: [100, 350] });
    await call("computer", { action: "left_click_drag", start_coordinate: [50, 50], coordinate: [300, 120] });
    await call("navigate", { url: `${origin}/form` });
    expect(JSON.parse(await call("gif_creator", { action: "stop_recording" })).frames).toBe(5);
    const path = join(process.env.DEV_BROWSER_DIR!, "out.gif");
    const exported = JSON.parse(await call("gif_creator", { action: "export", path }));
    expect(exported).toMatchObject({ path, frames: 5 });
    expect(readFileSync(path).subarray(0, 6).toString()).toBe("GIF89a");
    await call("gif_creator", { action: "clear" });
    await expect(call("gif_creator", { action: "export" })).rejects.toThrow(/No frames/);
  });

  test("navigate keeps a page with unsaved changes unless forced", async () => {
    await call("navigate", { url: `${origin}/unsaved`, page: "draft" });
    // A real keystroke gives the page the user activation that arms the dialog
    await call("computer", { action: "left_click", ref: await refFor(/textbox/), page: "draft" }).catch(() => {});
    await call("computer", { action: "type", text: "notes", page: "draft" });
    await expect(call("navigate", { url: `${origin}/form`, page: "draft" })).rejects.toThrow(/unsaved changes/);
    expect(JSON.parse(await call("javascript", { code: "JSON.stringify(location.pathname)", page: "draft" }))).toBe(
      "/unsaved"
    );
    const forced = JSON.parse(await call("navigate", { url: `${origin}/form`, page: "draft", force: true }));
    expect(forced).toMatchObject({ discardedUnsavedChanges: true });
    expect(forced.url).toBe(`${origin}/form`);
    await call("tabs_close", { page: "draft" });
  });

  test("tabs_select and scaled screenshots work", async () => {
    await call("tabs_create", { page: "other" });
    await expect(call("tabs_select", { page: "live" })).resolves.toContain("success");
    const result = await mcp.callTool({ name: "screenshot", arguments: { page: "live", scale: 0.5 } });
    const png = Buffer.from((result.content as Content).find((c) => c.type === "image")!.data!, "base64");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([720, 450]);
    const zoom = await mcp.callTool({
      name: "computer",
      arguments: { page: "live", action: "zoom", region: [0, 0, 200, 100] },
    });
    expect((zoom.content as Content).find((c) => c.type === "text")!.text).toContain("at 4x");
  });
});
