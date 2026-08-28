/**
 * @herkules/oauth-client — public core.
 *
 * A confidential OAuth 2.1 client for a first-party app on its own origin,
 * against the herkules issuer. Yields the SAME `Principal` that
 * @herkules/auth-middleware yields to bearer callers, because it is produced by
 * the same `ResourceAuth.verifyToken` the app already built. Tokens live in a
 * sealed cookie; there is no table.
 *
 * Module map (packages/oauth-client/src):
 *   index.ts    createOAuthClient + option validation. Public surface.
 *   seal.ts     AES-256-GCM over HKDF keys; purpose-bound, versioned. Pure.
 *   cookie.ts   what is in each cookie, names, attributes, codec. Only writer of Set-Cookie.
 *   issuer.ts   derived endpoints + token endpoint (exchange / refresh / revoke). Only network user besides JWKS.
 *   session.ts  authenticate(request): bearer-or-cookie, verify, refresh policy, single-flight. The brain.
 *   login.ts    /login, /callback, /logout as pure request → redirect functions.
 *   hono.ts     ./hono: honoOAuth(client) → { routes, viewer(), guard() }. Optional peer: hono.
 *   testing.ts  ./testing: createFakeIssuer — authorize + token + revoke + JWKS behind one fetch, with the real issuer's rotation policy.
 * Call chain for a request: hono → session → { cookie, issuer, auth.verifyToken }. Two hops.
 *
 * The one identity type is `Principal` from @herkules/auth-middleware; it is
 * not re-exported so there is one import path for it.
 */
import type { Requirement, ResourceAuth } from "@herkules/auth-middleware";

import { createCookieJar } from "./cookie.ts";
import { createIssuerClient, endpointsFor } from "./issuer.ts";
import type { LoginFailure, Redirect } from "./login.ts";
import { createLoginFlow } from "./login.ts";
import { MIN_SECRET_LENGTH, createSealer } from "./seal.ts";
import type { SessionEvent, SessionOutcome } from "./session.ts";
import { createSessionResolver } from "./session.ts";

export type { LoginFailure, LoginFailureCode, Redirect } from "./login.ts";
export type { AnonymousReason, SessionEvent, SessionFailure, SessionOutcome } from "./session.ts";

const CALLBACK_PATH = "/callback";
const SCOPE: readonly string[] = ["offline_access"]; // `openid` is filtered per resource by the issuer; asking would buy nothing
const MIN_CLIENT_SECRET_LENGTH = 16;

/**
 * Everything an adopter says. Five required fields, all of which already exist
 * in its config; nothing here names a cookie, a path, an endpoint or an algorithm.
 */
export interface OAuthClientOptions<S extends string = never> {
  /**
   * The resource server this app already declared with `apiResource(...)`: the single
   * source of `issuer`, `resource` (the audience requested at authorize time), JWKS policy,
   * clock tolerance, the verification `fetch`, and every failure Response this package returns.
   */
  readonly auth: ResourceAuth<S>;
  /** The confidential client seeded on the issuer (services/auth FIRST_PARTY_CLIENTS). Secret goes only into `Authorization: Basic`. */
  readonly client: { readonly id: string; readonly secret: string };
  /** This app's OWN public origin, e.g. https://bbs.herkules.dev (not the platform origin). Redirect URI = `${origin}/callback`; https selects `__Host-` + Secure cookies. */
  readonly origin: string;
  /** ≥ 32 characters. Seals both cookies (HKDF, salted with client.id). Rotating it signs every browser out — the emergency lever. */
  readonly cookieSecret: string;
  /** The issuer as reachable from this process for token/revoke calls, e.g. http://auth:3001/auth. Default `auth.issuer`. The browser always sees `auth.issuer`. */
  readonly issuerInternal?: string;
  /** Transport seam for the token and revoke calls. Default globalThis.fetch; tests pass `createFakeIssuer().fetch`. (JWKS fetch belongs to `auth`.) */
  readonly fetch?: typeof globalThis.fetch;
  /** Clock seam for the rotation memo, refresh-ahead and login-attempt expiry. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Observability seam. A library must not own a logger; every interesting transition is an event. */
  readonly onEvent?: (event: SessionEvent) => void;
}

/**
 * What the app holds. Framework-neutral: takes `Request`s and returns domain
 * values; ./hono binds it to routes and middleware. Construct once at boot (it
 * owns the derived cookie keys and the refresh single-flight table).
 */
export interface OAuthClient<S extends string = never> {
  /** The verifier every branch goes through. Use `auth.deny.*` in handlers; never build a second one for this audience. */
  readonly auth: ResourceAuth<S>;
  /** `${origin}/callback` — the exact string the issuer's seeded row must contain. Log it at boot. */
  readonly redirectUri: string;
  /**
   * One request in, one outcome out — for browsers AND bearer callers. Never throws for anything a
   * client sent. Apply `outcome.setCookie` whenever present, on success and failure alike.
   */
  authenticate(request: Request, require?: Requirement<S>): Promise<SessionOutcome>;
  beginLogin(request: Request): Promise<Redirect>;
  completeLogin(request: Request): Promise<Redirect | LoginFailure>;
  logout(request: Request): Promise<Redirect>;
}

function parseOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be an absolute URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${name} must be http(s), got ${JSON.stringify(raw)}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new TypeError(
      `${name} must be an origin with no path, query or fragment, got ${JSON.stringify(raw)}`,
    );
  }
  return url.origin;
}

/**
 * Boundary: validates every option once (TypeError naming the option, at boot,
 * never a per-request surprise) and wires the modules.
 * Checks: `origin` is an absolute http(s) URL that IS an origin (no path); `client.id` non-empty,
 * `client.secret` ≥ 16; `cookieSecret` ≥ 32; `issuerInternal` absolute when given.
 */
export function createOAuthClient<const S extends string = never>(
  options: OAuthClientOptions<S>,
): OAuthClient<S> {
  const { auth } = options;
  const origin = parseOrigin(options.origin, "origin");
  if (typeof options.client?.id !== "string" || options.client.id.length === 0) {
    throw new TypeError("client.id must be a non-empty string");
  }
  if (
    typeof options.client.secret !== "string" ||
    options.client.secret.length < MIN_CLIENT_SECRET_LENGTH
  ) {
    throw new TypeError(`client.secret must be at least ${MIN_CLIENT_SECRET_LENGTH} characters`);
  }
  if (typeof options.cookieSecret !== "string" || options.cookieSecret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`cookieSecret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (options.issuerInternal !== undefined) {
    let internal: URL | undefined;
    try {
      internal = new URL(options.issuerInternal);
    } catch {
      /* handled below */
    }
    if (!internal || (internal.protocol !== "http:" && internal.protocol !== "https:")) {
      throw new TypeError("issuerInternal must be an absolute http(s) URL");
    }
  }

  const now = options.now ?? (() => new Date());
  const onEvent = options.onEvent ?? (() => {});
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const secure = origin.startsWith("https:");
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  const endpoints = endpointsFor(auth.issuer, options.issuerInternal ?? auth.issuer);
  const jar = createCookieJar({
    sealer: createSealer(options.cookieSecret, options.client.id),
    secure,
    now,
  });
  const issuer = createIssuerClient({ endpoints, client: options.client, redirectUri, fetch });
  const session = createSessionResolver({ auth, issuer, jar, now, onEvent });
  const login = createLoginFlow({
    jar,
    issuer,
    endpoints,
    clientId: options.client.id,
    redirectUri,
    resource: auth.resource,
    scope: SCOPE,
    now,
    onEvent,
  });

  return {
    auth,
    redirectUri,
    authenticate: (request, require) => session.authenticate(request, require),
    beginLogin: (request) => login.begin(request),
    completeLogin: (request) => login.complete(request),
    logout: (request) => login.logout(request),
  };
}
