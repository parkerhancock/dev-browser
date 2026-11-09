import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function resolveErrorDir(): string {
  const dir = join(tmpdir(), "claude-skills", "dev-browser", "errors");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeErrorToFile(err: unknown, context: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(resolveErrorDir(), `error-${ts}.txt`);
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const content = `Context: ${context}\nTime: ${new Date().toISOString()}\n\n${stack}\n`;
  try {
    writeFileSync(path, content);
  } catch {
    // Silently ignore write errors — don't mask the original error
  }
  return path;
}

/**
 * Wraps all method calls on `target`. When a method throws (sync or async),
 * the full stack trace is written to a tmp file and a clean error is re-thrown
 * with just the message and a path to the details file.
 *
 * Synchronous non-Promise return values are passed through unchanged.
 *
 * Example error message:
 *   "Element not found: button.submit [details: /tmp/claude-skills/dev-browser/errors/error-2026-02-23T....txt]"
 */
export function wrapWithCleanErrors<T extends object>(target: T, contextPrefix: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = val.apply(obj, args);
        } catch (err) {
          const path = writeErrorToFile(err, `${contextPrefix}.${String(prop)}`);
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`${msg} [details: ${path}]`);
        }
        if (result instanceof Promise) {
          return result.catch((err: unknown) => {
            const path = writeErrorToFile(err, `${contextPrefix}.${String(prop)}`);
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`${msg} [details: ${path}]`);
          });
        }
        return result;
      };
    },
  }) as T;
}
