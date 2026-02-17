import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  /** Write info-level messages to stdout (default: false — file only) */
  stdout?: boolean;
  /** Minimum log level (default: "info") */
  level?: LogLevel;
  /** Override log directory */
  logDir?: string;
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** Alias for info (backward compat) */
  log: (...args: unknown[]) => void;
  logDir: string;
  logFile: string;
}

/**
 * Resolve the log directory:
 * 1. options.logDir if provided
 * 2. $TMPDIR/claude-skills/dev-browser/ (ephemeral, OS-managed)
 * 3. ~/.dev-browser/logs/ (fallback)
 */
function resolveLogDir(options?: LoggerOptions): string {
  if (options?.logDir) return options.logDir;

  const tmp = tmpdir();
  if (tmp) {
    return join(tmp, "claude-skills", "dev-browser");
  }

  return join(homedir(), ".dev-browser", "logs");
}

/**
 * Create a logger with level-based routing.
 *
 * By default (stdout: false), all output goes to file only.
 * warn/error always go to stderr regardless of stdout setting.
 *
 * | Level | File | stdout (stdout: true) | stderr (always) |
 * |-------|------|-----------------------|-----------------|
 * | debug | yes  | no                    | no              |
 * | info  | yes  | yes                   | no              |
 * | warn  | yes  | no                    | yes             |
 * | error | yes  | no                    | yes             |
 */
export function createLogger(prefix: string, options?: LoggerOptions): Logger {
  const logDir = resolveLogDir(options);
  const minLevel = LEVEL_ORDER[options?.level ?? "info"];
  const useStdout = options?.stdout ?? false;

  mkdirSync(logDir, { recursive: true });

  const today = new Date().toISOString().split("T")[0];
  const logFile = join(logDir, `${prefix}-${today}.log`);

  function formatMessage(level: LogLevel, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const message = args
      .map((arg) => {
        if (arg instanceof Error) return arg.stack ?? arg.message;
        if (typeof arg === "object") return JSON.stringify(arg);
        return String(arg);
      })
      .join(" ");
    return `[${timestamp}] [${prefix}] [${level}] ${message}`;
  }

  function writeToFile(line: string): void {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      // Silently ignore file write errors
    }
  }

  /** Format args for stderr: concise one-liners, no stack traces. */
  function formatForStderr(args: unknown[]): string {
    return args
      .map((arg) => {
        if (arg instanceof Error) return arg.message;
        if (typeof arg === "object" && arg !== null) {
          // Extract .message if it looks like an error-like object
          const obj = arg as Record<string, unknown>;
          if (typeof obj.message === "string") return obj.message;
          return JSON.stringify(arg);
        }
        return String(arg);
      })
      .join(" ");
  }

  function emit(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < minLevel) return;

    const line = formatMessage(level, args);

    // Always write to file (full details including stack traces)
    writeToFile(line);

    // Route to console based on level and options
    if (level === "warn" || level === "error") {
      // warn/error go to stderr — concise message only, no stack traces
      console.error(`[${prefix}] ${formatForStderr(args)}`);
    } else if (useStdout && level === "info") {
      // info goes to stdout only when opted in
      console.log(`[${prefix}]`, ...args);
    }
    // debug never goes to console
  }

  const debug = (...args: unknown[]) => emit("debug", args);
  const info = (...args: unknown[]) => emit("info", args);
  const warn = (...args: unknown[]) => emit("warn", args);
  const error = (...args: unknown[]) => emit("error", args);

  return { debug, info, warn, error, log: info, logDir, logFile };
}
