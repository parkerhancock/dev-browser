/**
 * Relay policy — domain allow/block lists, permission modes, and the
 * per-origin raw-CDP allowlist, enforced at the relay choke point.
 *
 * Policy loads from ~/.dev-browser/policy.json (DEV_BROWSER_DIR override).
 * No file means permissive mode: everything allowed, same behavior as before
 * policy existed. A file with `defaultMode: "strict"` fail-closes:
 * navigation is allowed only to allowlisted domains, and raw CDP commands
 * outside the safe set are blocked unless the page's origin has
 * `fullCdpAccessOrigins` membership.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type PermissionMode = "strict" | "permissive";

export interface SessionPolicy {
  mode?: PermissionMode;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface RelayPolicy {
  version?: 1;
  /** Default mode for sessions without an explicit entry. */
  defaultMode: PermissionMode;
  /** Domain allowlist (strict mode): "example.com" matches subdomains too. */
  allowedDomains?: string[];
  /** Domain blocklist (both modes): always wins over the allowlist. */
  blockedDomains?: string[];
  /** Extra CDP methods (or "Domain.*" prefixes) allowed in strict mode. */
  cdpMethodAllowlist?: string[];
  /** Origins granted full raw-CDP passthrough in strict mode. */
  fullCdpAccessOrigins?: string[];
  /** Per-agent-session overrides. */
  sessions?: Record<string, SessionPolicy>;
}

export const PERMISSIVE_POLICY: RelayPolicy = { defaultMode: "permissive" };

/**
 * CDP methods safe enough for strict mode: everything the unified Page API
 * and the relay's own features use. Entries ending in "." are prefixes.
 */
const SAFE_CDP_PREFIXES = [
  "Page.",
  "Runtime.",
  "Input.",
  "DOM.",
  "CSS.",
  "Emulation.",
  "Network.",
  "Log.",
  "Target.",
  "Accessibility.",
  "DevBrowser.",
];
const SAFE_CDP_METHODS = new Set([
  "Browser.getVersion",
  "Browser.setDownloadBehavior",
  "Storage.clearDataForOrigin",
  "Storage.getCookies",
  "Storage.setCookies",
]);

function policyFilePath(): string {
  const dir = process.env.DEV_BROWSER_DIR ?? join(homedir(), ".dev-browser");
  return join(dir, "policy.json");
}

/** Load policy from disk. Missing file -> permissive. Malformed -> strict (fail closed). */
export function loadPolicy(): RelayPolicy {
  let raw: string;
  try {
    raw = readFileSync(policyFilePath(), "utf8");
  } catch {
    return PERMISSIVE_POLICY;
  }
  try {
    const parsed = JSON.parse(raw) as RelayPolicy;
    if (parsed.defaultMode !== "strict" && parsed.defaultMode !== "permissive") {
      throw new Error(`invalid defaultMode: ${String(parsed.defaultMode)}`);
    }
    return parsed;
  } catch (err) {
    // A present-but-broken policy file fails closed rather than silently open.
    console.error(
      `dev-browser: failed to parse ${policyFilePath()} (${(err as Error).message}); failing closed (strict, empty allowlist)`
    );
    return { defaultMode: "strict" };
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*\./, "");
  const h = hostname.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function resolveSession(
  policy: RelayPolicy,
  agentSession: string
): Required<Pick<SessionPolicy, "mode">> & SessionPolicy {
  const override = policy.sessions?.[agentSession] ?? {};
  return {
    mode: override.mode ?? policy.defaultMode,
    allowedDomains: override.allowedDomains ?? policy.allowedDomains,
    blockedDomains: [...(policy.blockedDomains ?? []), ...(override.blockedDomains ?? [])],
  };
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

/** Check whether a navigation to `url` is allowed for this agent session. */
export function checkNavigation(
  policy: RelayPolicy,
  agentSession: string,
  url: string
): PolicyDecision {
  const { mode, allowedDomains, blockedDomains } = resolveSession(policy, agentSession);

  let hostname: string;
  try {
    const parsed = new URL(url);
    if (["about:", "data:", "blob:", "chrome:"].includes(parsed.protocol)) {
      // Non-network schemes: allow about:blank always; block chrome:// in strict mode
      if (parsed.protocol === "chrome:" && mode === "strict") {
        return { allowed: false, reason: "chrome:// navigation blocked in strict mode" };
      }
      return { allowed: true };
    }
    hostname = parsed.hostname;
  } catch {
    return mode === "strict"
      ? { allowed: false, reason: `unparseable URL blocked in strict mode: ${url}` }
      : { allowed: true };
  }

  if (blockedDomains?.some((d) => domainMatches(hostname, d))) {
    return { allowed: false, reason: `domain "${hostname}" is blocklisted` };
  }
  if (mode === "permissive") return { allowed: true };

  // Strict: fail closed — only allowlisted domains
  if (allowedDomains?.some((d) => domainMatches(hostname, d))) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `strict mode: domain "${hostname}" is not on the allowlist`,
  };
}

/** Check whether a raw CDP method is allowed for this session/page origin. */
export function checkCdpMethod(
  policy: RelayPolicy,
  agentSession: string,
  method: string,
  pageOrigin?: string
): PolicyDecision {
  const { mode } = resolveSession(policy, agentSession);
  if (mode === "permissive") return { allowed: true };

  if (pageOrigin && policy.fullCdpAccessOrigins?.some((o) => originMatches(pageOrigin, o))) {
    return { allowed: true };
  }

  if (SAFE_CDP_METHODS.has(method)) return { allowed: true };
  if (SAFE_CDP_PREFIXES.some((p) => method.startsWith(p))) return { allowed: true };

  const extra = policy.cdpMethodAllowlist ?? [];
  for (const entry of extra) {
    if (entry.endsWith(".*")) {
      if (method.startsWith(entry.slice(0, -1))) return { allowed: true };
    } else if (entry === method) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `strict mode: CDP method "${method}" is not allowlisted (grant fullCdpAccessOrigins for this origin or add it to cdpMethodAllowlist)`,
  };
}

function originMatches(pageOrigin: string, policyOrigin: string): boolean {
  if (pageOrigin === policyOrigin) return true;
  try {
    const page = new URL(pageOrigin);
    const pol = new URL(policyOrigin);
    return page.protocol === pol.protocol && domainMatches(page.hostname, pol.hostname);
  } catch {
    return false;
  }
}
