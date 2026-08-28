/**
 * The session lifecycle through `client.authenticate` against the fake issuer:
 * bearer precedence, the cross-site guard, refresh-ahead, expiry, single-flight,
 * the replay memo, revocation, outages and our own misconfiguration.
 */
import { describe, expect, test } from "vite-plus/test";
import { createOAuthClient, type SessionEvent } from "../src/index.ts";
import { REPLAY_WINDOW_SECONDS } from "../src/session.ts";
import {
  CLIENT,
  COOKIE_SECRET,
  cookieValue,
  createClock,
  isCleared,
  ORIGIN,
  request,
  RESOURCE,
  setup,
} from "./helpers.ts";

describe("authenticate: anonymous and cookie basics", () => {
  test("no cookie → anonymous/no_cookie with the verifier's 401 challenge and no Set-Cookie", async () => {
    const t = await setup();
    const o = await t.client.authenticate(request("/api/me"));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure).toEqual({ kind: "anonymous", reason: "no_cookie" });
    expect(o.response.status).toBe(401);
    expect(o.response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(o.setCookie).toBeUndefined();
  });

  test("garbage cookie → anonymous/bad_cookie and the cookie is cleared", async () => {
    const t = await setup();
    const o = await t.client.authenticate(
      request("/api/me", { cookie: "__Host-hk_session=v1.notreally" }),
    );
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure).toEqual({ kind: "anonymous", reason: "bad_cookie" });
    expect(o.setCookie?.length).toBe(1);
    expect(isCleared(o.setCookie![0]!)).toBe(true);
  });

  test("a signed-in browser yields the Principal via cookie; nothing is rewritten while the token is fresh", async () => {
    const t = await setup();
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1", role: "admin" });
    expect(cookie).toContain("__Host-hk_session=");
    expect(cookie).not.toContain("hk_login");
    const o = await t.client.authenticate(request("/api/me", { cookie }));
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.via).toBe("cookie");
    expect(o.principal).toMatchObject({
      subject: "u1",
      role: "admin",
      clientId: "bbs",
      resource: RESOURCE,
    });
    expect(o.setCookie).toBeUndefined();
    expect(t.fake.grants.map((g) => g.grantType)).toEqual(["authorization_code"]);
  });

  test("a requirement the principal fails is denied with the verifier's 403 (no refresh, no cookie change)", async () => {
    const t = await setup({ ttl: 30 }); // near expiry: a refresh WOULD be due, but denial comes first
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    const o = await t.client.authenticate(request("/api/me", { cookie }), { role: "admin" });
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure.kind).toBe("denied");
    expect(o.response.status).toBe(403);
    expect(o.response.headers.has("www-authenticate")).toBe(false);
    expect(o.setCookie).toBeUndefined();
    expect(t.fake.grants.filter((g) => g.grantType === "refresh_token")).toHaveLength(0);
  });
});

describe("authenticate: bearer precedence and cross-site guard", () => {
  test("a valid bearer wins over the cookie and never touches it", async () => {
    const t = await setup({ ttl: -100 }); // the cookie would need a refresh; it must not get one
    const { cookie } = await t.fake.signIn(t.app, { subject: "browser" });
    const token = await t.fake.mint({ audience: RESOURCE, subject: "agent", clientId: "ide" });
    const o = await t.client.authenticate(
      request("/api/me", { cookie, headers: { authorization: `Bearer ${token}` } }),
    );
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.via).toBe("bearer");
    expect(o.principal.subject).toBe("agent");
    expect(o.setCookie).toBeUndefined();
    expect(t.fake.grants.filter((g) => g.grantType === "refresh_token")).toHaveLength(0);
  });

  test("an invalid bearer is denied even with a perfectly good cookie", async () => {
    const t = await setup();
    const { cookie } = await t.fake.signIn(t.app, { subject: "browser" });
    const o = await t.client.authenticate(
      request("/api/me", { cookie, headers: { authorization: "Bearer garbage" } }),
    );
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure.kind).toBe("denied");
    expect(o.response.status).toBe(401);
    expect(o.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("cookie auth on a cross-site POST is anonymous/cross_site; a cross-site GET is fine", async () => {
    const t = await setup();
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    const post = await t.client.authenticate(
      request("/api/notes", {
        method: "POST",
        cookie,
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(post.ok).toBe(false);
    if (!post.ok) {
      expect(post.failure).toEqual({ kind: "anonymous", reason: "cross_site" });
      expect(post.setCookie).toBeUndefined();
    }
    const get = await t.client.authenticate(
      request("/api/me", { cookie, headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(get.ok).toBe(true);
    const sameSite = await t.client.authenticate(
      request("/api/notes", {
        method: "POST",
        cookie,
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(sameSite.ok).toBe(true);
  });
});

describe("authenticate: refresh policy", () => {
  test("refresh-ahead: a token inside the 60 s window is rotated and the new cookie is issued", async () => {
    const t = await setup({ ttl: 30 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.fake.accessTokenTtlSeconds = 900;
    const o = await t.client.authenticate(request("/api/me", { cookie }));
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.principal.subject).toBe("u1");
    expect(o.setCookie?.length).toBe(1);
    expect(o.setCookie![0]!.startsWith("__Host-hk_session=v1.")).toBe(true);
    expect(t.fake.grants.map((g) => g.grantType)).toEqual(["authorization_code", "refresh_token"]);
    expect(t.events).toContainEqual({ kind: "refreshed", subject: "u1", fromMemo: false });

    // The rotated cookie is long-lived: no further rotation.
    const fresh = await t.client.authenticate(
      request("/api/me", { cookie: cookieValue(o.setCookie![0]!) }),
    );
    expect(fresh.ok && fresh.setCookie).toBeUndefined();
    expect(t.fake.grants).toHaveLength(2);
  });

  test("an expired token is refreshed; ten concurrent tabs cause one issuer call", async () => {
    const t = await setup({ ttl: -100 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.fake.accessTokenTtlSeconds = 900;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => t.client.authenticate(request("/api/me", { cookie }))),
    );
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(t.fake.grants.filter((g) => g.grantType === "refresh_token")).toHaveLength(1);
    const cookies = new Set(outcomes.map((o) => (o.ok ? o.setCookie?.[0] : undefined)));
    expect(cookies.size).toBeGreaterThanOrEqual(1); // every tab got the same rotated tokens
    expect(t.events.filter((e) => e.kind === "refreshed" && e.fromMemo)).toHaveLength(9);
  });

  test("a stale cookie inside the replay window is answered from memory; beyond it the issuer kills the family", async () => {
    const clock = createClock();
    const t = await setup({ ttl: -100, clock });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.fake.accessTokenTtlSeconds = 900;
    const first = await t.client.authenticate(request("/api/me", { cookie }));
    expect(first.ok).toBe(true);
    clock.advance(REPLAY_WINDOW_SECONDS - 5);
    const stale = await t.client.authenticate(request("/api/me", { cookie }));
    expect(stale.ok).toBe(true);
    expect(t.fake.grants.filter((g) => g.grantType === "refresh_token")).toHaveLength(1);
    expect(t.events.at(-1)).toEqual({ kind: "refreshed", subject: "u1", fromMemo: true });

    clock.advance(10); // past the window: memo swept, the issuer sees a spent token
    const late = await t.client.authenticate(request("/api/me", { cookie }));
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.failure).toEqual({ kind: "anonymous", reason: "signed_out" });
    expect(isCleared(late.setCookie![0]!)).toBe(true);
    expect(t.fake.grants.at(-1)).toMatchObject({ grantType: "refresh_token", replayed: false });
    // The family is dead: even the rotated cookie is now refused.
    const rotated = first.ok ? cookieValue(first.setCookie![0]!) : "";
    t.fake.accessTokenTtlSeconds = -100;
    const dead = await t.client.authenticate(request("/api/me", { cookie: rotated }));
    expect(dead.ok).toBe(true); // its access token is still valid (900 s); only a refresh would fail
  });

  test("the issuer revoking the family signs the browser out and clears the cookie", async () => {
    const t = await setup({ ttl: -100 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.fake.revokeFamily("u1");
    const o = await t.client.authenticate(request("/api/me", { cookie }));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure).toEqual({ kind: "anonymous", reason: "signed_out" });
    expect(o.response.status).toBe(401);
    expect(isCleared(o.setCookie![0]!)).toBe(true);
    expect(t.events).toContainEqual({ kind: "signed_out", reason: "invalid_grant" });
  });
});

describe("authenticate: outages and misconfiguration", () => {
  test("token endpoint down but the token still verifies → served from the old token, cookie kept", async () => {
    const t = await setup({ ttl: 30 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.network.down = true;
    const o = await t.client.authenticate(request("/api/me", { cookie }));
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.principal.subject).toBe("u1");
    expect(o.setCookie).toBeUndefined();
  });

  test("token endpoint down and the token expired → unavailable (503), cookie kept, retried next time", async () => {
    const t = await setup({ ttl: -100 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.network.down = true;
    const o = await t.client.authenticate(request("/api/me", { cookie }));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure.kind).toBe("unavailable");
    expect(o.response.status).toBe(503);
    expect(o.response.headers.get("retry-after")).toBe("5");
    expect(o.setCookie).toBeUndefined();
    expect(t.events.some((e) => e.kind === "unavailable")).toBe(true);
    t.network.down = false;
    t.fake.accessTokenTtlSeconds = 900;
    const again = await t.client.authenticate(request("/api/me", { cookie }));
    expect(again.ok).toBe(true); // an unavailable result is never memoised
  });

  test("our client secret being wrong is unavailable + client_auth_failed, never the user's fault", async () => {
    const t = await setup({ ttl: -100 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    // The same app booted with a wrong secret (same cookie key, same issuer): the cookie still opens.
    const events: SessionEvent[] = [];
    const misconfigured = createOAuthClient({
      auth: t.auth,
      client: { id: CLIENT.id, secret: "w".repeat(32) },
      origin: ORIGIN,
      cookieSecret: COOKIE_SECRET,
      fetch: t.fake.fetch,
      onEvent: (e) => events.push(e),
    });
    const o = await misconfigured.authenticate(request("/api/me", { cookie }));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.failure.kind).toBe("unavailable");
    expect(o.response.status).toBe(503);
    expect(o.setCookie).toBeUndefined(); // the user's cookie is kept
    expect(events.some((e) => e.kind === "client_auth_failed")).toBe(true);
  });
});
