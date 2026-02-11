/**
 * Test script for WACZ creation functionality.
 * Run with: npx tsx scripts/test-wacz.ts
 *
 * Prerequisites: Start the dev-browser server first with `npm run start-server`
 */

import { connect } from "@/client.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const WACZ_PATH = join(import.meta.dirname, "../tmp/test-archive.wacz");

async function main() {
  console.log("Testing WACZ creation...\n");

  const client = await connect();

  try {
    // Create a test page
    const page = await client.page("wacz-test");
    console.log("✓ Created page 'wacz-test'");

    // Start HAR recording
    await client.startHarRecording("wacz-test");
    console.log("✓ Started HAR recording");

    // Navigate to test sites
    console.log("\nNavigating to example.com...");
    await page.goto("https://example.com", { waitUntil: "networkidle" });
    console.log(`✓ Navigated to ${page.url()}`);

    // Stop recording and get HAR
    const har = await client.stopHarRecording("wacz-test");
    console.log(`✓ Captured ${har.log.entries.length} entries`);

    // Convert to WACZ
    await client.saveAsWacz(har, WACZ_PATH, {
      title: "Test Archive",
      description: "Test WACZ creation from dev-browser",
    });
    console.log(`✓ Created WACZ at ${WACZ_PATH}`);

    // Verify WACZ file
    if (!existsSync(WACZ_PATH)) {
      throw new Error("WACZ file not created");
    }

    const stats = statSync(WACZ_PATH);
    console.log(`✓ WACZ file size: ${(stats.size / 1024).toFixed(1)} KB`);

    // List WACZ contents
    console.log("\n--- WACZ Contents ---");
    try {
      const contents = execSync(`unzip -l "${WACZ_PATH}"`, { encoding: "utf-8" });
      console.log(contents);
    } catch {
      console.log("(unzip not available, skipping contents listing)");
    }

    console.log("\n✅ WACZ creation test PASSED");
  } catch (err) {
    console.error("\n❌ WACZ creation test FAILED:", err);
    process.exit(1);
  } finally {
    // Clean up
    await client.close("wacz-test");
    await client.disconnect();
  }
}

main();
