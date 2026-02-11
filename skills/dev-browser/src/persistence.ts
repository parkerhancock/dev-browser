/**
 * Persistence layer for page mappings in extension mode.
 *
 * Stores page name -> tab mappings to disk so they survive
 * extension disconnects and relay server restarts.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEV_BROWSER_DIR = join(homedir(), ".dev-browser");
const PAGES_FILE = join(DEV_BROWSER_DIR, "pages.json");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PersistedPage {
  /** Key format: "agentSession:pageName" */
  key: string;
  /** Chrome's stable target ID (survives across debugger attach/detach) */
  targetId: string;
  /** Chrome tab ID for re-attachment */
  tabId: number;
  /** Last known URL for validation/matching */
  url: string;
  /** Unix timestamp for cleanup of stale entries */
  lastSeen: number;
}

interface PersistenceFile {
  version: 1;
  pages: PersistedPage[];
}

/**
 * Load persisted page mappings from disk.
 * Filters out entries older than MAX_AGE_MS.
 */
export function loadPersistedPages(): PersistedPage[] {
  mkdirSync(DEV_BROWSER_DIR, { recursive: true });

  if (!existsSync(PAGES_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(readFileSync(PAGES_FILE, "utf-8")) as PersistenceFile;
    const now = Date.now();

    // Filter out stale entries
    return (data.pages || []).filter((p) => now - p.lastSeen < MAX_AGE_MS);
  } catch {
    return [];
  }
}

/**
 * Save page mappings to disk.
 */
export function savePersistedPages(pages: PersistedPage[]): void {
  mkdirSync(DEV_BROWSER_DIR, { recursive: true });

  const data: PersistenceFile = {
    version: 1,
    pages,
  };

  // Atomic write: write to temp file then rename (rename is atomic on POSIX)
  const tmpFile = `${PAGES_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  renameSync(tmpFile, PAGES_FILE);
}

/**
 * Create a debounced save function to avoid excessive disk writes.
 */
export function createDebouncedSave(
  getPages: () => PersistedPage[],
  delayMs: number = 1000
): () => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      savePersistedPages(getPages());
      timeout = null;
    }, delayMs);
  };
}
