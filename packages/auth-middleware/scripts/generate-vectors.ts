/**
 * Regenerates docs/tokens-vectors.json: the conformance vectors both
 * tests/vectors.test.ts and docs/verify_token.py are run against.
 * Run: `vp run vectors` (from packages/auth-middleware).
 *
 * The key pair is TEST-ONLY and checked in. An existing file's key is reused so
 * regeneration is deterministic (Ed25519 signatures are deterministic).
 * Timestamps are fixed: valid tokens carry a far-future `exp` so the vectors
 * need no clock control; `expired` carries a past one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/tokens-vectors.json");
const ISSUER = "https://herkules.dev/auth";
const RESOURCE = "https://herkules.dev/mcp/directory";
const PRM = "https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory";
const KID = "018f3c7e-6b1d-7a2e-9c4f-0a1b2c3d4e5f";
const IAT = 1_756_000_000; // 2025-08-24T01:46:40Z
const EXP_VALID = 4_000_000_000; // 2096-09-27: never expires within the vectors' lifetime
const EXP_PAST = IAT + 900;

const invalid = (description: string) =>
  `Bearer error="invalid_token", resource_metadata="${PRM}", error_description="${description}"`;

async function loadOrCreateKey(): Promise<JWK> {
  try {
    const existing = JSON.parse(readFileSync(OUT, "utf8")) as { private_key_jwk?: JWK };
    if (existing.private_key_jwk) return existing.private_key_jwk;
  } catch {
    /* first run */
  }
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return { ...(await exportJWK(privateKey)), kid: KID, alg: "EdDSA", use: "sig" };
}

const privateJwk = await loadOrCreateKey();
const privateKey = await importJWK(privateJwk, "EdDSA");
const { d: _d, ...publicJwk } = privateJwk;

interface MintOpts {
  claims?: Record<string, unknown>;
  omit?: string[];
  typ?: string;
  kid?: string;
}
async function mint(o: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    sub: "usr_01j9k3m8x2q4r6t8v0w2y4z6a8",
    aud: RESOURCE,
    client_id: "cli_claude_code",
    azp: "cli_claude_code",
    scope: "offline_access",
    role: "member",
    iat: IAT,
    exp: EXP_VALID,
    jti: "jti_0001",
    ...o.claims,
  };
  for (const k of o.omit ?? []) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: o.typ ?? "at+jwt", kid: o.kid ?? KID })
    .sign(privateKey);
}

const valid = await mint();
const [h, p] = valid.split(".");
const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt", kid: KID })).toString(
  "base64url",
);

const ok = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  www_authenticate: null,
  principal: {
    sub: "usr_01j9k3m8x2q4r6t8v0w2y4z6a8",
    role: "member",
    client_id: "cli_claude_code",
    jti: "jti_0001",
    ...extra,
  },
});

const vectors = [
  {
    name: "no_token",
    note: "§12.1",
    token: null,
    expect: { status: 401, www_authenticate: `Bearer resource_metadata="${PRM}"` },
  },
  { name: "valid", note: "§16 sample token", token: valid, expect: ok() },
  {
    name: "valid_admin_with_sid",
    token: await mint({ claims: { role: "admin", sid: "ses_42", jti: "jti_0002" } }),
    expect: ok({ role: "admin", jti: "jti_0002" }),
  },
  {
    name: "valid_aud_array",
    note: "§7: aud array containing the resource",
    token: await mint({ claims: { aud: [RESOURCE, `${ISSUER}/oauth2/userinfo`] } }),
    expect: ok(),
  },
  {
    name: "expired",
    note: "§12.2 the only distinguished description",
    token: await mint({ claims: { exp: EXP_PAST } }),
    expect: { status: 401, www_authenticate: invalid("token expired") },
  },
  {
    name: "wrong_audience",
    note: "§7",
    token: await mint({ claims: { aud: `${RESOURCE}-admin` } }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "wrong_audience_trailing_slash",
    note: "§7 byte-for-byte",
    token: await mint({ claims: { aud: `${RESOURCE}/` } }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "wrong_issuer",
    note: "§6 exact string compare",
    token: await mint({ claims: { iss: `${ISSUER}/` } }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "wrong_typ",
    note: "§4",
    token: await mint({ typ: "JWT" }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "alg_none",
    note: "§4",
    token: `${noneHeader}.${p}.`,
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "unknown_kid",
    note: "§9",
    token: await mint({ kid: "kid_not_published" }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "bad_signature",
    note: "§6",
    token: `${h}.${p}.${valid.split(".")[2]!.slice(0, -4)}AAAA`,
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "missing_role",
    note: "§5/§11 fail closed",
    token: await mint({ omit: ["role"] }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "missing_client_id",
    note: "§5 (azp also absent)",
    token: await mint({ omit: ["client_id", "azp"] }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "dpop_cnf",
    note: "§14",
    token: await mint({ claims: { cnf: { jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" } } }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
  {
    name: "not_yet_valid",
    note: "§8 iat far in the future",
    token: await mint({ claims: { iat: EXP_VALID - 900 } }),
    expect: { status: 401, www_authenticate: invalid("invalid token") },
  },
];

const out = {
  $comment:
    "Generated by packages/auth-middleware/scripts/generate-vectors.ts. TEST-ONLY key pair. Do not edit by hand.",
  contract_version: 1,
  issuer: ISSUER,
  resource: RESOURCE,
  resource_metadata_url: PRM,
  jwks: { keys: [publicJwk] },
  private_key_jwk: privateJwk,
  vectors,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${OUT}`);
