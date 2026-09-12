import { afterAll, expect, test } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";
import { createTestService } from "../src/testing.ts";

const secret = "ai-client-secret-".padEnd(48, "x");
const syncSecret = "ai-sync-secret-".padEnd(48, "x");
const portal = "https://ai-portal.example.test";
const t = await createTestService({
  env: { AI_PORTAL_ORIGIN: portal, AI_CLIENT_SECRET: secret, AI_SYNC_SECRET: syncSecret },
});
afterAll(() => t.close());

test("New API's confidential flow works without PKCE; existing clients still require it", async () => {
  expect(await t.service.db.clients.byId("herkules-ai")).toMatchObject({
    requirePKCE: false,
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  expect(await t.service.db.clients.byId("herkules-web")).toMatchObject({ requirePKCE: true });
  t.github.user({ id: 11, login: "ai-member", org: "active" });
  const login = await t.login("ai-member");
  if (!login.ok) throw new Error("login failed");
  const redirect = `${portal}/oauth/herkules`;
  const query = new URLSearchParams({
    client_id: "herkules-ai",
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile",
    state: "test-state",
  });
  const response = await t.app.request(`${t.issuer}/oauth2/authorize?${query.toString()}`, {
    headers: { cookie: login.cookie },
  });
  expect(response.status, await response.clone().text()).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(redirect);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: location.searchParams.get("code")!,
    redirect_uri: redirect,
  });
  const exchange = (authorization: string) =>
    t.app.request(`${t.issuer}/oauth2/token`, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  const tokens = await exchange(`Basic ${Buffer.from(`herkules-ai:${secret}`).toString("base64")}`);
  expect(tokens.status, await tokens.clone().text()).toBe(200);
  const data = (await tokens.json()) as { access_token: string };
  const info = await t.app.request(`${t.issuer}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${data.access_token}` },
  });
  expect(await info.json()).toMatchObject({ sub: login.userId, email_verified: true });
});

test("membership status requires the dedicated credential and denies missing or disabled users", async () => {
  t.github.user({ id: 12, login: "disabled-ai", org: "active" });
  const login = await t.login("disabled-ai");
  if (!login.ok) throw new Error("login failed");
  await t.service.users.setDisabled({ kind: "system", job: "ai-local-test" }, login.userId, true);
  const request = (authorization?: string) =>
    t.app.request("/auth/internal/ai-membership", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ ids: [login.userId, "missing"] }),
    });
  expect((await request()).status).toBe(401);
  expect((await request("Bearer incorrect")).status).toBe(401);
  expect(await (await request(`Bearer ${syncSecret}`)).json()).toEqual({
    users: [
      { id: login.userId, enabled: false },
      { id: "missing", enabled: false },
    ],
  });
});

for (let mask = 0; mask < 8; mask++) {
  test(`AI configuration is all-or-nothing (mask ${mask})`, () => {
    const env = {
      PUBLIC_ORIGIN: "https://herkules.example.test",
      AUTH_SECRET: secret,
      DATABASE_URL: "pglite://memory",
      GITHUB_CLIENT_ID: "test",
      GITHUB_CLIENT_SECRET: "test",
      GITHUB_ORG: "test",
      AI_PORTAL_ORIGIN: mask & 1 ? portal : "",
      AI_CLIENT_SECRET: mask & 2 ? secret : "",
      AI_SYNC_SECRET: mask & 4 ? syncSecret : "",
    };
    if (mask === 0 || mask === 7) expect(() => loadConfig(env)).not.toThrow();
    else expect(() => loadConfig(env)).toThrow("must be set together or not at all");
  });
}
