/**
 * /login, /callback, /logout as pure `Request → Redirect | LoginFailure`
 * functions. No framework, no Response: hono.ts turns these into 303s and
 * appends the Set-Cookie strings. Owns PKCE, `state`, the authorize query,
 * the safe-`next` rule and the callback validation order.
 */
import type { CookieJar, LoginAttempt, SafePath } from "./cookie.ts";
import { safePath } from "./cookie.ts";
import type { Endpoints, IssuerClient } from "./issuer.ts";
import type { SessionEvent } from "./session.ts";

export interface Redirect {
  readonly location: SafePath | string; // string only for the issuer's authorize URL
  readonly setCookie: readonly string[];
}

export type LoginFailureCode =
  | "invalid_state"
  | "invalid_request"
  | "invalid_grant"
  | "client_auth"
  | "unavailable"
  | (string & {});

/** Rendered as `{ error, error_description }` with `status` unless the adopter supplies `onLoginFailure`. */
export interface LoginFailure {
  readonly status: 400 | 502 | 503;
  /**
   * `invalid_state` (unknown/expired/replayed attempt) | `invalid_request` (no code) |
   * `invalid_grant` (exchange refused) | `client_auth` (502: our credentials) |
   * `unavailable` (503) | the issuer's own authorize error (`access_denied`, …), which is
   * why the union stays open (`string & {}`) while the known codes stay literal for adopters'
   * message tables.
   */
  readonly error: LoginFailureCode;
  readonly description?: string;
  readonly setCookie: readonly string[];
}

export interface LoginFlow {
  /**
   * GET /login?next=: mint `state` + PKCE verifier, push a LoginAttempt (newest first, capped),
   * redirect to `endpoints.authorize` with response_type=code, client_id, redirect_uri, resource,
   * scope=offline_access, state, code_challenge (S256). Always bounces through the issuer, even with
   * a live session: one silent round trip with skipConsent + SSO, and no local "am I signed in" logic.
   */
  begin(request: Request): Promise<Redirect>;
  /**
   * GET /callback?code&state | ?error: find the attempt by `state` (missing/expired → invalid_state);
   * remove it and rewrite the login cookie; `error` param → that error; exchange(code, verifier);
   * tokens → write session cookie, redirect to attempt.next; rejected → invalid_grant; client_auth → 502;
   * unavailable → 503. Never trusts anything from the URL but `code`, `state`, `error`.
   */
  complete(request: Request): Promise<Redirect | LoginFailure>;
  /**
   * POST /logout: best-effort revoke of the cookie's refresh token, clear both cookies, redirect to
   * safePath(`next` from form body or query). Idempotent: no cookie is still a logout. POST-only
   * because a GET link would be cross-site triggerable under SameSite=Lax.
   */
  logout(request: Request): Promise<Redirect>;
}

export interface LoginFlowOptions {
  readonly jar: CookieJar;
  readonly issuer: IssuerClient;
  readonly endpoints: Endpoints;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scope: readonly string[];
  readonly now: () => Date;
  readonly onEvent: (event: SessionEvent) => void;
}

const randomUrlSafe = (bytes: number): string =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

/** RFC 7636 S256: base64url(SHA-256(ascii(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

/**
 * The `sub` of an access token the issuer just handed us over an authenticated
 * channel, for the login_completed EVENT only. Not a verification: the session
 * resolver verifies the token on the next request, through the app's ResourceAuth.
 */
export function unverifiedSubject(accessToken: string): string {
  try {
    const payload = accessToken.split(".")[1] ?? "";
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof json.sub === "string" && json.sub.length > 0 ? json.sub : "unknown";
  } catch {
    return "unknown";
  }
}

async function nextFromBody(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  try {
    const form = new URLSearchParams(await request.clone().text());
    return form.get("next");
  } catch {
    return null;
  }
}

export function createLoginFlow(options: LoginFlowOptions): LoginFlow {
  const { jar, issuer, endpoints, now, onEvent } = options;

  const attemptsOf = async (request: Request): Promise<readonly LoginAttempt[]> => {
    const r = await jar.readLogin(request);
    return r.kind === "present" ? r.value.attempts : [];
  };

  const fail = (
    status: LoginFailure["status"],
    error: string,
    description: string | undefined,
    setCookie: readonly string[],
  ): LoginFailure => {
    onEvent({ kind: "login_failed", error });
    return { status, error, ...(description ? { description } : {}), setCookie };
  };

  return {
    async begin(request) {
      const url = new URL(request.url);
      const attempt: LoginAttempt = {
        state: randomUrlSafe(16),
        codeVerifier: randomUrlSafe(32),
        next: safePath(url.searchParams.get("next")),
        issuedAt: now().getTime(),
      };
      const attempts = [attempt, ...(await attemptsOf(request))];
      const setCookie = [await jar.writeLogin({ attempts })];

      const authorize = new URL(endpoints.authorize);
      const q = authorize.searchParams;
      q.set("response_type", "code");
      q.set("client_id", options.clientId);
      q.set("redirect_uri", options.redirectUri);
      q.set("resource", options.resource);
      q.set("scope", options.scope.join(" "));
      q.set("state", attempt.state);
      q.set("code_challenge", await pkceChallenge(attempt.codeVerifier));
      q.set("code_challenge_method", "S256");
      onEvent({ kind: "login_started" });
      return { location: authorize.toString(), setCookie };
    },

    async complete(request) {
      const url = new URL(request.url);
      const state = url.searchParams.get("state");
      const attempts = await attemptsOf(request);
      const attempt = state ? attempts.find((a) => a.state === state) : undefined;
      if (!attempt) {
        return fail(400, "invalid_state", "no matching login attempt (expired or replayed)", []);
      }
      const remaining = attempts.filter((a) => a !== attempt);
      const loginCookie =
        remaining.length > 0 ? await jar.writeLogin({ attempts: remaining }) : jar.clearLogin();

      const error = url.searchParams.get("error");
      if (error) {
        return fail(400, error, url.searchParams.get("error_description") ?? undefined, [
          loginCookie,
        ]);
      }
      const code = url.searchParams.get("code");
      if (!code) return fail(400, "invalid_request", "callback without code", [loginCookie]);

      const r = await issuer.exchange(code, attempt.codeVerifier);
      switch (r.kind) {
        case "tokens": {
          const setCookie = [await jar.writeSession(r.tokens), loginCookie];
          onEvent({ kind: "login_completed", subject: unverifiedSubject(r.tokens.accessToken) });
          return { location: attempt.next, setCookie };
        }
        case "rejected":
          return fail(400, r.error, r.description, [loginCookie]);
        case "client_auth":
          onEvent({
            kind: "client_auth_failed",
            ...(r.description ? { description: r.description } : {}),
          });
          return fail(502, "client_auth", "the app's client credentials were refused", [
            loginCookie,
          ]);
        case "unavailable":
          onEvent({ kind: "unavailable", cause: r.cause });
          return fail(503, "unavailable", "the sign-in service is unreachable", [loginCookie]);
      }
    },

    async logout(request) {
      const read = await jar.readSession(request);
      if (read.kind === "present") await issuer.revoke(read.value.refreshToken);
      const next = (await nextFromBody(request)) ?? new URL(request.url).searchParams.get("next");
      onEvent({ kind: "signed_out", reason: "logout" });
      return { location: safePath(next), setCookie: [jar.clearSession(), jar.clearLogin()] };
    },
  };
}
