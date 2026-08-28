/**
 * Who is calling one of OUR routes (/auth/api/*). Two credentials are
 * accepted: the web session cookie, or a herkules access token for ANY
 * registry audience. The user-info API is deliberately not a registry
 * resource: it is an issuer-side facility for token holders, so a token that
 * proves "admitted member of herkules" is enough regardless of which service
 * it was minted for. Role is read from the token/row, never re-derived.
 *
 * Verification is local (jose against the jwt plugin's own key set via
 * auth.api.getJwks(), cached, refreshed on unknown kid) — the same rules as
 * docs/tokens.md except the audience check is "any registry URL". A banned
 * user is refused here even while holding a live 15-minute token: the one
 * place the JWT revocation gap can be closed, because the row is local.
 */
import type { JWTVerifyOptions } from "jose";
import { createLocalJWKSet, errors, jwtVerify } from "jose";

import type { Auth } from "./auth.ts";
import type { AuthDb } from "./db/index.ts";
import type { Registry } from "./registry.ts";
import type { Role } from "./users.ts";
import { roleOf } from "./users.ts";

export type Caller =
  | { readonly kind: "session"; readonly userId: string; readonly role: Role }
  | {
      readonly kind: "token";
      readonly userId: string;
      readonly role: Role;
      readonly clientId: string;
      readonly audiences: readonly string[];
      readonly jti: string;
    };

export type CallerOutcome =
  | { readonly ok: true; readonly caller: Caller }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly response: Response };

export interface Bearer {
  /**
   * Cookie first (a browser never sends both), then `Authorization: Bearer`.
   * `require.role` -> 403 without a challenge (docs/tokens.md §12.4).
   * A 401 for our API carries `WWW-Authenticate: Bearer` with NO resource_metadata:
   * there is no PRM for the user-info API and nothing should start an OAuth flow for it.
   */
  identify(request: Request, require?: { readonly role?: Role }): Promise<CallerOutcome>;
  /** Boot-time and rotation-time refresh of the local key set. */
  refreshKeys(): Promise<void>;
}

const KEYS_MAX_AGE_MS = 5 * 60_000;
const KEYS_COOLDOWN_MS = 30_000;

function json(
  status: 401 | 403 | 503,
  error: string,
  description: string,
  challenge?: string,
): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (challenge) headers.set("www-authenticate", challenge);
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers,
  });
}

export function createBearer(auth: Auth, registry: Registry, issuer: string, db: AuthDb): Bearer {
  let keySet: ReturnType<typeof createLocalJWKSet> | undefined;
  let fetchedAt = 0;

  const loadKeys = async (): Promise<ReturnType<typeof createLocalJWKSet>> => {
    keySet = createLocalJWKSet(await auth.api.getJwks());
    fetchedAt = Date.now();
    return keySet;
  };
  const keys = async () =>
    keySet && Date.now() - fetchedAt < KEYS_MAX_AGE_MS ? keySet : loadKeys();

  const policy: JWTVerifyOptions = {
    algorithms: ["EdDSA"],
    typ: "at+jwt",
    issuer,
    clockTolerance: 60,
    requiredClaims: ["sub", "aud", "exp", "iat", "jti"],
  };

  const fail = (
    status: 401 | 403 | 503,
    error: string,
    description: string,
    challenge?: string,
  ): CallerOutcome => ({
    ok: false,
    status,
    response: json(status, error, description, challenge),
  });
  const invalidToken = (description: string) =>
    fail(
      401,
      "invalid_token",
      description,
      `Bearer error="invalid_token", error_description="${description}"`,
    );

  const fromToken = async (token: string): Promise<CallerOutcome> => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, await keys(), policy));
    } catch (err) {
      if (err instanceof errors.JWKSNoMatchingKey && Date.now() - fetchedAt > KEYS_COOLDOWN_MS) {
        try {
          ({ payload } = await jwtVerify(token, await loadKeys(), policy));
        } catch {
          return invalidToken("invalid token");
        }
      } else {
        return invalidToken(err instanceof errors.JWTExpired ? "token expired" : "invalid token");
      }
    }
    const aud = payload.aud;
    if (!registry.hasKnownAudience(aud) || "cnf" in payload) return invalidToken("invalid token");
    let role: Role;
    try {
      role = roleOf(payload);
    } catch {
      return invalidToken("invalid token");
    }
    const clientId =
      typeof payload.client_id === "string"
        ? payload.client_id
        : typeof payload.azp === "string"
          ? payload.azp
          : undefined;
    if (!clientId || typeof payload.sub !== "string" || typeof payload.jti !== "string")
      return invalidToken("invalid token");
    const row = await db.users.byId(payload.sub);
    if (!row || row.banned) return fail(403, "account_disabled", "This account has been disabled.");
    return {
      ok: true,
      caller: {
        kind: "token",
        userId: payload.sub,
        role,
        clientId,
        audiences: typeof aud === "string" ? [aud] : (aud ?? []),
        jti: payload.jti,
      },
    };
  };

  const fromSession = async (request: Request): Promise<CallerOutcome | undefined> => {
    const result = await auth.api.getSession({ headers: request.headers });
    if (!result) return undefined;
    const user = result.user as Record<string, unknown>;
    if (user.banned === true)
      return fail(403, "account_disabled", "This account has been disabled.");
    let role: Role;
    try {
      role = roleOf(user);
    } catch {
      return fail(403, "forbidden", "account has no role");
    }
    return { ok: true, caller: { kind: "session", userId: result.user.id, role } };
  };

  return {
    async identify(request, require) {
      let outcome = await fromSession(request);
      if (!outcome) {
        const header = request.headers.get("authorization")?.trim() ?? "";
        const match = /^bearer\s+(\S+)$/i.exec(header);
        if (header.length === 0)
          outcome = fail(401, "invalid_token", "missing credentials", "Bearer");
        else if (!match) outcome = invalidToken("invalid authorization header");
        else outcome = await fromToken(match[1]!);
      }
      if (!outcome.ok) return outcome;
      if (require?.role === "admin" && outcome.caller.role !== "admin") {
        return fail(403, "forbidden", "requires role admin");
      }
      return outcome;
    },
    async refreshKeys() {
      await loadKeys();
    },
  };
}
