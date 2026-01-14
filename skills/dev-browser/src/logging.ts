import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface Logger {
  log: (...args: unknown[]) => void;
  logDir: string;
  logFile: string;
}

/**
 * Create a logger that writes to both stdout and a date-based log file.
 * Logs are stored in ~/.dev-browser/logs/<prefix>-YYYY-MM-DD.log
 */
export function createLogger(prefix: string): Logger {
  const logDir = join(homedir(), ".dev-browser", "logs");
  mkdirSync(logDir, { recursive: true });

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
