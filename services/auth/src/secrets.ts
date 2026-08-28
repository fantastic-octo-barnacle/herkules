/**
 * Client-secret storage: the one place that knows the stored form of a
 * confidential client's secret. `base64url(SHA-256(secret))`, no padding —
 * byte-for-byte the format of Better Auth's unexported `defaultHasher`, so a
 * row this service inserts directly (clients.ts) verifies under the plugin, and
 * a row the plugin writes (DCR with a secret) verifies here. Passed to the
 * plugin as `storeClientSecret: clientSecretStore` so there is one function,
 * not two that happen to agree.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export async function hashClientSecret(secret: string): Promise<string> {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

/** Constant-time compare of the stored hash against the hash of the presented secret. */
export async function verifyClientSecret(secret: string, stored: string): Promise<boolean> {
  const presented = Buffer.from(await hashClientSecret(secret), "utf8");
  const expected = Buffer.from(stored, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** The `storeClientSecret` option object. One object so tests can observe that the plugin calls it. */
export const clientSecretStore = {
  hash: (secret: string) => hashClientSecret(secret),
  verify: (secret: string, stored: string) => verifyClientSecret(secret, stored),
};
