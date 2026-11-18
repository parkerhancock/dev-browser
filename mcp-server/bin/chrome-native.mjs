#!/usr/bin/env node
import { readFileSync, readSync } from "node:fs";
import { endianness } from "node:os";
import { join } from "node:path";

const [allowedOrigin, stateDir, caller] = process.argv.slice(2);
const littleEndian = endianness() === "LE";
const maxRequest = 4096;

function read(size) {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(0, data, offset, size - offset);
    if (!count) throw new Error("Incomplete native message");
    offset += count;
  }
  return data;
}

function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  if (littleEndian) length.writeUInt32LE(body.length);
  else length.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([length, body]));
}

async function approve() {
  if (!allowedOrigin || (caller !== allowedOrigin && caller + "/" !== allowedOrigin)) {
    return { error: "Dev Browser extension required" };
  }
  const header = read(4);
  const size = littleEndian ? header.readUInt32LE() : header.readUInt32BE();
  if (!size || size > maxRequest) return { error: "Invalid approval message" };
  const data = JSON.parse(read(size).toString());
  if (typeof data?.credential !== "string" || !/^[0-9a-f]{64}$/u.test(data.credential)) {
    return { error: "Invalid approval credential" };
  }
  const token = readFileSync(join(stateDir, "token"), "utf8").trim();
  const port = process.env.DEV_BROWSER_RELAY_PORT ?? "9224";
  if (!/^\d{1,5}$/u.test(port)) return { error: "Invalid relay port" };
  const result = await fetch(`http://127.0.0.1:${port}/pairing/local`, {
    method: "POST",
    headers: { "X-DevBrowser-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ credential: data.credential }),
    redirect: "error",
    signal: AbortSignal.timeout(4000),
  });
  if (result.status === 409) return { error: "This relay is approved for another Chrome profile" };
  return result.ok ? { approved: true } : { error: "The local relay did not approve SSH access" };
}

try {
  reply(await approve());
} catch {
  reply({ error: "Could not approve access through the local Dev Browser relay" });
}
