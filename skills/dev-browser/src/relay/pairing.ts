import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tokensMatch } from "../auth.js";

const credentialPattern = /^[0-9a-f]{64}$/u;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const maxPending = 8;

export function createProfilePairing(stateDir: string) {
  const path = join(stateDir, "extension-profile");
  let profileId: string | undefined;
  // Fingerprints announced by unpaired extensions that have no local approval
  // helper. Only an operator on the relay host can approve one.
  const pending = new Set<string>();
  try {
    profileId = readFileSync(path, "utf8").trim();
    if (!credentialPattern.test(profileId)) throw new Error("Invalid extension pairing file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  function pair(id: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, id + "\n", { mode: 0o600, flag: "wx" });
    profileId = id;
    pending.clear();
    return id;
  }
  return {
    get profileId() { return profileId; },
    get pending() { return [...pending]; },
    approve(credential: unknown) {
      if (typeof credential !== "string" || !credentialPattern.test(credential)) return undefined;
      const id = fingerprint(credential);
      if (profileId) return tokensMatch(id, profileId) ? profileId : undefined;
      return pair(id);
    },
    /** Record a fingerprint an unpaired extension asks the relay host to approve. */
    request(id: unknown) {
      if (profileId || typeof id !== "string" || !credentialPattern.test(id)) return;
      pending.delete(id);
      pending.add(id);
      if (pending.size > maxPending) pending.delete(pending.values().next().value!);
    },
    /** Approve the one pending fingerprint that starts with `prefix` (at least 8 hex digits). */
    approvePending(prefix: unknown): { profileId: string } | { error: string } {
      if (profileId) return { error: "This relay is already approved for a Chrome profile" };
      if (typeof prefix !== "string" || !/^[0-9a-f]{8,64}$/u.test(prefix)) {
        return { error: "Give at least 8 hex digits of the fingerprint shown in the extension" };
      }
      const matches = [...pending].filter((id) => id.startsWith(prefix));
      if (matches.length !== 1) {
        return { error: matches.length ? "More than one pending profile matches; give more digits" : "No pending profile matches" };
      }
      return { profileId: pair(matches[0]!) };
    },
    verify(credential: unknown) {
      return !!profileId && typeof credential === "string" &&
        credentialPattern.test(credential) && tokensMatch(fingerprint(credential), profileId);
    },
  };
}
