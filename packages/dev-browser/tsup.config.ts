import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts", "src/dom/index.ts"],
  format: ["esm"],
  dts: true,
  // Disable keepNames to prevent __name helper injection
  // This is critical because extractDOMScript is passed to page.evaluate()
  // and the __name helper doesn't exist in the browser context
  keepNames: false,
});
