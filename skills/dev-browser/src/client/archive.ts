/**
 * Page archives: saveWacz() and saveArchive() (WACZ, HAR, screenshot, PDF).
 */

import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { mkdtempSync, createWriteStream, rmSync } from "node:fs";
import archiver from "archiver";
import { createWaczFromHar } from "../wacz.js";
import { createLogger } from "../logging.js";
import type { DevBrowserClient } from "../client.js";

const logger = createLogger("client");

export interface SaveWaczOptions {
  outputPath?: string;
  title?: string;
  description?: string;
}

/**
 * Stop HAR recording and save as WACZ in one step.
 * Recording is auto-started by client.page(), so this is usually all you need.
 *
 * @returns Path to the saved WACZ file
 */
export async function saveWacz(
  client: DevBrowserClient,
  name: string,
  options?: SaveWaczOptions
): Promise<string> {
  const har = await client.stopHarRecording(name);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(homedir(), ".dev-browser", "archives");
  await mkdir(archiveDir, { recursive: true });
  const outputPath = options?.outputPath ?? join(archiveDir, `${name}-${timestamp}.wacz`);
  await createWaczFromHar(har, outputPath, {
    title: options?.title,
    description: options?.description,
  });
  logger.info(`Saved WACZ to ${outputPath}`);
  return outputPath;
}

export interface SaveArchiveOptions extends SaveWaczOptions {
  /** Skip PDF capture (e.g., if page.pdf() fails in headed mode) */
  skipPdf?: boolean;
  /** Skip rendered HTML capture */
  skipHtml?: boolean;
}

/**
 * Save a complete archive bundle: WACZ + rendered HTML + PDF in a single .zip.
 *
 * The .zip contains:
 * - `<name>.wacz` — WARC-based web archive (network traffic)
 * - `<name>.html` — as-rendered DOM snapshot
 * - `<name>.pdf`  — PDF rendering of the page
 *
 * @returns Path to the saved .zip archive
 */
export async function saveArchive(
  client: DevBrowserClient,
  name: string,
  options?: SaveArchiveOptions
): Promise<string> {
  const page = await client.page(name, { record: false });

  // Capture rendered HTML
  let renderedHtml: string | null = null;
  if (!options?.skipHtml) {
    try {
      renderedHtml = await page.content();
    } catch (err) {
      logger.warn(`Failed to capture rendered HTML for "${name}":`, err);
    }
  }

  // Capture PDF
  let pdfBuffer: Buffer | null = null;
  if (!options?.skipPdf) {
    try {
      pdfBuffer = await page.pdf({ printBackground: true });
    } catch (err) {
      logger.warn(`Failed to capture PDF for "${name}":`, err);
    }
  }

  // Stop recording and create WACZ
  const har = await client.stopHarRecording(name);
  const tempDir = mkdtempSync(join(tmpdir(), "dev-browser-archive-"));
  const waczPath = join(tempDir, `${name}.wacz`);
  await createWaczFromHar(har, waczPath, {
    title: options?.title,
    description: options?.description,
  });

  // Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(homedir(), ".dev-browser", "archives");
  await mkdir(archiveDir, { recursive: true });
  const outputPath = options?.outputPath ?? join(archiveDir, `${name}-${timestamp}.zip`);

  // Bundle into .zip
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const zip = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    zip.on("error", reject);
    zip.pipe(output);
    zip.file(waczPath, { name: `${name}.wacz` });
    if (renderedHtml !== null) {
      zip.append(renderedHtml, { name: `${name}.html` });
    }
    if (pdfBuffer !== null) {
      zip.append(pdfBuffer, { name: `${name}.pdf` });
    }
    zip.finalize();
  });

  rmSync(tempDir, { recursive: true });

  const parts = [
    "wacz",
    renderedHtml !== null ? "html" : null,
    pdfBuffer !== null ? "pdf" : null,
  ].filter(Boolean);
  logger.info(`Saved archive to ${outputPath} (${parts.join(" + ")})`);
  return outputPath;
}
