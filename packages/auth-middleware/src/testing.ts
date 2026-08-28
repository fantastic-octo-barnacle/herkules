/**
 * Subpath `@herkules/auth-middleware/testing`. Never imported by production
 * entry points. An in-process issuer that is the executable form of
 * docs/tokens.md's minting side: Ed25519 via jose, a JWKS served through a
 * `fetch` the verifier takes as its transport seam, and a minter that can
 * also produce every kind of BAD token the contract must reject.
 */
import type { CryptoKey, JWK } from "jose";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { Role } from "./principal.ts";

export interface MintOptions {
  /** `aud`. A string, or an array to test the "contains" rule. */
  readonly audience: string | readonly string[];
  /** Default "user_test". */
  readonly subject?: string;
  /** Default "member". `null` omits the claim (to test fail-closed rejection). */
  readonly role?: Role | null;
  /** Default "client_test". */
  readonly clientId?: string;
  /** Default []. Serialized space-separated; [] -> "". */
  readonly scopes?: readonly string[];
  /** Seconds from now; negative mints an already-expired token. Default 900. */
  readonly expiresIn?: number;
  readonly sessionId?: string;
  /** Extra claims merged BEFORE the AS-owned claims (like customAccessTokenClaims); reserved names are overridden. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Negative-test hatches. */
  readonly typ?: string;
  readonly issuer?: string;
  /** "current" (default) | "retired" (rotated out but still published) | "foreign" (never published: unknown kid). */
  readonly signWith?: "current" | "retired" | "foreign";
  /** Override `iat` (seconds). Default: now. */
  readonly issuedAt?: number;
  /** Override `jti`. Default: random. */
  readonly tokenId?: string;
}

export interface TestIssuer {
  /** e.g. https://issuer.test/auth. Never dialed; `fetch` serves it in-process. */
  readonly issuer: string;
  /** `${issuer}/jwks`. */
  readonly jwksUrl: string;
  /** Pass as `ResourceAuthOptions.fetch`. Serves GET jwksUrl (200 application/json); 404 elsewhere; throws while `offline`. */
  readonly fetch: typeof globalThis.fetch;
  /** Number of JWKS requests served. Assert on it to prove caching and kid-miss refetch. */
  readonly jwksFetches: number;
  /** Simulate the auth service being down: `fetch` rejects. */
  offline: boolean;
  /** Current signing kid. */
  readonly kid: string;
  /** The published key set, exactly as `fetch` serves it. */
  jwks(): { keys: JWK[] };
  /** Mints a contract-conformant at+jwt (EdDSA, all AS claims, random jti). */
  mint(options: MintOptions): Promise<string>;
  /** A new Ed25519 key becomes the signer; previous keys stay published (grace period). */
  rotate(): Promise<void>;
  /** Unpublish every key but the current one (end of grace period). */
  retireOldKeys(): void;
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

async function newSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const kid = crypto.randomUUID();
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };
  return { kid, privateKey, publicJwk };
}

const DEFAULT_ISSUER = "https://issuer.test/auth";
const DEFAULT_EXPIRES_IN = 900;

export async function createTestIssuer(options?: {
  readonly issuer?: string;
}): Promise<TestIssuer> {
  const issuer = options?.issuer ?? DEFAULT_ISSUER;
  const jwksUrl = `${issuer}/jwks`;
  /** Newest first. Index 0 signs; the rest are published for the grace period. */
  let keys: SigningKey[] = [await newSigningKey()];
  let jwksFetches = 0;

  const jwks = () => ({ keys: keys.map((k) => k.publicJwk) });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (self.offline) throw new TypeError("fetch failed: issuer offline");
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url !== jwksUrl || method !== "GET") return new Response("not found", { status: 404 });
    jwksFetches += 1;
    return new Response(JSON.stringify(jwks()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const self: TestIssuer = {
    issuer,
    jwksUrl,
    fetch,
    get jwksFetches() {
      return jwksFetches;
    },
    offline: false,
    get kid() {
      return keys[0]!.kid;
    },
    jwks,
    async mint(o) {
      const signer =
        o.signWith === "foreign"
          ? await newSigningKey()
          : o.signWith === "retired"
            ? (keys[1] ??
              (() => {
                throw new Error("no retired key: call rotate() first");
              })())
            : keys[0]!;
      const now = o.issuedAt ?? Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        ...o.claims,
        iss: o.issuer ?? issuer,
        sub: o.subject ?? "user_test",
        aud: typeof o.audience === "string" ? o.audience : [...o.audience],
        client_id: o.clientId ?? "client_test",
        azp: o.clientId ?? "client_test",
        scope: (o.scopes ?? []).join(" "),
        iat: now,
        exp: now + (o.expiresIn ?? DEFAULT_EXPIRES_IN),
        jti: o.tokenId ?? crypto.randomUUID(),
      };
      if (o.role !== null) claims.role = o.role ?? "member";
      if (o.sessionId !== undefined) claims.sid = o.sessionId;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", typ: o.typ ?? "at+jwt", kid: signer.kid })
        .sign(signer.privateKey);
    },
    async rotate() {
      keys = [await newSigningKey(), ...keys];
    },
    retireOldKeys() {
      keys = keys.slice(0, 1);
    },
  };
  return self;
}
