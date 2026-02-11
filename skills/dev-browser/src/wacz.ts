/**
 * WACZ (Web Archive Collection Zipped) creation from HAR data.
 * Converts HAR entries to WARC records and bundles into WACZ format.
 */

import { WARCRecord, WARCSerializer } from "warcio";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import type { HarLog, HarEntry } from "./client.js";

interface WaczOptions {
  title?: string;
  description?: string;
}

interface CdxEntry {
  url: string;
  timestamp: string;
  status: number;
  mime: string;
  offset: number;
  length: number;
  filename: string;
}

/**
 * Create a WACZ file from HAR data.
 */
export async function createWaczFromHar(
  har: HarLog,
  outputPath: string,
  options: WaczOptions = {}
): Promise<void> {
  const warcFilename = "data.warc";
  const cdxEntries: CdxEntry[] = [];

  // Collect WARC data in memory
  const warcChunks: Uint8Array[] = [];
  let warcOffset = 0;

  // Convert each HAR entry to WARC records
  for (const entry of har.log.entries) {
    const { requestRecord, responseRecord, cdx } = await harEntryToWarc(
      entry,
      warcFilename,
      warcOffset
    );

    // Serialize request record
    const reqBytes = await WARCSerializer.serialize(requestRecord, { gzip: false });
    warcChunks.push(reqBytes);
    warcOffset += reqBytes.length;

    // Serialize response record
    const respBytes = await WARCSerializer.serialize(responseRecord, { gzip: false });
    warcChunks.push(respBytes);

    // Update CDX with actual offset/length
    cdx.offset = warcOffset - respBytes.length;
    cdx.length = respBytes.length;
    cdxEntries.push(cdx);

    warcOffset += respBytes.length;
  }

  // Combine WARC chunks
  const warcData = concatUint8Arrays(warcChunks);
  const warcHash = createHash("sha256").update(warcData).digest("hex");

  // Create CDX index
  const cdxLines = cdxEntries.map((e) =>
    JSON.stringify({
      url: e.url,
      mime: e.mime,
      status: e.status,
      digest: "",
      offset: e.offset,
      length: e.length,
      filename: e.filename,
    })
  );
  const cdxData = cdxLines.join("\n") + "\n";
  const cdxHash = createHash("sha256").update(cdxData).digest("hex");

  // Create pages.jsonl
  const pages = har.log.entries
    .filter((e) => e.response.content.mimeType?.includes("html"))
    .map((e) => ({
      url: e.request.url,
      ts: e.startedDateTime,
      title: new URL(e.request.url).hostname,
    }));
  const pagesData = pages.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const pagesHash = createHash("sha256").update(pagesData).digest("hex");

  // Create datapackage.json
  const datapackage = {
    profile: "data-package",
    wacz_version: "1.1.1",
    title: options.title ?? "Web Archive",
    description: options.description ?? `Archived ${har.log.entries.length} resources`,
    created: new Date().toISOString(),
    software: "dev-browser/0.0.1",
    resources: [
      {
        name: "data.warc",
        path: `archive/${warcFilename}`,
        hash: `sha256:${warcHash}`,
        bytes: warcData.length,
      },
      {
        name: "index.cdx",
        path: "indexes/index.cdx",
        hash: `sha256:${cdxHash}`,
        bytes: cdxData.length,
      },
      {
        name: "pages.jsonl",
        path: "pages/pages.jsonl",
        hash: `sha256:${pagesHash}`,
        bytes: pagesData.length,
      },
    ],
  };

  // Create ZIP archive
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);

    // Add files to archive
    archive.append(JSON.stringify(datapackage, null, 2), { name: "datapackage.json" });
    archive.append(Buffer.from(warcData), { name: `archive/${warcFilename}` });
    archive.append(cdxData, { name: "indexes/index.cdx" });
    archive.append(pagesData, { name: "pages/pages.jsonl" });

    archive.finalize();
  });
}

/**
 * Convert a HAR entry to WARC request/response records.
 */
async function harEntryToWarc(
  entry: HarEntry,
  filename: string,
  _offset: number
): Promise<{
  requestRecord: WARCRecord;
  responseRecord: WARCRecord;
  cdx: CdxEntry;
}> {
  const url = entry.request.url;
  const date = entry.startedDateTime;

  // Build HTTP request string
  const reqUrl = new URL(url);
  const reqPath = reqUrl.pathname + reqUrl.search;
  const reqHeaders = entry.request.headers
    .map((h) => `${h.name}: ${h.value}`)
    .join("\r\n");
  const reqBody = entry.request.postData?.text ?? "";
  const httpRequest = `${entry.request.method} ${reqPath} HTTP/1.1\r\nHost: ${reqUrl.host}\r\n${reqHeaders}\r\n\r\n${reqBody}`;

  // Build HTTP response string
  const respHeaders = entry.response.headers
    .map((h) => `${h.name}: ${h.value}`)
    .join("\r\n");
  const respBody = entry.response.content.text ?? "";
  const statusLine = `HTTP/1.1 ${entry.response.status} ${entry.response.statusText || "OK"}`;
  const httpResponse = `${statusLine}\r\n${respHeaders}\r\n\r\n${respBody}`;

  // Create WARC request record
  const requestRecord = await WARCRecord.create(
    {
      url,
      date,
      type: "request",
      warcVersion: "WARC/1.1",
    },
    asyncIterFromString(httpRequest)
  );

  // Create WARC response record
  const responseRecord = await WARCRecord.create(
    {
      url,
      date,
      type: "response",
      warcVersion: "WARC/1.1",
    },
    asyncIterFromString(httpResponse)
  );

  // CDX entry (offset/length filled in later)
  const timestamp = date.replace(/[-:TZ]/g, "").slice(0, 14);
  const cdx: CdxEntry = {
    url,
    timestamp,
    status: entry.response.status,
    mime: entry.response.content.mimeType,
    offset: 0,
    length: 0,
    filename,
  };

  return { requestRecord, responseRecord, cdx };
}

/**
 * Create async iterator from string.
 */
async function* asyncIterFromString(str: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(str);
}

/**
 * Concatenate Uint8Arrays.
 */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
