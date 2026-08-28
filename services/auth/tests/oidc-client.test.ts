/**
 * The seeded `beszel` client is this issuer's first OIDC relying party (tools/deploy
 * FRAME "Monitoring"). PocketBase's generic OIDC provider (pocketbase/tools/auth/oidc.go)
 * needs: discovery at the issuer, an authorization-code exchange with PKCE and
 * client_secret_basic for `scope=openid email profile` and NO `resource`, and a
 * userinfo response whose `email` it only trusts when `email_verified` is true.
 * These tests are the kill-criterion check: if any of them needs a change inside
 * Better Auth's provider plugin, v1 falls back to GitHub OAuth in PocketBase.
 */
import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createTestService, type TestService } from "../src/testing.ts";

const OPS_ORIGIN = "https://ops.example.test";
const REDIRECT = `${OPS_ORIGIN}/api/oauth2-redirect`;
const SECRET = "beszel-secret-".padEnd(48, "x");
const basic = `Basic ${Buffer.from(`beszel:${SECRET}`, "utf8").toString("base64")}`;

describe("the seeded beszel OIDC client", () => {
  let t: TestService;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestService({ env: { OPS_ORIGIN, BESZEL_CLIENT_SECRET: SECRET } });
    t.github.user({ id: 7, login: "alice", name: "Alice", org: "active" });
    const login = await t.login("alice");
    if (!login.ok) throw new Error("login failed");
    cookie = login.cookie;
  });
  afterAll(() => t.close());

  test("is seeded as a confidential web client with PocketBase's fixed redirect", async () => {
    expect(await t.service.db.clients.byId("beszel")).toMatchObject({
      redirectUris: [REDIRECT],
      tokenEndpointAuthMethod: "client_secret_basic",
      applicationType: "web",
      skipConsent: true,
      grantTypes: ["authorization_code"],
    });
  });

  test("OIDC discovery at the issuer names the endpoints PocketBase is configured with", async () => {
    const res = await t.app.request(`${t.issuer}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      issuer: t.issuer,
      authorization_endpoint: `${t.issuer}/oauth2/authorize`,
      token_endpoint: `${t.issuer}/oauth2/token`,
      userinfo_endpoint: `${t.issuer}/oauth2/userinfo`,
    });
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
  });

  test("code flow without `resource` mints an id_token and userinfo carries a verified email", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "beszel",
      redirect_uri: REDIRECT,
      scope: "openid email profile",
      state: "pb-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authz = await t.app.request(`${t.issuer}/oauth2/authorize?${params.toString()}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(authz.status, await authz.clone().text()).toBe(302);
    const location = new URL(authz.headers.get("location") ?? "", t.origin);
    expect(location.origin + location.pathname).toBe(REDIRECT); // consent skipped: straight back
    expect(location.searchParams.get("state")).toBe("pb-state");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await t.app.request(`${t.issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    expect(tokenRes.status, JSON.stringify(tokens)).toBe(200);
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.id_token).toBe("string");
    expect(tokens.refresh_token).toBeUndefined(); // authorization_code only
    const id = decodeJwt(tokens.id_token as string);
    expect(id.iss).toBe(t.issuer);
    expect(id.aud).toBe("beszel");
    expect(typeof id.sub).toBe("string");

    const info = await t.app.request(`${t.issuer}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token as string}` },
    });
    const claims = (await info.json()) as Record<string, unknown>;
    expect(info.status, JSON.stringify(claims)).toBe(200);
    expect(claims.sub).toBe(id.sub);
    expect(claims.email_verified).toBe(true); // PocketBase drops an unverified email
    expect(claims.email).toBe("7+alice@users.noreply.github.com");
    expect(claims.name).toBe("Alice");
    expect(typeof claims.picture).toBe("string");
  });

  test("a second GitHub user is a distinct, stable subject", async () => {
    t.github.user({ id: 8, login: "bob", org: "active" });
    const bob = await t.login("bob");
    if (!bob.ok) throw new Error("login failed");
    const first = await subjectFor(t, bob.cookie);
    const again = await subjectFor(t, bob.cookie);
    expect(first).toBe(again);
    expect(first).not.toBe(await subjectFor(t, cookie)); // alice
  });
});

/** Runs the whole flow and returns `sub` from userinfo. */
async function subjectFor(t: TestService, cookie: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "beszel",
    redirect_uri: REDIRECT,
    scope: "openid email",
    state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authz = await t.app.request(`${t.issuer}/oauth2/authorize?${params.toString()}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const code = new URL(authz.headers.get("location") ?? "", t.origin).searchParams.get("code");
  if (!code) throw new Error(`authorize: ${authz.status} ${await authz.text()}`);
  const tokenRes = await t.app.request(`${t.issuer}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as { access_token: string };
  const info = await t.app.request(`${t.issuer}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  return ((await info.json()) as { sub: string }).sub;
}
