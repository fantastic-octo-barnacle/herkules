/**
 * /login, /callback and /logout through the Hono routes against the fake
 * issuer: the authorize request we build, multi-tab logins, the bounded
 * attempt list, state/replay/expiry failures, the failure hook, and logout.
 */
import { describe, expect, test } from "vite-plus/test";
import { absorbCookies } from "../src/testing.ts";
import {
  CLIENT,
  cookieValue,
  createClock,
  ISSUER,
  isCleared,
  ORIGIN,
  request,
  RESOURCE,
  setup,
  type Setup,
} from "./helpers.ts";

/** GET /login and drive the fake's authorize: returns the callback URL and the login cookie to present. */
async function begin(t: Setup, next = "/", cookie = "") {
  const start = await t.app.request(request(`/login?next=${encodeURIComponent(next)}`, { cookie }));
  expect(start.status).toBe(303);
  const authorize = new URL(start.headers.get("location")!);
  const loginCookie = absorbCookies(cookie, start);
  const authz = await t.fake.fetch(authorize.toString());
  return { authorize, loginCookie, callback: authz.headers.get("location")! };
}

describe("GET /login", () => {
  test("redirects to the issuer's authorize endpoint with PKCE, resource and offline_access; sets the login cookie", async () => {
    const t = await setup();
    const start = await t.app.request(request("/login?next=/threads/1"));
    expect(start.status).toBe(303);
    const url = new URL(start.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth2/authorize`);
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      response_type: "code",
      client_id: CLIENT.id,
      redirect_uri: `${t.origin}/callback`,
      resource: RESOURCE,
      scope: "offline_access",
      code_challenge_method: "S256",
    });
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [setCookie] = start.headers.getSetCookie();
    expect(setCookie).toMatch(/^__Host-hk_login=v1\./);
    expect(setCookie).toContain("; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure");
    expect(t.events).toEqual([{ kind: "login_started" }]);
  });

  test("an http origin uses unprefixed, non-Secure cookies (local dev)", async () => {
    const t = await setup({ origin: "http://localhost:3003" });
    const start = await t.app.request(request("/login", undefined, "http://localhost:3003"));
    const [setCookie] = start.headers.getSetCookie();
    expect(setCookie).toMatch(/^hk_login=v1\./);
    expect(setCookie).not.toContain("Secure");
  });
});

describe("GET /callback", () => {
  test("completes the login: session cookie set, login cookie cleared, redirect to next", async () => {
    const t = await setup();
    const { cookie, location } = await t.fake.signIn(t.app, { subject: "u1", next: "/threads/1" });
    expect(location).toBe("/threads/1");
    expect(cookie).toMatch(/^__Host-hk_session=v1\./);
    expect(cookie).not.toContain("hk_login");
    expect(t.events).toContainEqual({ kind: "login_completed", subject: "u1" });
    const me = await t.app.request(request("/api/me", { cookie }));
    expect(await me.json()).toMatchObject({ subject: "u1", role: "member" });
  });

  test("a next that is not a same-origin path is replaced by /", async () => {
    const t = await setup();
    const { location } = await t.fake.signIn(t.app, { subject: "u1", next: "//evil.example/x" });
    expect(location).toBe("/");
  });

  test("unknown state, replayed callback and a missing login cookie all fail locally with invalid_state", async () => {
    const t = await setup();
    const { loginCookie, callback } = await begin(t);
    const noCookie = await t.app.request(callback);
    expect(noCookie.status).toBe(400);
    expect(await noCookie.json()).toMatchObject({ error: "invalid_state" });
    const ok = await t.app.request(callback, { headers: { cookie: loginCookie } });
    expect(ok.status).toBe(303);
    // The browser applied the cleared login cookie: a replayed callback has no attempt to match.
    const replay = await t.app.request(callback, {
      headers: { cookie: absorbCookies(loginCookie, ok) },
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_state" });
    expect(t.fake.grants).toHaveLength(1); // the replay never reached the issuer
    // A browser that somehow re-presents the consumed attempt is refused by the issuer instead.
    const stale = await t.app.request(callback, { headers: { cookie: loginCookie } });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("two tabs: both logins complete, in either order", async () => {
    const t = await setup();
    const first = await begin(t, "/a");
    const second = await begin(t, "/b", first.loginCookie); // carries the first attempt along
    const doneSecond = await t.app.request(second.callback, {
      headers: { cookie: second.loginCookie },
    });
    expect(doneSecond.status).toBe(303);
    expect(doneSecond.headers.get("location")).toBe("/b");
    const afterSecond = absorbCookies(second.loginCookie, doneSecond);
    expect(afterSecond).toContain("hk_login="); // the first attempt is still pending
    const doneFirst = await t.app.request(first.callback, { headers: { cookie: afterSecond } });
    expect(doneFirst.status).toBe(303);
    expect(doneFirst.headers.get("location")).toBe("/a");
    expect(absorbCookies(afterSecond, doneFirst)).not.toContain("hk_login=");
  });

  test("more than three pending logins: the oldest is dropped", async () => {
    const t = await setup();
    const a = await begin(t, "/a");
    const b = await begin(t, "/b", a.loginCookie);
    const c = await begin(t, "/c", b.loginCookie);
    const d = await begin(t, "/d", c.loginCookie);
    const oldest = await t.app.request(a.callback, { headers: { cookie: d.loginCookie } });
    expect(oldest.status).toBe(400);
    const newest = await t.app.request(d.callback, { headers: { cookie: d.loginCookie } });
    expect(newest.status).toBe(303);
  });

  test("an attempt older than ten minutes is gone", async () => {
    const clock = createClock();
    const t = await setup({ clock });
    const { loginCookie, callback } = await begin(t);
    clock.advance(11 * 60);
    const res = await t.app.request(callback, { headers: { cookie: loginCookie } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_state" });
  });

  test("the issuer's error is surfaced as a 400 and the attempt is consumed", async () => {
    const t = await setup();
    const { authorize, loginCookie } = await begin(t);
    const state = authorize.searchParams.get("state")!;
    const res = await t.app.request(
      request(`/callback?error=access_denied&error_description=nope&state=${state}`, {
        cookie: loginCookie,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "access_denied", error_description: "nope" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-hk_login=;"))).toBe(true);
    expect(t.events).toContainEqual({ kind: "login_failed", error: "access_denied" });
  });

  test("a bad code is invalid_grant; our wrong secret is a 502; the issuer down is a 503", async () => {
    const t = await setup();
    const { loginCookie, callback } = await begin(t);
    const forged = callback.replace(/code=[^&]+/, "code=forged");
    const bad = await t.app.request(forged, { headers: { cookie: loginCookie } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_grant" });

    const wrong = await setup({ clientSecret: "w".repeat(32) });
    const w = await begin(wrong);
    const refused = await wrong.app.request(w.callback, { headers: { cookie: w.loginCookie } });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: "client_auth" });
    expect(wrong.events.some((e) => e.kind === "client_auth_failed")).toBe(true);

    const down = await setup();
    const d = await begin(down);
    down.network.down = true;
    const unavailable = await down.app.request(d.callback, { headers: { cookie: d.loginCookie } });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: "unavailable" });
  });

  test("onLoginFailure renders the failure the app's way; cookies still land", async () => {
    const t = await setup({
      hono: {
        onLoginFailure: (f, c) => c.redirect(`/login-failed?error=${f.error}`, 303),
      },
    });
    const res = await t.app.request(request("/callback?state=nope&code=x"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login-failed?error=invalid_state");
    const raw = await setup({
      hono: { onLoginFailure: () => Response.redirect(`${ORIGIN}/oops`, 303) },
    });
    const { authorize, loginCookie } = await begin(raw);
    const state = authorize.searchParams.get("state")!;
    const res2 = await raw.app.request(
      request(`/callback?error=access_denied&state=${state}`, { cookie: loginCookie }),
    );
    expect(res2.status).toBe(303);
    // Response.redirect has immutable headers: the binding re-creates it rather than dropping the cookie.
    expect(res2.headers.getSetCookie().some((c) => isCleared(c))).toBe(true);
  });
});

describe("POST /logout", () => {
  test("revokes the refresh token, clears both cookies and redirects to a safe next", async () => {
    const t = await setup({ ttl: -100 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    const res = await t.app.request(
      request("/logout", {
        method: "POST",
        cookie,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "next=%2Fbye",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/bye");
    const cleared = res.headers.getSetCookie();
    expect(cleared).toHaveLength(2);
    expect(cleared.every(isCleared)).toBe(true);
    expect(cleared.map((c) => c.split("=")[0]).sort()).toEqual([
      "__Host-hk_login",
      "__Host-hk_session",
    ]);
    // The old cookie is dead at the issuer: a refresh with it is refused.
    const after = await t.client.authenticate(request("/api/me", { cookie }));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.failure).toEqual({ kind: "anonymous", reason: "signed_out" });
    expect(t.events).toContainEqual({ kind: "signed_out", reason: "logout" });
  });

  test("is idempotent without a cookie, refuses unsafe next, and is POST-only", async () => {
    const t = await setup();
    const res = await t.app.request(request("/logout?next=//evil.example", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(t.network.calls).toBe(0); // nothing to revoke, no issuer call
    expect((await t.app.request(request("/logout"))).status).toBe(404);
    expect(cookieValue(res.headers.getSetCookie()[0]!)).toBe("__Host-hk_session=");
  });
});
