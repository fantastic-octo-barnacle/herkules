/**
 * "Who is making this request." Owns the bearer-or-cookie rule, verification
 * through the app's ResourceAuth, the refresh policy and the refresh
 * single-flight. The module a reader opens to learn the lifecycle of a
 * browser session. It never renders a Response of its own: every failure is
 * rendered by the app's ResourceAuth so browsers and bearer callers get one
 * `{ error, error_description }` style and the SPA's ApiError needs no new case.
 */
import type { AuthFailure, Principal, Requirement, ResourceAuth } from "@herkules/auth-middleware";

import type { CookieJar } from "./cookie.ts";
import type { GrantResult, IssuerClient } from "./issuer.ts";

export type AnonymousReason =
  /** No session cookie and no Authorization header. */
  | "no_cookie"
  /** Cookie present but unsealable / malformed / not for this audience. Cleared. */
  | "bad_cookie"
  /** The issuer rejected the refresh (revoked, replayed late, gate failed). Cleared. */
  | "signed_out"
  /** Cookie auth on a non-GET request the browser marked `Sec-Fetch-Site: cross-site`. Not cleared. */
  | "cross_site";

/**
 * Closed set, layered on auth-middleware's AuthFailure rather than extending it:
 *  anonymous   nobody — 401 under guard, `undefined` under viewer
 *  denied      somebody, but not enough (role/scope), or a presented bearer the verifier refused — the verifier's own failure, verbatim
 *  unavailable cannot say (JWKS or token endpoint down, or OUR client secret is wrong) — 503 under guard; keep the cookie
 */
export type SessionFailure =
  | { readonly kind: "anonymous"; readonly reason: AnonymousReason }
  | { readonly kind: "denied"; readonly failure: AuthFailure }
  | { readonly kind: "unavailable"; readonly cause: unknown };

/**
 * `setCookie` is present whenever the cookie must change: rotated tokens on
 * success, a clear on bad/revoked cookies. A transport that drops it breaks
 * the refresh contract (the browser would re-present a rotated-away refresh
 * token), so hono.ts applies it on every branch before anything else.
 */
export type SessionOutcome =
  | {
      readonly ok: true;
      readonly principal: Principal;
      readonly via: "cookie" | "bearer";
      readonly setCookie?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: SessionFailure;
      readonly response: Response;
      readonly setCookie?: readonly string[];
    };

export type SessionEvent =
  | { readonly kind: "refreshed"; readonly subject: string; readonly fromMemo: boolean }
  | { readonly kind: "signed_out"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly cause: unknown }
  /** Our client credentials were refused. Always a deployment bug; log loudly. */
  | { readonly kind: "client_auth_failed"; readonly description?: string }
  | { readonly kind: "login_started" }
  | { readonly kind: "login_completed"; readonly subject: string }
  | { readonly kind: "login_failed"; readonly error: string };

export interface SessionResolver<S extends string> {
  authenticate(request: Request, require?: Requirement<S>): Promise<SessionOutcome>;
}

export interface SessionResolverOptions<S extends string> {
  readonly auth: ResourceAuth<S>;
  readonly issuer: IssuerClient;
  readonly jar: CookieJar;
  readonly now: () => Date;
  readonly onEvent: (event: SessionEvent) => void;
}

/**
 * Refresh when the verified token expires within this many seconds. Equals the
 * verifier's default clock tolerance: a token we serve is never one that
 * another resource server (user-info API, forwarded `principal.token`) would
 * reject moments later. Derived from the verified `expiresAt`, never stored.
 */
export const REFRESH_AHEAD_SECONDS = 60;

/**
 * Must equal the issuer's `refreshTokenReuseInterval` (30 s, services/auth/src/auth.ts).
 * Within it the issuer replays; beyond it a re-presented refresh token kills the family.
 * Deliberately NOT an option: it is the issuer's number, and a longer memo would let a
 * stolen stale cookie ride a fresh session longer than the issuer intends.
 */
export const REPLAY_WINDOW_SECONDS = 30;

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * authenticate(request, require):
 *  1. `Authorization` header present → auth.authenticate(request, require) mapped to SessionOutcome (via "bearer").
 *     A presented credential is authoritative: the cookie is not consulted, and a bearer the verifier
 *     refuses is `denied` (the verifier's outcome verbatim, 503 included), never anonymous — an explicit
 *     credential gets an explicit answer. The cookie is neither read nor rewritten, so an agent's
 *     request can never mutate a browser's session.
 *  2. jar.readSession: absent → anonymous/no_cookie (no setCookie: clearing on every anonymous GET would churn
 *     headers); invalid → anonymous/bad_cookie + clearSession.
 *  3. Cross-site guard: method ∉ {GET, HEAD, OPTIONS} and `Sec-Fetch-Site: cross-site` → anonymous/cross_site.
 *     Defense in depth over SameSite=Lax; cookie untouched.
 *  4. v = auth.verifyToken(accessToken, require):
 *       ok, expiresAt − now > REFRESH_AHEAD → { ok, principal, via: "cookie" }
 *       ok but near expiry                  → step 5 with `fallback = v.principal`
 *       invalid_token/expired               → step 5, no fallback
 *       forbidden | insufficient_scope      → denied (identity fine, requirement failed); no refresh, no cookie change
 *       jwks_unavailable                    → unavailable; keep cookie
 *       anything else (bad_signature, wrong_audience, malformed, …) → not our cookie → anonymous/bad_cookie + clear
 *  5. r = coordinator.refresh(refreshToken)   (single-flight per token value; memo for REPLAY_WINDOW_SECONDS)
 *       tokens      → v2 = auth.verifyToken(new access, require); ok → { ok, principal, setCookie: [writeSession] }
 *                     forbidden/scope → denied + setCookie (the rotation happened; persist it)
 *                     other → unavailable + setCookie (a fresh token that does not verify is a JWKS/clock problem)
 *       rejected    → anonymous/signed_out + clearSession; event signed_out
 *       client_auth → event client_auth_failed; unavailable; keep cookie (the USER did nothing wrong)
 *       unavailable → fallback ? { ok, principal: fallback } (graceful: still inside tolerance) : unavailable; keep cookie
 *  Rendering of the failure branch: anonymous → auth's `missing_token` response (401 + challenge);
 *  denied → the verifier's own response; unavailable → auth.deny.unavailable(cause) (503).
 */
export function createSessionResolver<S extends string>(
  options: SessionResolverOptions<S>,
): SessionResolver<S> {
  const { auth, jar, now, onEvent } = options;
  const coordinator = createRefreshCoordinator(options.issuer, now);

  const failure = (
    f: SessionFailure,
    response: Response,
    setCookie?: readonly string[],
  ): SessionOutcome => ({ ok: false, failure: f, response, ...(setCookie ? { setCookie } : {}) });

  /** The cookie branch has no Authorization header, so the verifier renders exactly `missing_token`. */
  const anonymous = async (
    request: Request,
    reason: AnonymousReason,
    setCookie?: readonly string[],
  ): Promise<SessionOutcome> => {
    const rendered = await auth.authenticate(request);
    const response = rendered.ok ? new Response(null, { status: 401 }) : rendered.response;
    return failure({ kind: "anonymous", reason }, response, setCookie);
  };

  const unavailable = (cause: unknown, setCookie?: readonly string[]): SessionOutcome => {
    onEvent({ kind: "unavailable", cause });
    return failure({ kind: "unavailable", cause }, auth.deny.unavailable(cause), setCookie);
  };

  return {
    async authenticate(request, require) {
      if (request.headers.has("authorization")) {
        const o = await auth.authenticate(request, require);
        return o.ok
          ? { ok: true, principal: o.principal, via: "bearer" }
          : failure({ kind: "denied", failure: o.failure }, o.response);
      }

      const read = await jar.readSession(request);
      if (read.kind === "absent") return anonymous(request, "no_cookie");
      if (read.kind === "invalid") return anonymous(request, "bad_cookie", [jar.clearSession()]);
      if (
        !SAFE_METHODS.has(request.method.toUpperCase()) &&
        request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
      ) {
        return anonymous(request, "cross_site");
      }

      const { accessToken, refreshToken } = read.value;
      const v = await auth.verifyToken(accessToken, require);
      let fallback: Principal | undefined;
      if (v.ok) {
        const secondsLeft = (v.principal.expiresAt.getTime() - now().getTime()) / 1000;
        if (secondsLeft > REFRESH_AHEAD_SECONDS) {
          return { ok: true, principal: v.principal, via: "cookie" };
        }
        fallback = v.principal;
      } else {
        switch (v.failure.kind) {
          case "invalid_token":
            if (v.failure.reason !== "expired") {
              return anonymous(request, "bad_cookie", [jar.clearSession()]);
            }
            break; // expired: refresh below
          case "forbidden":
          case "insufficient_scope":
            return failure({ kind: "denied", failure: v.failure }, v.response);
          case "jwks_unavailable":
            return unavailable(v.failure.cause);
          default:
            return anonymous(request, "bad_cookie", [jar.clearSession()]);
        }
      }

      const { result, fromMemo } = await coordinator.refresh(refreshToken);
      switch (result.kind) {
        case "tokens": {
          const setCookie = [await jar.writeSession(result.tokens)];
          const v2 = await auth.verifyToken(result.tokens.accessToken, require);
          if (v2.ok) {
            onEvent({ kind: "refreshed", subject: v2.principal.subject, fromMemo });
            return { ok: true, principal: v2.principal, via: "cookie", setCookie };
          }
          if (v2.failure.kind === "forbidden" || v2.failure.kind === "insufficient_scope") {
            return failure({ kind: "denied", failure: v2.failure }, v2.response, setCookie);
          }
          return unavailable(v2.failure, setCookie);
        }
        case "rejected":
          onEvent({ kind: "signed_out", reason: result.error });
          return anonymous(request, "signed_out", [jar.clearSession()]);
        case "client_auth":
          onEvent({
            kind: "client_auth_failed",
            ...(result.description ? { description: result.description } : {}),
          });
          return unavailable(new Error("client credentials refused by the issuer"));
        case "unavailable":
          if (fallback) return { ok: true, principal: fallback, via: "cookie" };
          return unavailable(result.cause);
      }
    },
  };
}

/** What `refresh` answers: the issuer's result, and whether it was served without a new issuer call. */
export interface RefreshAnswer {
  readonly result: GrantResult;
  /** True when answered from the replay memo or by joining an in-flight call for the same token. */
  readonly fromMemo: boolean;
}

export interface RefreshCoordinator {
  /** At most one issuer call per distinct refresh-token value at a time, and at most one per value per replay window. */
  refresh(refreshToken: string): Promise<RefreshAnswer>;
  /** Live entries; tests assert it stays bounded. */
  readonly size: number;
}

/**
 * Keyed on the refresh-token VALUE — exactly the identity of "the thing that may
 * be spent once". `inflight` shares one HTTP call among concurrent presenters
 * (ten tabs, one token request). `memo` remembers a successful rotation for the
 * replay window: a request whose cookie predates our Set-Cookie is answered from
 * memory, never re-presented to the issuer. Only successes are memoised —
 * `unavailable` must be retried, `rejected` never comes back (cookie cleared).
 * Idempotent in the token value; per-process by design (one replica, FRAME);
 * crash mid-refresh leaves the browser with the old cookie and the issuer's own
 * replay window as the safety net. Entries are swept lazily; bounded by
 * refreshes per 30 s.
 */
export function createRefreshCoordinator(
  issuer: IssuerClient,
  now: () => Date,
): RefreshCoordinator {
  const inflight = new Map<string, Promise<GrantResult>>();
  const memo = new Map<string, { readonly result: GrantResult; readonly expiresAt: number }>();

  const sweep = () => {
    const t = now().getTime();
    for (const [key, entry] of memo) if (entry.expiresAt <= t) memo.delete(key);
  };

  return {
    async refresh(refreshToken) {
      sweep();
      const remembered = memo.get(refreshToken);
      if (remembered) return { result: remembered.result, fromMemo: true };
      const running = inflight.get(refreshToken);
      if (running) return { result: await running, fromMemo: true };
      const call = issuer
        .refresh(refreshToken)
        .then((result) => {
          if (result.kind === "tokens") {
            memo.set(refreshToken, {
              result,
              expiresAt: now().getTime() + REPLAY_WINDOW_SECONDS * 1000,
            });
          }
          return result;
        })
        .finally(() => inflight.delete(refreshToken));
      inflight.set(refreshToken, call);
      return { result: await call, fromMemo: false };
    },
    get size() {
      sweep();
      return inflight.size + memo.size;
    },
  };
}
