import { createHash, randomBytes } from "node:crypto";
import { createTestService, type TestService } from "@herkules/auth/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createApi } from "../src/api.ts";
import { readOAuthPageQuery } from "../src/oauth-query.ts";

let t: TestService;

beforeAll(async () => {
  t = await createTestService();
});
afterAll(() => t.close());

function apiFor(cookie?: string) {
  return createApi((input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return t.fetch(url, { ...init, ...(cookie ? { cookie } : {}), redirect: "manual" });
  });
}

describe("Better Auth signed query handoff", () => {
  test("preserves repeated signed fields and excludes page-only fields", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "herkules-web",
      redirect_uri: `${t.origin}/dev-token/callback`,
      resource: t.service.registry.canonical.audience,
      scope: "offline_access",
      state: "oauth-query-test",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorize = await t.fetch(`/auth/oauth2/authorize?${params}`);
    expect(authorize.status).toBe(302);
    const login = new URL(authorize.headers.get("location")!, t.origin);
    expect(login.pathname).toBe("/login");

    const page = readOAuthPageQuery(`${login.search}&next=%2Fsettings`);
    expect(page.params.get("next")).toBe("/settings");
    expect(page.continuation).toBeDefined();
    expect(new URLSearchParams(page.continuation).getAll("ba_param").length).toBeGreaterThan(1);
    expect(new URLSearchParams(page.continuation).has("next")).toBe(false);

    await expect(apiFor().signInWithGithub("/", page.continuation)).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/github\.com\/login\/oauth\/authorize/),
    });
  });

  test("preserves the continuation through consent for a signed-in user", async () => {
    t.github.user({ id: 42, login: "consenter", org: "active" });
    const login = await t.login("consenter");
    if (!login.ok) throw new Error("login failed");

    const redirectUri = "http://127.0.0.1:4242/callback";
    const registration = await t.fetch("/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Consent test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const clientId = ((await registration.json()) as { client_id: string }).client_id;
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: t.service.registry.canonical.audience,
      scope: "offline_access",
      state: "consent-test",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorize = await t.fetch(`/auth/oauth2/authorize?${params}`, {
      cookie: login.cookie,
    });
    const consent = new URL(authorize.headers.get("location")!, t.origin);
    expect(consent.pathname).toBe("/consent");
    const page = readOAuthPageQuery(consent.search);

    await expect(apiFor(login.cookie).consent(true, page.continuation!)).resolves.toMatchObject({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4242\/callback\?/),
    });
  });

  test("preserves a signature-only continuation and excludes page-only fields", () => {
    const page = readOAuthPageQuery("?sig=signature%2Bvalue&next=%2Fsettings");
    expect(page.params.get("next")).toBe("/settings");
    expect(page.continuation).toBe("sig=signature%2Bvalue");
  });

  test("does not invent a continuation for an ordinary page query", () => {
    const page = readOAuthPageQuery("?next=%2Fsettings");
    expect(page.params.get("next")).toBe("/settings");
    expect(page.continuation).toBeUndefined();
  });
});
