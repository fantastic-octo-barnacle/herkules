/**
 * Subpath `@herkules/oauth-client/hono`. Optional peer: hono.
 *
 * The adopter's whole surface: three routes and two middlewares. The binding
 * adds exactly what the core cannot do — mounting, applying Set-Cookie on
 * every branch, and the Env typing that makes "optional" and "required"
 * different TYPES rather than different code paths:
 *
 *   viewer()  contributes { principal?: Principal }   (ViewerEnv)
 *   guard()   contributes { principal:  Principal }   (AuthEnv, from auth-middleware)
 *
 * Both write the same context variable; Hono 4.13 intersects a route's
 * middleware Env into its handler (verified with a tsc probe, 2026-08-28), so
 * `new Hono<ViewerEnv>()` gives `Principal | undefined` in ordinary handlers and
 * `Principal` inside any route that lists `guard()`. A handler written against
 * `Principal` runs verbatim behind a cookie route, a bearer route and an MCP tool.
 *
 * Set-Cookie is written onto the final Response object, never through
 * `c.header()`: a handler that returns its own `new Response` would otherwise
 * drop a rotated refresh token, which breaks the refresh contract.
 */
import type { Principal, Requirement } from "@herkules/auth-middleware";
import type { AuthEnv } from "@herkules/auth-middleware/hono";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import type { OAuthClient } from "./index.ts";
import type { LoginFailure, Redirect } from "./login.ts";
import type { SessionOutcome } from "./session.ts";

export type { AuthEnv } from "@herkules/auth-middleware/hono";

/** Use as `new Hono<ViewerEnv>()`. `guard()` and `honoAuth()` narrow `principal` per route. */
export type ViewerEnv = { Variables: { principal?: Principal } };

export interface HonoOAuth<S extends string = never> {
  /**
   * `GET /login?next=`, `GET /callback`, `POST /logout`. Mount at "/" (`app.route("/", oauth.routes)`).
   * Paths are fixed because the issuer's seeded redirect URI is `${origin}/callback`.
   */
  readonly routes: Hono;
  /**
   * Resolve the caller and carry on regardless. Sets `principal` when signed in; `undefined` for
   * anonymous AND for `unavailable` (an issuer outage must not sign readers out or break anonymous
   * reads — the cookie is kept). A presented-but-invalid bearer is still a 401: explicit credential,
   * explicit failure. Mount broadly: `app.use("/api/*", oauth.viewer())`.
   */
  viewer(): MiddlewareHandler<ViewerEnv>;
  /**
   * Require a principal — cookie or bearer, whichever the caller brought — optionally with a role.
   * On failure returns the verifier's own response: 401 + challenge (anonymous), 403 (role/scope),
   * 503 (unavailable); bodies are auth-middleware's `{ error, error_description }`.
   * Cheap under `viewer()`: when `c.var.principal` is already set for this request only the
   * requirement is re-checked via `auth.verifyToken(principal.token, require)` — no second refresh.
   */
  guard(require?: Requirement<S>): MiddlewareHandler<AuthEnv>;
}

export interface HonoOAuthOptions {
  /** Render a failed callback. Default: `{ error, error_description }` JSON with the failure's status. bbs redirects to its own page. */
  readonly onLoginFailure?: (failure: LoginFailure, c: Context) => Response | Promise<Response>;
}

/** Append Set-Cookie values to a Response, re-creating it when its headers are immutable (`Response.redirect`). */
function withCookies(response: Response, cookies: readonly string[] | undefined): Response {
  if (!cookies || cookies.length === 0) return response;
  let target = response;
  try {
    target.headers.append("set-cookie", cookies[0]!);
  } catch {
    target = new Response(response.body, response);
    target.headers.append("set-cookie", cookies[0]!);
  }
  for (const cookie of cookies.slice(1)) target.headers.append("set-cookie", cookie);
  return target;
}

/** After `next()`: put the outcome's cookies on whatever response the handler produced. */
function appendCookies(c: Context, cookies: readonly string[] | undefined): void {
  if (!cookies || cookies.length === 0) return;
  const before = c.res;
  const after = withCookies(before, cookies);
  if (after !== before) c.res = after;
}

export function honoOAuth<S extends string = never>(
  client: OAuthClient<S>,
  options?: HonoOAuthOptions,
): HonoOAuth<S> {
  const send = (c: Context, r: Redirect): Response =>
    withCookies(c.redirect(r.location, 303), r.setCookie);

  const fail = async (c: Context, f: LoginFailure): Promise<Response> => {
    const rendered = options?.onLoginFailure
      ? await options.onLoginFailure(f, c)
      : c.json({ error: f.error, error_description: f.description ?? f.error }, f.status);
    return withCookies(rendered, f.setCookie);
  };

  const routes = new Hono()
    .get("/login", async (c) => send(c, await client.beginLogin(c.req.raw)))
    .get("/callback", async (c) => {
      const r = await client.completeLogin(c.req.raw);
      return "location" in r ? send(c, r) : fail(c, r);
    })
    .post("/logout", async (c) => send(c, await client.logout(c.req.raw)));

  /** A principal already resolved for this request: re-check only the requirement, through the same verifier. */
  const recheck = async (
    request: Request,
    existing: Principal,
    require: Requirement<S> | undefined,
  ): Promise<SessionOutcome> => {
    const v = await client.auth.verifyToken(existing.token, require);
    const via = request.headers.has("authorization") ? "bearer" : "cookie";
    if (v.ok) return { ok: true, principal: existing, via };
    return {
      ok: false,
      failure:
        v.failure.kind === "jwks_unavailable"
          ? { kind: "unavailable", cause: v.failure.cause }
          : { kind: "denied", failure: v.failure },
      response: v.response,
    };
  };

  return {
    routes,
    viewer: () => async (c, next) => {
      const o = await client.authenticate(c.req.raw);
      if (!o.ok && o.failure.kind === "denied") return withCookies(o.response, o.setCookie);
      if (o.ok) c.set("principal", o.principal);
      await next();
      appendCookies(c, o.setCookie);
    },
    guard: (require) => async (c, next) => {
      const existing = c.get("principal") as Principal | undefined;
      const o = existing
        ? await recheck(c.req.raw, existing, require)
        : await client.authenticate(c.req.raw, require);
      if (!o.ok) return withCookies(o.response, o.setCookie);
      c.set("principal", o.principal);
      await next();
      appendCookies(c, o.setCookie);
    },
  };
}
