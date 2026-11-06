/**
 * Unit tests for the relay policy module.
 */

import { describe, test, expect } from "vitest";
import {
  checkNavigation,
  checkCdpMethod,
  PERMISSIVE_POLICY,
  type RelayPolicy,
} from "../policy.js";

const STRICT: RelayPolicy = {
  defaultMode: "strict",
  allowedDomains: ["example.com"],
  blockedDomains: ["blocked.example.com"],
};

describe("checkNavigation", () => {
  test("permissive allows everything", () => {
    expect(checkNavigation(PERMISSIVE_POLICY, "s", "https://anything.net/x").allowed).toBe(true);
  });

  test("permissive still honors the blocklist", () => {
    const policy: RelayPolicy = {
      defaultMode: "permissive",
      blockedDomains: ["evil.com"],
    };
    expect(checkNavigation(policy, "s", "https://evil.com/").allowed).toBe(false);
    expect(checkNavigation(policy, "s", "https://sub.evil.com/").allowed).toBe(false);
    expect(checkNavigation(policy, "s", "https://good.com/").allowed).toBe(true);
  });

  test("strict allows only allowlisted domains (subdomains included)", () => {
    expect(checkNavigation(STRICT, "s", "https://example.com/a").allowed).toBe(true);
    expect(checkNavigation(STRICT, "s", "https://www.example.com/a").allowed).toBe(true);
    expect(checkNavigation(STRICT, "s", "https://other.net/").allowed).toBe(false);
    expect(checkNavigation(STRICT, "s", "https://notexample.com/").allowed).toBe(false);
  });

  test("blocklist wins over allowlist", () => {
    expect(checkNavigation(STRICT, "s", "https://blocked.example.com/").allowed).toBe(false);
  });

  test("strict with no allowlist blocks all network navigation (fail closed)", () => {
    const policy: RelayPolicy = { defaultMode: "strict" };
    expect(checkNavigation(policy, "s", "https://example.com/").allowed).toBe(false);
    expect(checkNavigation(policy, "s", "about:blank").allowed).toBe(true);
  });

  test("strict blocks chrome:// and garbage URLs", () => {
    expect(checkNavigation(STRICT, "s", "chrome://settings").allowed).toBe(false);
    expect(checkNavigation(STRICT, "s", "not a url").allowed).toBe(false);
  });

  test("per-session override beats the default mode", () => {
    const policy: RelayPolicy = {
      defaultMode: "strict",
      sessions: { trusted: { mode: "permissive" } },
    };
    expect(checkNavigation(policy, "trusted", "https://anywhere.io/").allowed).toBe(true);
    expect(checkNavigation(policy, "other", "https://anywhere.io/").allowed).toBe(false);
  });
});

describe("checkCdpMethod", () => {
  test("permissive allows everything", () => {
    expect(checkCdpMethod(PERMISSIVE_POLICY, "s", "HeapProfiler.enable").allowed).toBe(true);
  });

  test("strict allows the safe set", () => {
    for (const method of [
      "Page.navigate",
      "Runtime.evaluate",
      "Input.dispatchKeyEvent",
      "DOM.setFileInputFiles",
      "Network.getCookies",
      "Browser.getVersion",
      "Storage.clearDataForOrigin",
    ]) {
      expect(checkCdpMethod(STRICT, "s", method).allowed).toBe(true);
    }
  });

  test("strict blocks methods outside the safe set", () => {
    expect(checkCdpMethod(STRICT, "s", "HeapProfiler.enable").allowed).toBe(false);
    expect(checkCdpMethod(STRICT, "s", "Browser.grantPermissions").allowed).toBe(false);
  });

  test("cdpMethodAllowlist adds methods and prefixes", () => {
    const policy: RelayPolicy = {
      ...STRICT,
      cdpMethodAllowlist: ["Browser.grantPermissions", "HeapProfiler.*"],
    };
    expect(checkCdpMethod(policy, "s", "Browser.grantPermissions").allowed).toBe(true);
    expect(checkCdpMethod(policy, "s", "HeapProfiler.enable").allowed).toBe(true);
    expect(checkCdpMethod(policy, "s", "Tracing.start").allowed).toBe(false);
  });

  test("fullCdpAccessOrigins opens everything for that origin only", () => {
    const policy: RelayPolicy = {
      ...STRICT,
      fullCdpAccessOrigins: ["https://example.com"],
    };
    expect(
      checkCdpMethod(policy, "s", "Tracing.start", "https://example.com").allowed
    ).toBe(true);
    expect(
      checkCdpMethod(policy, "s", "Tracing.start", "https://other.net").allowed
    ).toBe(false);
    expect(checkCdpMethod(policy, "s", "Tracing.start").allowed).toBe(false);
  });
});
