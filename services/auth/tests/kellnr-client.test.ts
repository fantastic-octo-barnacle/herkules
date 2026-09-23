/**
 * The seeded `kellnr` client (infrastructure, crates.<domain>). Kellnr's OIDC login
 * (crates/auth/src/oauth2.rs) uses discovery, PKCE and client_secret_basic, and reads
 * sub, email, preferred_username and its admin group claim from the ID token only.
 * Infrastructure sets `KELLNR_OAUTH2__ADMIN_GROUP_CLAIM=role` and `..._VALUE=admin`.
 */
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createTestService, type TestService } from "../src/testing.ts";

const origin = "https://crates.example.test";
const callback = `${origin}/api/v1/oauth2/callback`;
const secret = "kellnr-secret-".padEnd(48, "x");
let t: TestService;
beforeAll(async () => {
  t = await createTestService({ env: { CRATES_ORIGIN: origin, KELLNR_CLIENT_SECRET: secret } });
});
afterAll(() => t.close());

async function idToken(cookie: string, clientId = "kellnr", scope = "openid email profile") {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope,
    state: "state",
    nonce: "nonce",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authz = await t.app.request(`${t.issuer}/oauth2/authorize?${params}`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(authz.status).toBe(302);
  const location = new URL(authz.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(callback);
  const tokenRes = await t.app.request(`${t.issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`kellnr:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: location.searchParams.get("code")!,
      redirect_uri: callback,
      code_verifier: verifier,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const { id_token } = (await tokenRes.json()) as { id_token: string };
  const { payload } = await jwtVerify(
    id_token,
    createLocalJWKSet(await t.service.auth.api.getJwks()),
    { issuer: t.issuer, audience: "kellnr", algorithms: ["ES256"] },
  );
  return payload;
}

test("is seeded as a confidential web client with Kellnr's callback and PKCE", async () => {
  expect(await t.service.db.clients.byId("kellnr")).toMatchObject({
    redirectUris: [callback],
    requirePKCE: true,
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "web",
    skipConsent: true,
    grantTypes: ["authorization_code"],
  });
});

test("the ID token carries email, username and the current role", async () => {
  t.github.user({ id: 741, login: "Crate-Owner", org: "active" });
  const login = await t.login("Crate-Owner");
  if (!login.ok) throw new Error("login failed");
  expect(await idToken(login.cookie)).toMatchObject({
    sub: login.userId,
    email: "crate-owner@example.com",
    email_verified: true,
    preferred_username: "crate-owner",
    role: "member",
    nonce: "nonce",
  });
  await t.makeAdmin(login.userId);
  expect((await idToken(login.cookie)).role).toBe("admin");
  const bare = await idToken(login.cookie, "kellnr", "openid");
  expect(bare.role).toBe("admin");
  expect(bare.preferred_username).toBeUndefined();
  expect(bare.email).toBeUndefined();
});

test("other clients' ID tokens do not carry the role", async () => {
  const cf = await createTestService({
    env: { CLOUDFLARE_TEAM_NAME: "team-test", CLOUDFLARE_CLIENT_SECRET: secret },
  });
  try {
    cf.github.user({ id: 742, login: "cf-user", org: "active" });
    const login = await cf.login("cf-user");
    if (!login.ok) throw new Error("login failed");
    const cfCallback = "https://team-test.cloudflareaccess.com/cdn-cgi/access/callback";
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "cloudflare-access",
      redirect_uri: cfCallback,
      scope: "openid email profile",
      state: "state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authz = await cf.app.request(`${cf.issuer}/oauth2/authorize?${params}`, {
      headers: { cookie: login.cookie },
      redirect: "manual",
    });
    const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await cf.app.request(`${cf.issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`cloudflare-access:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: cfCallback,
        code_verifier: verifier,
      }).toString(),
    });
    const claims = decodeJwt(((await tokenRes.json()) as { id_token: string }).id_token);
    expect(claims.role).toBeUndefined();
    expect(claims.preferred_username).toBeUndefined();
  } finally {
    await cf.close();
  }
});
