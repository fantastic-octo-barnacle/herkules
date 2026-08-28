/**
 * The SPA's api client and dev-token flow against the real auth service on
 * PGlite: the same calls the pages make, with fetch routed in-process and the
 * session cookie attached the way a browser would.
 */
import { createTestService, type TestService } from "@herkules/auth/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createApi, type Api } from "../src/api.ts";
import { beginDevToken, decodeJwtPayload, finishDevToken, type KeyValue } from "../src/devtoken.ts";

function memoryStorage(): KeyValue {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}

/** A browser for one signed-in user: same-origin fetch with the cookie and Origin header. */
function browserFor(t: TestService, cookie?: string): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), t.origin);
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", cookie);
    headers.set("origin", t.origin);
    return t.app.request(url.toString(), { ...init, headers, redirect: "manual" });
  };
}

describe("web against the auth service", () => {
  let t: TestService;
  let alice: { cookie: string; userId: string };
  let api: Api;

  beforeAll(async () => {
    t = await createTestService();
    t.github.user({ id: 1, login: "alice", name: "Alice", org: "active" });
    t.github.user({ id: 2, login: "bob", org: "active" });
    const a = await t.login("alice");
    if (!a.ok) throw new Error("login failed");
    alice = a;
    api = createApi(browserFor(t, alice.cookie));
  });
  afterAll(() => t.close());

  it("session, registry and connected clients read as the pages expect", async () => {
    const session = await api.session();
    expect(session?.user).toMatchObject({ name: "Alice", githubLogin: "alice" });
    expect(await createApi(browserFor(t)).session()).toBeNull();

    const registry = await api.registry();
    expect(registry.devTokenClientId).toBe("herkules-web");
    expect(registry.resources.map((r) => r.name)).toContain("bbs");

    expect(await api.myClients()).toEqual([]);
    const ide = await t.mcpClient(alice.cookie, registry.resources[0].audience);
    const clients = await api.myClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      clientId: ide.clientId,
      resources: [registry.resources[0].audience],
    });
    expect(await api.disconnectClient(ide.clientId)).toEqual({ changed: true });
    expect(await api.myClients()).toEqual([]);
  });

  it("dev token: PKCE authorize -> callback -> 15-minute JWT for the chosen audience, no refresh", async () => {
    const registry = await api.registry();
    const audience = registry.resources[0].audience;
    const storage = memoryStorage();
    const url = await beginDevToken(storage, {
      origin: t.origin,
      clientId: registry.devTokenClientId,
      audience,
    });
    expect(url.startsWith(`${t.origin}/auth/oauth2/authorize?`)).toBe(true);

    // The browser follows the authorize URL; skipConsent sends it straight to the callback.
    const authz = await browserFor(t, alice.cookie)(url);
    expect(authz.status).toBe(302);
    const back = new URL(authz.headers.get("location") ?? "", t.origin);
    expect(back.pathname).toBe("/dev-token/callback");

    const outcome = await finishDevToken(storage, api, { origin: t.origin, search: back.search });
    if (!outcome.ok) throw new Error(`${outcome.error}: ${outcome.description}`);
    expect(outcome.audience).toBe(audience);
    const claims = decodeJwtPayload(outcome.token.access_token)!;
    expect(claims.aud).toBe(audience);
    expect(claims.sub).toBe(alice.userId);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(15 * 60);
    // A refresh token comes with offline_access, but the auth service refuses to honour it for this client.
    await expect(
      api.token({
        grant_type: "refresh_token",
        refresh_token: (outcome.token as { refresh_token?: string }).refresh_token ?? "",
        client_id: registry.devTokenClientId,
      }),
    ).rejects.toMatchObject({ code: "unauthorized_client" });

    // A replayed callback is refused: the pending record was consumed.
    const replay = await finishDevToken(storage, api, { origin: t.origin, search: back.search });
    expect(replay).toMatchObject({ ok: false, error: "invalid_state" });
  });

  it("admin calls: refused for members, audited for admins", async () => {
    await expect(api.admin.users()).rejects.toMatchObject({ status: 403 });
    await t.makeAdmin(alice.userId);
    const b = await t.login("bob");
    if (!b.ok) throw new Error("login failed");

    const page = await api.admin.users({ search: "bob" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ githubLogin: "bob", role: "member", disabled: false });

    expect(await api.admin.setRole(b.userId, "admin")).toEqual({ changed: true });
    expect(await api.admin.setRole(b.userId, "member")).toEqual({ changed: true });
    expect(await api.admin.allowlistAdd("carol", "contractor")).toEqual({ changed: true });
    expect(await api.admin.allowlist()).toMatchObject([
      { githubLogin: "carol", note: "contractor" },
    ]);
    expect(await api.admin.revokeSessions(b.userId)).toEqual({ count: 1 });
    // The revoked member's cookie is dead; alice's still works.
    expect(await createApi(browserFor(t, b.cookie)).session()).toBeNull();
    expect(await api.admin.setDisabled(b.userId, true, "left")).toEqual({ changed: true });

    const types = (await api.admin.audit({ limit: 50 })).rows.map((r) => r.type);
    for (const expected of [
      "admin.role_set",
      "admin.allowlist_added",
      "admin.user_disabled",
      "admin.sessions_revoked",
    ])
      expect(types).toContain(expected);
  });
});
