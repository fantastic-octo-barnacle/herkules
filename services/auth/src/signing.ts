/** OIDC consumers use ES256; registered API/MCP resources explicitly retain EdDSA. */
import { createJwk, type JwtOptions } from "better-auth/plugins/jwt";
import type { Auth } from "./auth.ts";

export function signingOptions(issuer: string): JwtOptions {
  return {
    jwks: {
      keyPairConfig: { alg: "ES256" },
      keyPairConfigs: [{ alg: "EdDSA", crv: "Ed25519" }],
      gracePeriod: 30 * 86_400,
    },
    jwt: { issuer },
    disableSettingJwtHeader: true,
  };
}

/** Run before serving requests. Preserve old keys so outstanding tokens remain valid.
 * Better Auth falls back to the old key when a new default has no matching key.
 * This deployment has one auth process; concurrent bootstrap may add redundant keys.
 */
export async function ensureSigningKeys(auth: Auth, issuer: string): Promise<void> {
  const context = await auth.$context;
  const keys = await context.adapter.findMany<{ alg?: string; expiresAt?: Date }>({
    model: "jwks",
  });
  for (const keyPairConfig of [{ alg: "EdDSA", crv: "Ed25519" }, { alg: "ES256" }] as const) {
    if (
      keys.some(
        (key) =>
          key.alg === keyPairConfig.alg &&
          (!key.expiresAt || new Date(key.expiresAt).getTime() > Date.now()),
      )
    )
      continue;
    const options = signingOptions(issuer);
    await createJwk({ context } as unknown as Parameters<typeof createJwk>[0], {
      ...options,
      jwks: { ...options.jwks, keyPairConfig },
    });
  }
}
