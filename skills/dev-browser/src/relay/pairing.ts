import { createHash, randomBytes } from "node:crypto";
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
  let pending: { code: string; expires: number } | undefined;

  return {
    get profileId() { return profileId; },
    begin() {
      if (profileId) throw new Error("This relay already has a paired Chrome profile");
      const code = randomBytes(16).toString("base64url");
      pending = { code, expires: Date.now() + 5 * 60_000 };
      return code;
    },
    redeem(code: unknown, credential: unknown) {
      if (profileId || !pending || pending.expires <= Date.now() ||
          typeof code !== "string" || code.length !== 22 || !tokensMatch(code, pending.code) ||
          typeof credential !== "string" || !credentialPattern.test(credential)) return undefined;
      const id = fingerprint(credential);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, id + "\n", { mode: 0o600, flag: "wx" });
      pending = undefined;
      profileId = id;
      return id;
    },
    verify(credential: unknown) {
      return !!profileId && typeof credential === "string" &&
        credentialPattern.test(credential) && tokensMatch(fingerprint(credential), profileId);
    },
  };
}
