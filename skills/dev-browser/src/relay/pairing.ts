import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tokensMatch } from "../auth.js";

const credentialPattern = /^[0-9a-f]{64}$/u;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export function createProfilePairing(stateDir: string) {
  const path = join(stateDir, "extension-profile");
  let profileId: string | undefined;
  try {
    profileId = readFileSync(path, "utf8").trim();
    if (!credentialPattern.test(profileId)) throw new Error("Invalid extension pairing file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    get profileId() { return profileId; },
    approve(credential: unknown) {
      if (typeof credential !== "string" || !credentialPattern.test(credential)) return undefined;
      const id = fingerprint(credential);
      if (profileId) return tokensMatch(id, profileId) ? profileId : undefined;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, id + "\n", { mode: 0o600, flag: "wx" });
      profileId = id;
      return id;
    },
    verify(credential: unknown) {
      return !!profileId && typeof credential === "string" &&
        credentialPattern.test(credential) && tokensMatch(fingerprint(credential), profileId);
    },
  };
}
