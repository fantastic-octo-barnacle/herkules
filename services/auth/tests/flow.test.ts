/**
 * Integration: the whole service on PGlite with a fake GitHub. Each describe
 * boots its own service so state never leaks between scenarios.
 */
import { mcpResource } from "@herkules/auth-middleware";
import { fetchVia } from "@herkules/auth-middleware/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createTestService, TEST_ORG, type TestService } from "../src/testing.ts";

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("gate at login", () => {
  let t: TestService;
  beforeAll(async () => {
    t = await createTestService({ adminLogins: ["Root"] });
    t.github.user({ id: 1, login: "alice", org: "active" });
    t.github.user({ id: 2, login: "bob", org: "none" });
    t.github.user({ id: 3, login: "carol", org: "none" });
    t.github.user({ id: 4, login: "root", org: "none" });
  });
  afterAll(() => t.close());

  test("a non-member is refused, audited, and never gets a row; the org is not named", async () => {
    const r = await t.login("bob");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("not_org_member");
    expect(r.location).not.toContain(TEST_ORG);
    expect(await t.service.db.users.byLogin("bob")).toBeUndefined();
    const rejected = (await t.audit()).filter((e) => e.type === "gate.rejected");
    expect(rejected.at(-1)?.event).toMatchObject({
      githubLogin: "bob",
      githubId: "2",
      reason: "not_org_member",
      phase: "login",
    });
  });

  test("an env admin is admitted without org membership and created as admin", async () => {
    const r = await t.login("root");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const me = await t.fetch("/auth/api/me", { cookie: r.cookie });
    expect(await me.json()).toMatchObject({ kind: "session", userId: r.userId, role: "admin" });
    expect((await t.service.db.users.byId(r.userId))?.admittedVia).toBe("admin");
  });

  test("an allowlisted login is admitted without asking GitHub about the org", async () => {
    const root = await t.login("root");
    if (!root.ok) throw new Error("root login failed");
    const add = await t.fetch("/auth/api/admin/allowlist/Carol", {
      method: "PUT",
      cookie: root.cookie,
      ...json({ note: "contractor" }),
    });
    expect(await add.json()).toEqual({ changed: true });
    expect(
      await (
        await t.fetch("/auth/api/admin/allowlist/carol", { method: "PUT", cookie: root.cookie })
      ).json(),
    ).toEqual({ changed: false });

    const before = t.github.calls.length;
    const r = await t.login("carol");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(t.github.calls.slice(before).map((c) => c.path)).toEqual(["/user"]);
    expect((await t.service.db.users.byId(r.userId))?.admittedVia).toBe("allowlist");

    expect(
      await (
        await t.fetch("/auth/api/admin/allowlist/carol", { method: "DELETE", cookie: root.cookie })
      ).json(),
    ).toEqual({ changed: true });
    const again = await t.login("carol");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("not_org_member");
  });

  test("GitHub down at login fails closed", async () => {
    t.github.fail("network", 1, /memberships/);
    const r = await t.login("alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("github_unreachable");
    expect((await t.login("alice")).ok).toBe(true);
  });

  test("display name and avatar are mirrored on each login", async () => {
    const first = await t.login("alice");
    if (!first.ok) throw new Error("login failed");
    expect((await t.service.users.info(first.userId))?.displayName).toBe("alice");
    t.github.user({ id: 1, login: "alice", name: "Alice Liddell", org: "active" });
    const second = await t.login("alice");
    if (!second.ok) throw new Error("login failed");
    expect(second.userId).toBe(first.userId);
    expect((await t.service.users.info(first.userId))?.displayName).toBe("Alice Liddell");
    const avatar = await t.fetch(`/auth/avatars/${first.userId}`);
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toBe("image/png");
    const etag = avatar.headers.get("etag")!;
    expect(
      (await t.fetch(`/auth/avatars/${first.userId}`, { headers: { "if-none-match": etag } }))
        .status,
    ).toBe(304);
    expect((await t.fetch("/auth/avatars/nope")).status).toBe(404);
  });
});

describe("gate at grant time", () => {
  let t: TestService;
  beforeAll(async () => {
    t = await createTestService({ env: { GATE_RECHECK_TTL: "5", GATE_STALE_MAX: "3600" } });
    t.github.user({ id: 1, login: "alice", org: "active" });
    t.github.user({ id: 2, login: "dave", org: "active" });
  });
  afterAll(() => t.close());

  test("a fresh verdict is reused without a GitHub call; a stale one re-asks", async () => {
    const login = await t.login("alice");
    if (!login.ok) throw new Error("login failed");
    const client = await t.mcpClient(login.cookie, t.service.registry.canonical.audience);
    const before = t.github.calls.length;
    expect((await client.refresh()).status).toBe(200);
    expect(t.github.calls.length).toBe(before); // within GATE_RECHECK_TTL
    t.clock.advance(6);
    expect((await client.refresh()).status).toBe(200);
    expect(t.github.calls.slice(before).map((c) => c.path)).toEqual([
      `/user/memberships/orgs/${TEST_ORG}`,
    ]);
  });

  test("removed from the org: the refresh is rejected, the family revoked, the rejection audited", async () => {
    const login = await t.login("alice");
    if (!login.ok) throw new Error("login failed");
    const client = await t.mcpClient(login.cookie, t.service.registry.canonical.audience);
    t.github.setOrg("alice", "none");
    t.clock.advance(6);
    const res = await client.refresh();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    const rejected = (await t.audit()).filter((e) => e.type === "gate.rejected").at(-1);
    expect(rejected?.event).toMatchObject({
      githubLogin: "alice",
      userId: login.userId,
      reason: "not_org_member",
      phase: "grant",
    });
    // A new code grant is refused too: the re-check runs for every grant type.
    await expect(t.mcpClient(login.cookie, t.service.registry.canonical.audience)).rejects.toThrow(
      /token: 400/,
    );
    t.github.setOrg("alice", "active");
  });

  test("GitHub outage at grant time keeps a recent allow (org-stale) and audits it", async () => {
    const login = await t.login("dave");
    if (!login.ok) throw new Error("login failed");
    const client = await t.mcpClient(login.cookie, t.service.registry.canonical.audience);
    t.clock.advance(6);
    t.github.fail("network", 1);
    expect((await client.refresh()).status).toBe(200);
    expect((await t.service.db.users.byId(login.userId))?.admittedVia).toBe("org-stale");
    expect((await t.audit()).some((e) => e.type === "gate.stale_allow")).toBe(true);
    // GitHub back: the next grant re-asks immediately (a stale allow is never "fresh") and restores `org`.
    expect((await client.refresh()).status).toBe(200);
    expect((await t.service.db.users.byId(login.userId))?.admittedVia).toBe("org");
    // Beyond GATE_STALE_MAX the grace is over.
    t.clock.advance(3700);
    t.github.fail("network", 1);
    const res = await client.refresh();
    expect(res.status).toBe(400);
  });
});

describe("admin operations", () => {
  let t: TestService;
  let root: { cookie: string; userId: string };
  let alice: { cookie: string; userId: string };
  beforeAll(async () => {
    t = await createTestService({ adminLogins: ["root"] });
    t.github.user({ id: 1, login: "root", org: "active" });
    t.github.user({ id: 2, login: "alice", org: "active" });
    const r = await t.login("root");
    const a = await t.login("alice");
    if (!r.ok || !a.ok) throw new Error("login failed");
    root = r;
    alice = a;
  });
  afterAll(() => t.close());

  test("members cannot use the admin API (403, no challenge)", async () => {
    const res = await t.fetch("/auth/api/admin/users", { cookie: alice.cookie });
    expect(res.status).toBe(403);
    expect(res.headers.has("www-authenticate")).toBe(false);
  });

  test("disable = sessions gone, refresh refused, user-info refused; re-enable restores login", async () => {
    const client = await t.mcpClient(alice.cookie, t.service.registry.canonical.audience);
    const res = await t.fetch(`/auth/api/admin/users/${alice.userId}/disabled`, {
      method: "PUT",
      cookie: root.cookie,
      ...json({ disabled: true, reason: "left" }),
    });
    expect(await res.json()).toEqual({ changed: true });
    expect(await (await t.fetch("/auth/get-session", { cookie: alice.cookie })).json()).toBeNull();
    expect((await client.refresh()).status).toBe(400);
    const info = await t.fetch(`/auth/api/users/${alice.userId}`, bearer(client.accessToken));
    expect(info.status).toBe(403);
    expect(await info.json()).toMatchObject({ error: "account_disabled" });
    // The already-issued JWT stays valid on resource servers until it expires (FRAME accepts the ≤15-minute lag).
    const rs = mcpResource({
      resource: t.service.registry.canonical.audience,
      issuer: t.issuer,
      fetch: fetchVia(t.app),
    });
    expect((await rs.verifyToken(client.accessToken)).ok).toBe(true);

    const disabled = (await t.audit()).filter((e) => e.type === "admin.user_disabled").at(-1);
    expect(disabled?.event).toMatchObject({
      userId: alice.userId,
      reason: "left",
      sessionsRevoked: 1,
      refreshTokensRevoked: 1,
    });
    expect(
      await (
        await t.fetch(`/auth/api/admin/users/${alice.userId}/disabled`, {
          method: "PUT",
          cookie: root.cookie,
          ...json({ disabled: true }),
        })
      ).json(),
    ).toEqual({ changed: false });

    const banned = await t.login("alice");
    expect(banned.ok).toBe(false);
    if (!banned.ok) expect(banned.error).toBe("banned");

    expect(
      await (
        await t.fetch(`/auth/api/admin/users/${alice.userId}/disabled`, {
          method: "PUT",
          cookie: root.cookie,
          ...json({ disabled: false }),
        })
      ).json(),
    ).toEqual({ changed: true });
    const again = await t.login("alice");
    expect(again.ok).toBe(true);
    if (again.ok) alice = again;
  });

  test("role changes, last-admin and self-disable guards", async () => {
    const demote = await t.fetch(`/auth/api/admin/users/${root.userId}/role`, {
      method: "PUT",
      cookie: root.cookie,
      ...json({ role: "member" }),
    });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ error: "last_admin" });
    const self = await t.fetch(`/auth/api/admin/users/${root.userId}/disabled`, {
      method: "PUT",
      cookie: root.cookie,
      ...json({ disabled: true }),
    });
    expect(self.status).toBe(403);

    expect(
      await (
        await t.fetch(`/auth/api/admin/users/${alice.userId}/role`, {
          method: "PUT",
          cookie: root.cookie,
          ...json({ role: "admin" }),
        })
      ).json(),
    ).toEqual({ changed: true });
    expect(
      await (
        await t.fetch(`/auth/api/admin/users/${alice.userId}/role`, {
          method: "PUT",
          cookie: root.cookie,
          ...json({ role: "admin" }),
        })
      ).json(),
    ).toEqual({ changed: false });
    const list = (await (
      await t.fetch("/auth/api/admin/users?limit=10", { cookie: root.cookie })
    ).json()) as { rows: { githubLogin: string; role: string }[] };
    expect(
      list.rows.map((r) => `${r.githubLogin}:${r.role}`).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["alice:admin", "root:admin"]);
    expect(
      await (
        await t.fetch(`/auth/api/admin/users/${alice.userId}/role`, {
          method: "PUT",
          cookie: root.cookie,
          ...json({ role: "member" }),
        })
      ).json(),
    ).toEqual({ changed: true });
    // A promoted-then-demoted user's tokens carry the row's role at issuance time.
    const roles = (await t.audit())
      .filter((e) => e.type === "admin.role_set")
      .map((e) => (e.event as { role: string }).role);
    expect(roles).toEqual(["admin", "member"]);
  });

  test("audit listing pages by keyset cursor and filters by type", async () => {
    const page1 = (await (
      await t.fetch("/auth/api/admin/audit?limit=2", { cookie: root.cookie })
    ).json()) as { rows: { type: string }[]; next?: string };
    expect(page1.rows).toHaveLength(2);
    expect(page1.next).toBeDefined();
    const page2 = (await (
      await t.fetch(`/auth/api/admin/audit?limit=2&cursor=${page1.next}`, { cookie: root.cookie })
    ).json()) as { rows: { id: string }[] };
    expect(page2.rows).toHaveLength(2);
    const logins = (await (
      await t.fetch("/auth/api/admin/audit?type=login", { cookie: root.cookie })
    ).json()) as { rows: { type: string }[] };
    expect(logins.rows.every((r) => r.type === "login")).toBe(true);
    expect(logins.rows.length).toBeGreaterThanOrEqual(3);
  });

  test("revoke sessions logs the browser out but keeps IDE tokens", async () => {
    const client = await t.mcpClient(alice.cookie, t.service.registry.canonical.audience);
    expect(
      await (
        await t.fetch(`/auth/api/admin/users/${alice.userId}/sessions`, {
          method: "DELETE",
          cookie: root.cookie,
        })
      ).json(),
    ).toEqual({ count: 1 });
    expect(await (await t.fetch("/auth/get-session", { cookie: alice.cookie })).json()).toBeNull();
    expect((await client.refresh()).status).toBe(200);
  });
});

describe("user-info API and clients", () => {
  let t: TestService;
  let alice: { cookie: string; userId: string };
  beforeAll(async () => {
    t = await createTestService();
    t.github.user({ id: 2, login: "alice", org: "active" });
    const a = await t.login("alice");
    if (!a.ok) throw new Error("login failed");
    alice = a;
  });
  afterAll(() => t.close());

  test("any registry audience is accepted; no credentials -> 401 without resource_metadata", async () => {
    const notes = t.service.registry.entries.find((e) => e.name === "notes")!;
    const client = await t.mcpClient(alice.cookie, notes.audience);
    const res = await t.fetch(`/auth/api/users/${alice.userId}`, bearer(client.accessToken));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: alice.userId,
      displayName: "alice",
      avatarUrl: `${t.issuer}/avatars/${alice.userId}`,
      githubId: "2",
    });
    const me = (await (await t.fetch("/auth/api/me", bearer(client.accessToken))).json()) as Record<
      string,
      unknown
    >;
    expect(me).toMatchObject({
      kind: "token",
      userId: alice.userId,
      role: "member",
      clientId: client.clientId,
      audiences: [notes.audience],
    });

    const batch = await t.fetch("/auth/api/users/batch", {
      method: "POST",
      cookie: alice.cookie,
      ...json({ ids: [alice.userId, "nope"] }),
    });
    expect(((await batch.json()) as { users: unknown[] }).users).toHaveLength(1);
    expect((await t.fetch("/auth/api/users/nope", { cookie: alice.cookie })).status).toBe(404);

    // The member directory: every non-disabled user, sorted by name; a disabled user drops out.
    t.github.user({ id: 3, login: "zed", name: "Zed", org: "active" });
    const zed = await t.login("zed");
    if (!zed.ok) throw new Error("login failed");
    const dirBefore = (await (
      await t.fetch("/auth/api/users", bearer(client.accessToken))
    ).json()) as {
      users: { id: string; displayName: string }[];
    };
    expect(dirBefore.users.map((u) => u.displayName)).toEqual(["alice", "Zed"]);
    await t.makeAdmin(alice.userId);
    await t.fetch(`/auth/api/admin/users/${zed.userId}/disabled`, {
      method: "PUT",
      cookie: alice.cookie,
      ...json({ disabled: true }),
    });
    const dirAfter = (await (
      await t.fetch("/auth/api/users", { cookie: alice.cookie })
    ).json()) as {
      users: { id: string }[];
    };
    expect(dirAfter.users.map((u) => u.id)).toEqual([alice.userId]);

    const anon = await t.fetch(`/auth/api/users/${alice.userId}`);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe("Bearer");
    const bad = await t.fetch(`/auth/api/users/${alice.userId}`, bearer("garbage"));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("consent is per client per resource; disconnecting a client revokes its refresh tokens", async () => {
    const dir = t.service.registry.canonical.audience;
    const notes = t.service.registry.entries.find((e) => e.name === "notes")!.audience;
    const client = await t.mcpClient(alice.cookie, dir);
    // Same client, a new resource: consent is asked again (the harness answers it), and the token is bound to the new audience.
    const second = await t.mcpClient(alice.cookie, notes, { clientId: client.clientId });
    expect(second.clientId).toBe(client.clientId);
    const granted = (await t.audit()).filter(
      (e) =>
        e.type === "consent.granted" &&
        (e.event as { clientId: string }).clientId === client.clientId,
    );
    expect(granted.map((e) => (e.event as { resources: string[] }).resources)).toEqual([
      [dir],
      [notes],
    ]);

    const list = (await (
      await t.fetch("/auth/api/me/clients", { cookie: alice.cookie })
    ).json()) as { clients: { clientId: string; name: string; resources: string[] }[] };
    const mine = list.clients.find((c) => c.clientId === client.clientId);
    expect(mine).toMatchObject({ clientId: client.clientId, name: "Test IDE" });
    // Better Auth keeps ONE consent row per (client, user) and overwrites its resources with the latest
    // consent rather than accumulating them; the audit rows above hold the history. Documented in DESIGN.md.
    expect(mine?.resources).toEqual([notes]);

    expect(
      await (
        await t.fetch(`/auth/api/me/clients/${client.clientId}`, {
          method: "DELETE",
          cookie: alice.cookie,
        })
      ).json(),
    ).toEqual({ changed: true });
    expect((await client.refresh()).status).toBe(400);
    expect((await second.refresh()).status).toBe(400);
    const after = (await (
      await t.fetch("/auth/api/me/clients", { cookie: alice.cookie })
    ).json()) as {
      clients: { clientId: string }[];
    };
    expect(after.clients.some((c) => c.clientId === client.clientId)).toBe(false);
  });

  test("consent denied is audited and yields access_denied", async () => {
    await expect(
      t.mcpClient(alice.cookie, t.service.registry.canonical.audience, { consent: false }),
    ).rejects.toThrow(/access_denied/);
    expect((await t.audit()).some((e) => e.type === "consent.denied")).toBe(true);
  });

  test("a redirect URI outside the allowlist cannot register", async () => {
    const res = await t.fetch("/auth/oauth2/register", {
      method: "POST",
      ...json({
        client_name: "Evil",
        redirect_uris: ["https://evil.example/cb"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("dev token: the first-party herkules-web client skips consent and issues no refresh token", async () => {
    const reg = (await (await t.fetch("/auth/api/registry", { cookie: alice.cookie })).json()) as {
      devTokenClientId: string;
      resources: { audience: string }[];
    };
    expect(reg.devTokenClientId).toBe("herkules-web");
    expect(reg.resources.map((r) => r.audience)).toContain(t.service.registry.canonical.audience);
    const dev = await t.mcpClient(alice.cookie, t.service.registry.canonical.audience, {
      clientId: "herkules-web",
      redirectUri: `${t.origin}/dev-token/callback`,
    });
    // Better Auth mints a refresh token whenever offline_access is granted; the client's grant_types decide whether it is USABLE.
    const refreshed = await dev.refresh();
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "unauthorized_client" });
    const rs = mcpResource({
      resource: t.service.registry.canonical.audience,
      issuer: t.issuer,
      fetch: fetchVia(t.app),
    });
    const outcome = await rs.verifyToken(dev.accessToken);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.principal.clientId).toBe("herkules-web");
  });

  test("idle DCR clients are pruned; owned and consented clients survive", async () => {
    const client = await t.mcpClient(alice.cookie, t.service.registry.canonical.audience);
    const reg = await t.fetch("/auth/oauth2/register", {
      method: "POST",
      ...json({
        client_name: "Abandoned",
        redirect_uris: ["http://127.0.0.1:1/cb"],
        token_endpoint_auth_method: "none",
      }),
    });
    const abandoned = ((await reg.json()) as { client_id: string }).client_id;
    t.clock.advance(31 * 86_400);
    expect(await t.service.prune()).toBeGreaterThanOrEqual(1); // the consent-denied client above is idle too
    expect(await t.service.db.clients.byId(abandoned)).toBeUndefined();
    expect(await t.service.db.clients.byId(client.clientId)).toBeDefined();
    expect(await t.service.db.clients.byId("herkules-web")).toBeDefined();
    const pruned = (await t.audit()).at(-1);
    expect(pruned).toMatchObject({ type: "client.pruned" });
    expect((pruned!.event as { clientIds: string[] }).clientIds).toContain(abandoned);
    expect(await t.service.prune()).toBe(0);
  });
});
