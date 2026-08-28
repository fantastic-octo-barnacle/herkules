/**
 * Owns the closed set of ways a request fails to yield a principal. No HTTP
 * knowledge here; challenge.ts switches exhaustively on `kind` to render.
 */

export type InvalidTokenReason =
  | "expired"
  | "not_yet_valid"
  | "bad_signature"
  | "unknown_key"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_type" // header typ !== "at+jwt"
  | "wrong_algorithm" // alg not in the pinned set (EdDSA)
  | "dpop_bound" // cnf present or DPoP scheme used; v1 refuses
  | "malformed"; // undecodable, or a required claim missing/mistyped

/**
 * Closed union. The two 403s are separate members so the "challenge or not"
 * decision is made once, in challenge.ts:
 * - `insufficient_scope`: re-authorizing with more scopes fixes it -> challenge.
 * - `forbidden`: re-authorizing cannot fix it -> NO challenge (a challenge
 *   would march the user through consent for authority the AS will never grant).
 * `jwks_unavailable` is a 503, never a 401: a 401 during an auth-service outage
 * sends every connected IDE client back through consent at once.
 */
export type AuthFailure =
  | { readonly kind: "missing_token" }
  | { readonly kind: "malformed_authorization" }
  | { readonly kind: "invalid_token"; readonly reason: InvalidTokenReason }
  | { readonly kind: "insufficient_scope"; readonly missing: readonly [string, ...string[]] }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "jwks_unavailable"; readonly cause: unknown };
