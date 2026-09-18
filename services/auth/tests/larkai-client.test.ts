import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createTestService, type TestService } from "../src/testing.ts";

const origin = "https://dashboard.example.test";
const secret = "larkai-secret-".padEnd(48, "x");
let t: TestService;
beforeAll(async () => {
  t = await createTestService({ env: { LARKAI_ORIGIN: origin, LARKAI_CLIENT_SECRET: secret } });
});
afterAll(() => t.close());

test("LarkAI uses PKCE and current provider roles; disabled users cannot use UserInfo", async () => {
  expect(await t.service.db.clients.byId("larkai")).toMatchObject({
    redirectUris: [`${origin}/oidc/callback`],
    requirePKCE: true,
    tokenEndpointAuthMethod: "client_secret_basic",
    skipConsent: true,
  });
  t.github.user({ id: 731, login: "larkai-user", org: "active" });
  const login = await t.login("larkai-user");
  if (!login.ok) throw new Error("login failed");
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "larkai",
    redirect_uri: `${origin}/oidc/callback`,
    scope: "openid email profile",
    state: "state",
    nonce: "nonce",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authz = await t.app.request(`${t.issuer}/oauth2/authorize?${params}`, {
    headers: { cookie: login.cookie },
    redirect: "manual",
  });
  expect(authz.status).toBe(302);
  const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
  const tokenRes = await t.app.request(`${t.issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`larkai:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/oidc/callback`,
      code_verifier: verifier,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const token = (await tokenRes.json()) as { access_token: string; id_token: string };
  expect(token.id_token).toBeTruthy();
  const userinfo = () =>
    t.app.request(`${t.issuer}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
  expect(await (await userinfo()).json()).toMatchObject({ sub: login.userId, role: "member" });
  await t.makeAdmin(login.userId);
  expect(await (await userinfo()).json()).toMatchObject({ sub: login.userId, role: "admin" });
  // Keep a second administrator so the last-admin guard permits demotion.
  t.github.user({ id: 732, login: "other-admin", org: "active" });
  const other = await t.login("other-admin");
  if (!other.ok) throw new Error("login failed");
  await t.makeAdmin(other.userId);
  await t.service.users.setRole({ kind: "system", job: "oidc-test" }, login.userId, "member");
  expect(await (await userinfo()).json()).toMatchObject({ sub: login.userId, role: "member" });
  await t.service.users.setDisabled({ kind: "system", job: "oidc-test" }, login.userId, true);
  expect((await userinfo()).status).toBe(401);
});
