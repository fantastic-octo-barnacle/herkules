/**
 * The Hono binding: viewer()/guard() typing and behaviour, Set-Cookie on every
 * branch (including raw Responses), and "a browser and an agent get the same
 * Principal" — the property the whole package exists for.
 */
import { honoAuth } from "@herkules/auth-middleware/hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type { ViewerEnv } from "../src/hono.ts";
import { cookieValue, request, RESOURCE, setup } from "./helpers.ts";

describe("typing", () => {
  test("viewer() leaves principal optional; guard() narrows it (compile-time)", () => {
    const app = new Hono<ViewerEnv>();
    // @ts-expect-error principal is `Principal | undefined` without guard()
    app.get("/x", (c) => c.text(c.var.principal.subject));
    app.get("/y", (c) => c.text(c.var.principal?.subject ?? "anon"));
    expect(app).toBeDefined();
  });
});

describe("viewer()", () => {
  test("anonymous passes through with no principal; a cookie yields one; an invalid bearer is a 401", async () => {
    const t = await setup();
    expect(await (await t.app.request(request("/api/me"))).json()).toBeNull();
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    expect(await (await t.app.request(request("/api/me", { cookie }))).json()).toMatchObject({
      subject: "u1",
      role: "member",
    });
    const bad = await t.app.request(
      request("/api/me", { cookie, headers: { authorization: "Bearer nope" } }),
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "invalid_token" });
  });

  test("an issuer outage looks anonymous under viewer() and keeps the cookie; guard() says 503", async () => {
    const t = await setup({ ttl: -100 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.network.down = true;
    const view = await t.app.request(request("/api/me", { cookie }));
    expect(view.status).toBe(200);
    expect(await view.json()).toBeNull();
    expect(view.headers.getSetCookie()).toEqual([]);
    const guarded = await t.app.request(request("/api/notes", { method: "POST", cookie }));
    expect(guarded.status).toBe(503);
    expect(await guarded.json()).toMatchObject({ error: "unavailable" });
  });

  test("a rotated cookie is written on the handler's response, even a raw Response", async () => {
    const t = await setup({ ttl: 30 });
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.fake.accessTokenTtlSeconds = 900;
    const raw = await t.app.request(request("/raw", { cookie }));
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("raw:u1");
    const [rotated] = raw.headers.getSetCookie();
    expect(rotated).toMatch(/^__Host-hk_session=v1\./);
    expect(cookieValue(rotated!)).not.toBe(cookie);
    // The browser now presents the rotated cookie and nothing rotates again.
    const next = await t.app.request(request("/api/me", { cookie: cookieValue(rotated!) }));
    expect(next.headers.getSetCookie()).toEqual([]);
    expect(t.fake.grants.filter((g) => g.grantType === "refresh_token")).toHaveLength(1);
  });
});

describe("guard()", () => {
  test("401 with challenge for anonymous, 403 without for the wrong role, 200 for a member; one refresh under viewer()", async () => {
    const t = await setup({ ttl: 30 });
    const anon = await t.app.request(request("/api/notes", { method: "POST" }));
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("resource_metadata=");
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1" });
    t.fake.accessTokenTtlSeconds = 900;
    const ok = await t.app.request(request("/api/notes", { method: "POST", cookie }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, subject: "u1" });
    expect(ok.headers.getSetCookie()).toHaveLength(1); // rotated once by viewer(), reused by guard()
    expect(t.fake.grants.filter((g) => g.grantType === "refresh_token")).toHaveLength(1);
    const denied = await t.app.request(
      request("/api/notes", {
        method: "DELETE",
        cookie: cookieValue(ok.headers.getSetCookie()[0]!),
      }),
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.has("www-authenticate")).toBe(false);
    expect(await denied.json()).toMatchObject({ error: "forbidden" });
  });
});

describe("one Principal for browsers and agents", () => {
  test("a cookie route, a bearer route and an MCP-style honoAuth route agree on the principal", async () => {
    const t = await setup();
    const mcp = new Hono();
    mcp.get("/mcp/bbs", honoAuth(t.auth), (c) =>
      c.json({
        subject: c.var.principal.subject,
        role: c.var.principal.role,
        resource: c.var.principal.resource,
      }),
    );
    const { cookie } = await t.fake.signIn(t.app, { subject: "u1", role: "admin" });
    const token = await t.fake.mint({
      audience: RESOURCE,
      subject: "u1",
      role: "admin",
      clientId: "ide",
    });

    const viaCookie = await t.client.authenticate(request("/api/me", { cookie }));
    const viaBearer = await t.client.authenticate(
      request("/api/me", { headers: { authorization: `Bearer ${token}` } }),
    );
    const viaMcp = (await (
      await mcp.request("/mcp/bbs", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { subject: string; role: string; resource: string };
    expect(viaCookie.ok && viaBearer.ok).toBe(true);
    if (!viaCookie.ok || !viaBearer.ok) return;
    const shape = (p: { subject: string; role: string; resource: string }) => ({
      subject: p.subject,
      role: p.role,
      resource: p.resource,
    });
    expect(shape(viaCookie.principal)).toEqual(shape(viaBearer.principal));
    expect(shape(viaCookie.principal)).toEqual(viaMcp);
    expect(viaCookie.principal.clientId).toBe("bbs");
    expect(viaBearer.principal.clientId).toBe("ide");
  });

  test("createOAuthClient validates its options at boot", async () => {
    const t = await setup();
    const base = {
      auth: t.auth,
      client: { id: "bbs", secret: "s".repeat(32) },
      origin: "https://bbs.example.test",
      cookieSecret: "c".repeat(32),
    };
    const { createOAuthClient } = await import("../src/index.ts");
    expect(() => createOAuthClient({ ...base, origin: "https://bbs.example.test/app" })).toThrow(
      /origin/,
    );
    expect(() => createOAuthClient({ ...base, origin: "bbs.example.test" })).toThrow(/origin/);
    expect(() =>
      createOAuthClient({ ...base, client: { id: "", secret: base.client.secret } }),
    ).toThrow(/client\.id/);
    expect(() => createOAuthClient({ ...base, client: { id: "bbs", secret: "short" } })).toThrow(
      /client\.secret/,
    );
    expect(() => createOAuthClient({ ...base, cookieSecret: "short" })).toThrow(/cookieSecret/);
    expect(() => createOAuthClient({ ...base, issuerInternal: "auth:3001" })).toThrow(
      /issuerInternal/,
    );
    expect(createOAuthClient(base).redirectUri).toBe("https://bbs.example.test/callback");
  });
});
