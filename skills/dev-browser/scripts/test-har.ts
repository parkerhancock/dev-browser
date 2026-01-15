/**
 * Test script for HAR recording functionality.
 * Run with: npx tsx scripts/test-har.ts
 *
 * Prerequisites: Start the dev-browser server first with `npm run start-server`
 */

import { connect } from "@/client.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HAR_PATH = join(import.meta.dirname, "../tmp/test-recording.har");

async function main() {
  console.log("Testing HAR recording...\n");

  const client = await connect();

  try {
    // Create a test page
    const page = await client.page("har-test");
    console.log("✓ Created page 'har-test'");

    // Start HAR recording
    await client.startHarRecording("har-test");
    console.log("✓ Started HAR recording");

    // Check recording status
    if (!client.isRecordingHar("har-test")) {
      throw new Error("Expected recording to be active");
    }
    console.log("✓ Recording status confirmed");

    // Navigate to a test site
    console.log("\nNavigating to example.com...");
    await page.goto("https://example.com", { waitUntil: "networkidle" });
    console.log(`✓ Navigated to ${page.url()}`);

    // Stop recording and get HAR
    const har = await client.stopHarRecording("har-test");
    console.log("✓ Stopped HAR recording");

    // Verify recording status cleared
    if (client.isRecordingHar("har-test")) {
      throw new Error("Recording should be stopped");
    }
    console.log("✓ Recording status cleared");

    // Analyze HAR
    console.log("\n--- HAR Analysis ---");
    console.log(`Version: ${har.log.version}`);
    console.log(`Creator: ${har.log.creator.name} ${har.log.creator.version}`);
    console.log(`Entries: ${har.log.entries.length}`);

    if (har.log.entries.length > 0) {
      console.log("\nRequests:");
      for (const entry of har.log.entries.slice(0, 5)) {
        const url = new URL(entry.request.url);
        console.log(`  ${entry.request.method} ${url.pathname} → ${entry.response.status}`);
      }
      if (har.log.entries.length > 5) {
        console.log(`  ... and ${har.log.entries.length - 5} more`);
      }
    }

    // Save HAR to file
    writeFileSync(HAR_PATH, JSON.stringify(har, null, 2));
    console.log(`\n✓ Saved HAR to ${HAR_PATH}`);

    console.log("\n✅ HAR recording test PASSED");
  } catch (err) {
    console.error("\n❌ HAR recording test FAILED:", err);
    process.exit(1);
  } finally {
    // Clean up
    await client.close("har-test");
    await client.disconnect();
  }
}

main();
