import { mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_MAX_AGE_DAYS = 7;

export interface Logger {
  log: (...args: unknown[]) => void;
  logDir: string;
  logFile: string;
}

/**
 * Clean up log files older than LOG_MAX_AGE_DAYS.
 */
function cleanupOldLogs(logDir: string): void {
  try {
    const maxAgeMs = LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const file of readdirSync(logDir)) {
      if (!file.endsWith(".log")) continue;
      const filePath = join(logDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // Ignore per-file errors
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a logger that writes to both stdout and a date-based log file.
 * Logs are stored in ~/.dev-browser/logs/<prefix>-YYYY-MM-DD.log
 * Log files older than 7 days are cleaned up on initialization.
 */
export function createLogger(prefix: string): Logger {
  const logDir = join(homedir(), ".dev-browser", "logs");
  mkdirSync(logDir, { recursive: true });

  // Clean up old logs on startup
  cleanupOldLogs(logDir);

  const today = new Date().toISOString().split("T")[0];
  const logFile = join(logDir, `${prefix}-${today}.log`);

  function log(...args: unknown[]) {
    const timestamp = new Date().toISOString();
    const message = args
      .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
      .join(" ");
    const line = `[${timestamp}] [${prefix}] ${message}`;

    // Write to stdout
    console.log(`[${prefix}]`, ...args);

    // Append to file
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      // Silently ignore file write errors to avoid breaking the server
    }
  }

  return { log, logDir, logFile };
}
