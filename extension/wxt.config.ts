import { defineConfig } from "wxt";

export default defineConfig({
  manifest: ({ browser }) => ({
    name: "dev-browser",
    description: "Connect your browser to dev-browser for Playwright automation",
    permissions: ["debugger", "tabGroups", "storage", "alarms", "downloads", ...(browser === "chrome" ? ["nativeMessaging" as const] : [])],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  }),
});
