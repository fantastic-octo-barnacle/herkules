/**
 * Owns "is this token real and is it ours": Authorization header parsing, the
 * per-instance JWKS handle, the jose call with pinned policy, and the
 * classification of every jose error into an AuthFailure. The only module
 * that touches the network. Mirrors docs/tokens.md §6–§9.
 */
import type { JWTPayload, JWTVerifyOptions } from "jose";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from "jose";
import type { AuthFailure, InvalidTokenReason } from "./failure.ts";
import type { Principal } from "./principal.ts";
import { MalformedClaimsError, principalFromClaims } from "./principal.ts";

export type VerifyResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly failure: AuthFailure };

export interface TokenVerifierConfig {
  readonly issuer: string;
  /** Canonical resource URL; must appear in `aud`. Already validated by resource.ts. */
  readonly resource: string;
  readonly jwksUrl: string;
  /** Applied to exp/iat/nbf. Default 60, hard cap 300 (docs/tokens.md §8). */
  readonly clockToleranceSeconds: number;
  /** JWKS transport. Default: globalThis.fetch. Tests pass TestIssuer.fetch. */
  readonly fetch: typeof globalThis.fetch;
}

export interface TokenVerifier {
  /** Raw compact JWS in; principal or classified failure out. Never throws for anything a client did. */
  verify(token: string): Promise<VerifyResult>;
}

/** docs/tokens.md §8: MUST NOT tolerate more than 300 s. */
export const MAX_CLOCK_TOLERANCE_SECONDS = 300;
/** docs/tokens.md §9: SHOULD cache ≤ 5 min; no unknown-kid refetch more than once per 30 s; 5 s fetch timeout. */
const JWKS_CACHE_MAX_AGE_MS = 5 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_TIMEOUT_MS = 5_000;

const ALGORITHMS: readonly string[] = ["EdDSA"];
const TOKEN_TYPE = "at+jwt";
/** `client_id` is checked in principalFromClaims (it falls back to `azp`); `role` likewise. */
const REQUIRED_CLAIMS = ["sub", "aud", "exp", "iat", "jti"];

/**
 * Creates one jose `createRemoteJWKSet(jwksUrl, { [customFetch]: fetch, cacheMaxAge: 5 min, cooldownDuration: 30 s })`
 * per instance (no module-global cache: two resources in one process never share key state).
 * Policy applied in `jwtVerify`: algorithms ["EdDSA"], typ "at+jwt", issuer, audience = resource,
 * clockTolerance, requiredClaims ["sub","aud","exp","iat","jti"].
 * Then: `cnf` present -> invalid_token/dpop_bound; principalFromClaims -> MalformedClaimsError -> invalid_token/malformed.
 * jose error -> reason: JWTExpired->expired; JWTClaimValidationFailed(claim iss/aud/nbf/iat/typ)->wrong_issuer/wrong_audience/not_yet_valid/wrong_type;
 * JOSEAlgNotAllowed->wrong_algorithm; JWKSNoMatchingKey->unknown_key; JWSSignatureVerificationFailed->bad_signature;
 * JWSInvalid/JWTInvalid->malformed; JWKSTimeout or a fetch/parse error from the JWKS -> jwks_unavailable.
 * When the refetch fails but a previously loaded (stale) set exists, that set is used (§9: 503 only when
 * no usable set exists). Accepted edge (documented): after a JWKS reload, an unknown kid is not refetched for 30 s.
 */
export function createTokenVerifier(config: TokenVerifierConfig): TokenVerifier {
  const tolerance = config.clockToleranceSeconds;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > MAX_CLOCK_TOLERANCE_SECONDS) {
    throw new TypeError(
      `clockToleranceSeconds must be between 0 and ${MAX_CLOCK_TOLERANCE_SECONDS}`,
    );
  }
  const remote = createRemoteJWKSet(new URL(config.jwksUrl), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
    [customFetch]: (url, init) => config.fetch(url, init),
  });
  const policy: JWTVerifyOptions = {
    algorithms: [...ALGORITHMS],
    typ: TOKEN_TYPE,
    issuer: config.issuer,
    audience: config.resource,
    clockTolerance: tolerance,
    requiredClaims: REQUIRED_CLAIMS,
  };
  const fail = (failure: AuthFailure): VerifyResult => ({ ok: false, failure });

  return {
    async verify(token) {
      const header = precheckHeader(token);
      if (header) return fail(header);

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, remote, policy));
      } catch (err) {
        const failure = classify(err);
        const cached = failure.kind === "jwks_unavailable" ? remote.jwks() : undefined;
        if (!cached) return fail(failure);
        // Stale-but-present key set: verify locally rather than 503.
        try {
          ({ payload } = await jwtVerify(token, createLocalJWKSet(cached), policy));
        } catch (err2) {
          const f2 = classify(err2);
          return fail(f2.kind === "jwks_unavailable" ? failure : f2);
        }
      }

      // jose validates `iat` against the clock only under maxTokenAge; §8 wants it always.
      if (typeof payload.iat === "number" && payload.iat > Date.now() / 1000 + tolerance) {
        return fail(invalid("not_yet_valid"));
      }
      if ("cnf" in payload) return fail(invalid("dpop_bound"));
      try {
        return { ok: true, principal: principalFromClaims(payload, token, config.resource) };
      } catch (err) {
        if (err instanceof MalformedClaimsError)
          return fail({ kind: "invalid_token", reason: "malformed" });
        throw err;
      }
    },
  };
}

/**
 * docs/tokens.md §4/§6: `typ` and `alg` are checked BEFORE any key is touched,
 * and `kid` must be present. A garbage token never costs a JWKS request.
 */
function precheckHeader(token: string): AuthFailure | undefined {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return invalid("malformed");
  }
  if (typeof header.alg !== "string" || !ALGORITHMS.includes(header.alg))
    return invalid("wrong_algorithm");
  if (normalizeTyp(header.typ) !== TOKEN_TYPE) return invalid("wrong_type");
  if (typeof header.kid !== "string" || header.kid.length === 0) return invalid("malformed");
  return undefined;
}

/** RFC 9068 §2.1: `application/at+jwt` and `at+jwt` are equivalent. */
function normalizeTyp(typ: unknown): string | undefined {
  if (typeof typ !== "string") return undefined;
  const lower = typ.toLowerCase();
  return lower.startsWith("application/") ? lower.slice("application/".length) : lower;
}

function classify(err: unknown): AuthFailure {
  if (err instanceof errors.JWTExpired) return invalid("expired");
  if (err instanceof errors.JWTClaimValidationFailed) {
    switch (err.claim) {
      case "iss":
        return invalid("wrong_issuer");
      case "aud":
        return invalid("wrong_audience");
      case "nbf":
      case "iat":
        return invalid("not_yet_valid");
      case "typ":
        return invalid("wrong_type");
      default:
        return invalid("malformed");
    }
  }
  if (err instanceof errors.JOSEAlgNotAllowed) return invalid("wrong_algorithm");
  if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) {
    return invalid("unknown_key");
  }
  if (err instanceof errors.JWSSignatureVerificationFailed) return invalid("bad_signature");
  if (
    err instanceof errors.JWSInvalid ||
    err instanceof errors.JWTInvalid ||
    err instanceof errors.JOSENotSupported
  ) {
    return invalid("malformed");
  }
  // JWKSTimeout, JWKSInvalid, the generic "Expected 200 OK" / "Failed to parse" JOSEError, or the transport's own error.
  return { kind: "jwks_unavailable", cause: err };
}

function invalid(reason: InvalidTokenReason): AuthFailure {
  return { kind: "invalid_token", reason };
}

/**
 * Parses `Authorization`. Absent/empty -> missing_token. Scheme other than
 * Bearer (case-insensitive) — including DPoP — or an empty token -> malformed_authorization.
 * The token is the remainder, trimmed; a token containing whitespace is malformed.
 */
export function parseAuthorization(
  header: string | null,
): { readonly token: string } | { readonly failure: AuthFailure } {
  const value = header?.trim() ?? "";
  if (value.length === 0) return { failure: { kind: "missing_token" } };
  const match = /^(\S+)(?:\s+(.*))?$/s.exec(value);
  if (!match || match[1]!.toLowerCase() !== "bearer")
    return { failure: { kind: "malformed_authorization" } };
  const token = (match[2] ?? "").trim();
  if (token.length === 0 || /\s/.test(token))
    return { failure: { kind: "malformed_authorization" } };
  return { token };
}
