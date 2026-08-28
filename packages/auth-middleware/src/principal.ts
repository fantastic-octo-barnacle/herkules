/**
 * Owns the domain view of a verified token: the `Principal` type and the one
 * place a verified-but-untyped claim set becomes it. Mirrors docs/tokens.md
 * §5 (claims) and §10 (identity). Pure: no clock, no I/O, no jose.
 */

/** Closed set. A Role can never be passed where a scope is expected. */
export type Role = "admin" | "member";

const ROLE_RANK: Readonly<Record<Role, number>> = { member: 0, admin: 1 };

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "member";
}

/** `admin` outranks `member`: `roleSatisfies("admin", "member")` is true. */
export function roleSatisfies(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/**
 * What a resource server knows about the caller after a token verified.
 *
 * Invariants: every field was checked in `principalFromClaims`; `subject` is
 * the only value a server may key storage on; `expiresAt` was in the future
 * (within clock tolerance) at verification time.
 */
export interface Principal {
  /** `sub`. Opaque, stable user id. Key per-user storage on this and nothing else. */
  readonly subject: string;
  /** `role`. Required in v1: a token without it is rejected as `invalid_token`. */
  readonly role: Role;
  /** `client_id`. Which registered client (IDE, script) obtained the token. Audit only. */
  readonly clientId: string;
  /** This server's canonical resource URL, confirmed present in `aud`. Not the raw claim. */
  readonly resource: string;
  /** `scope`, space-split. Empty in v1. A Set because the only access pattern is membership. */
  readonly scopes: ReadonlySet<string>;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** `jti`. Audit correlation only, never a storage key. */
  readonly tokenId: string;
  /** `sid`, when the token is tied to a browser session at the issuer. */
  readonly sessionId?: string;
  /** Raw compact JWS as presented. Needed for the MCP SDK's AuthInfo and to call the user-info API on the caller's behalf. */
  readonly token: string;
  /** Every verified claim, unmodified. Read-only escape hatch for claims not yet promoted to a field. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/**
 * Thrown by `principalFromClaims` when a required claim is missing or has the
 * wrong shape. Internal: verify.ts maps it to `invalid_token` / `malformed`.
 * Never carries claim values, so it cannot leak a token into a log.
 */
export class MalformedClaimsError extends Error {
  readonly claim: string;
  constructor(claim: string) {
    super(`malformed access token: claim ${claim}`);
    this.name = "MalformedClaimsError";
    this.claim = claim;
  }
}

/** RFC 6749 §3.3 scope-token: 1*( %x21 / %x23-5B / %x5D-7E ). */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * Boundary: verified claims in, Principal out. Called only after jose has
 * checked signature, `typ`, `iss`, `aud`, `exp`; this asserts shape, not
 * authenticity. `resource` is the verifier's own; `aud` is re-checked here
 * (string equals, or array contains) so the audience rule has one home.
 */
export function principalFromClaims(
  claims: Readonly<Record<string, unknown>>,
  token: string,
  resource: string,
): Principal {
  const subject = nonEmptyString(claims.sub, "sub");
  const aud = claims.aud;
  const audienceOk =
    typeof aud === "string" ? aud === resource : Array.isArray(aud) && aud.includes(resource);
  if (!audienceOk) throw new MalformedClaimsError("aud");
  const role = claims.role;
  if (!isRole(role)) throw new MalformedClaimsError("role");
  const clientId = nonEmptyString(claims.client_id ?? claims.azp, "client_id");
  const tokenId = nonEmptyString(claims.jti, "jti");
  const issuedAt = seconds(claims.iat, "iat");
  const expiresAt = seconds(claims.exp, "exp");
  const scopes = parseScope(claims.scope);
  const sid = claims.sid;
  if (sid !== undefined && typeof sid !== "string") throw new MalformedClaimsError("sid");

  const principal: Principal = {
    subject,
    role,
    clientId,
    resource,
    scopes,
    issuedAt,
    expiresAt,
    tokenId,
    ...(sid === undefined ? {} : { sessionId: sid }),
    token,
    claims: Object.freeze({ ...claims }),
  };
  return Object.freeze(principal);
}

function nonEmptyString(value: unknown, claim: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MalformedClaimsError(claim);
  return value;
}

function seconds(value: unknown, claim: string): Date {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MalformedClaimsError(claim);
  return new Date(value * 1000);
}

function parseScope(value: unknown): ReadonlySet<string> {
  if (value === undefined || value === "") return new Set();
  if (typeof value !== "string") throw new MalformedClaimsError("scope");
  const parts = value.split(" ");
  for (const part of parts) {
    if (!SCOPE_TOKEN.test(part)) throw new MalformedClaimsError("scope");
  }
  return new Set(parts);
}
