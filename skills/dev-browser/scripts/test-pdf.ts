#!/usr/bin/env npx tsx
/**
 * Test script for PDF generation in extension mode
 *
 * Prerequisites:
 * 1. Start the relay server: npm run start-relay
 * 2. Connect the Chrome extension
 * 3. Run this script: npx tsx scripts/test-pdf.ts
 */

import { connect } from "../src/client.js";
import { writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const serverUrl = process.env.DEV_BROWSER_URL || "http://localhost:9224";

  console.log(`Connecting to dev-browser at ${serverUrl}...`);

  const client = await connect(serverUrl, { session: "pdf-test" });

  console.log("Connected. Getting page...");

  const page = await client.page("pdf-test-page");

  console.log("Navigating to example.com...");
  await page.goto("https://example.com", { waitUntil: "networkidle" });

  console.log("Page loaded. Generating PDF...");

  const startTime = Date.now();
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
  });
  const elapsed = Date.now() - startTime;

  console.log(`PDF generated in ${elapsed}ms`);
  console.log(`PDF size: ${pdfBuffer.length} bytes (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

  // Save to disk
  const outputPath = join(process.cwd(), "test-output.pdf");
  writeFileSync(outputPath, pdfBuffer);
  console.log(`PDF saved to: ${outputPath}`);

  // Check stats endpoint
  const statsRes = await fetch(`${serverUrl}/stats`);
  const stats = await statsRes.json();
  console.log("\nServer stats:", JSON.stringify(stats, null, 2));

  await client.disconnect();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
