/**
 * The FRAME kill-criterion probes for apps/bbs (apps/bbs/FRAME.md): can this
 * issuer serve a first-party CONFIDENTIAL client on ANOTHER origin that skips
 * consent and mints an `api/<name>` token, by configuration alone? The tests in
 * this file are the verification: they are the record, not a pointer to one.
 *
 * The first describe drives a DIRECTLY INSERTED row (what ensureFirstPartyClients
 * writes, minus the seeding code) so the probes hold independently of clients.ts;
 * the second drives the real seeded `bbs` client from config.
 */
import { createHash, randomBytes } from "node:crypto";
import { apiResource } from "@herkules/auth-middleware";
import { fetchVia } from "@herkules/auth-middleware/testing";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { hashClientSecret, clientSecretStore } from "../src/secrets.ts";
import { createTestService, type TestService } from "../src/testing.ts";

const BBS_ORIGIN = "https://bbs.example.test";
const LOCAL_REDIRECT = "http://localhost:3003/callback";
const SECRET = "bbs-secret-".padEnd(48, "x");

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;

/** Top-level navigation to /oauth2/authorize: no Origin header (a GET from the browser's address bar). */
async function authorize(
  t: TestService,
  cookie: string,
  q: { clientId: string; redirectUri: string; audience: string },
) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: q.clientId,
    redirect_uri: q.redirectUri,
    resource: q.audience,
    scope: "offline_access",
    state: "st-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = await t.app.request(`${t.issuer}/oauth2/authorize?${params.toString()}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  const url = location ? new URL(location, t.origin) : undefined;
  return {
    status: res.status,
    location,
    code: url?.searchParams.get("code") ?? undefined,
    state: url?.searchParams.get("state") ?? undefined,
    verifier,
    body: res.status >= 400 ? await res.text() : "",
  };
}

/** Server-to-server token call: no Origin, no cookie, credentials only in the header (or body, to prove that is refused). */
async function token(
  t: TestService,
  form: Record<string, string>,
  authorization?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await t.app.request(`${t.issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization ? { authorization } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("a directly inserted confidential first-party client", () => {
  let t: TestService;
  let cookie: string;
  let audience: string;
  const clientId = "bbs-probe";
  beforeAll(async () => {
    t = await createTestService();
    t.github.user({ id: 1, login: "alice", org: "active" });
    const login = await t.login("alice");
    if (!login.ok) throw new Error("login failed");
    cookie = login.cookie;
    audience = t.service.registry.entries.find((e) => e.kind === "api")!.audience;
    const at = new Date();
    await t.service.db.clients.insert({
      id: crypto.randomUUID(),
      clientId,
      clientSecret: await hashClientSecret(SECRET),
      name: "probe",
      redirectUris: [`${BBS_ORIGIN}/callback`, LOCAL_REDIRECT],
      skipConsent: true,
      tokenEndpointAuthMethod: "client_secret_basic",
      applicationType: "native",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      requirePKCE: true,
      disabled: false,
      createdAt: at,
      updatedAt: at,
    });
  });
  afterAll(() => t.close());

  test("probe 2+3: authorize on a foreign origin skips consent; trustedOrigins does not apply", async () => {
    const a = await authorize(t, cookie, {
      clientId,
      redirectUri: `${BBS_ORIGIN}/callback`,
      audience,
    });
    expect(a.status, a.body).toBe(302);
    expect(a.location.startsWith(`${BBS_ORIGIN}/callback?`), a.location).toBe(true);
    expect(a.location).not.toContain("consent");
    expect(a.code).toBeDefined();
    expect(a.state).toBe("st-1");
  });

  test("probe 1+2: Basic is accepted, the body secret is refused, aud is a single string, a refresh token is minted", async () => {
    const fresh = async () => {
      const a = await authorize(t, cookie, {
        clientId,
        redirectUri: `${BBS_ORIGIN}/callback`,
        audience,
      });
      return {
        grant_type: "authorization_code",
        code: a.code!,
        redirect_uri: `${BBS_ORIGIN}/callback`,
        code_verifier: a.verifier,
      };
    };
    // client_secret_post against a client_secret_basic row: refused. (Better Auth burns the
    // code on a failed attempt — RFC 6749 §4.1.2 — so every negative case takes a fresh one.)
    const post = await token(t, { ...(await fresh()), client_id: clientId, client_secret: SECRET });
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(post.body.error).toBe("invalid_client");
    const wrong = await token(t, await fresh(), basic(clientId, "nope"));
    expect(wrong.body.error).toBe("invalid_client");

    const ok = await token(t, await fresh(), basic(clientId, SECRET));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const access = ok.body.access_token as string;
    expect(typeof ok.body.refresh_token).toBe("string");
    expect(decodeJwt(access).aud).toBe(audience);
    expect(ok.body.id_token).toBeUndefined();

    const rs = apiResource({
      resource: audience,
      issuer: t.issuer,
      fetch: fetchVia(t.app),
    });
    const outcome = await rs.verifyToken(access);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.principal).toMatchObject({ clientId, role: "member" });

    // Refresh with Basic rotates.
    const refreshed = await token(
      t,
      { grant_type: "refresh_token", refresh_token: ok.body.refresh_token as string },
      basic(clientId, SECRET),
    );
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(ok.body.refresh_token);
  });

  test("probe 4: the same row accepts the http://localhost dev redirect", async () => {
    const a = await authorize(t, cookie, { clientId, redirectUri: LOCAL_REDIRECT, audience });
    expect(a.status, a.body).toBe(302);
    expect(a.location.startsWith(`${LOCAL_REDIRECT}?`), a.location).toBe(true);
    const ok = await token(
      t,
      {
        grant_type: "authorization_code",
        code: a.code!,
        redirect_uri: LOCAL_REDIRECT,
        code_verifier: a.verifier,
      },
      basic(clientId, SECRET),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe("the seeded bbs client", () => {
  let t: TestService;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestService({
      env: { BBS_ORIGIN, BBS_CLIENT_SECRET: SECRET },
      resources: [
        { name: "catalog", kind: "mcp", title: "catalog", canonical: true },
        { name: "bbs", kind: "api", title: "bbs" },
      ],
    });
    t.github.user({ id: 1, login: "alice", org: "active" });
    const login = await t.login("alice");
    if (!login.ok) throw new Error("login failed");
    cookie = login.cookie;
  });
  afterAll(() => t.close());

  test("probe 5: storeClientSecret is forwarded — our verify runs at the token endpoint", async () => {
    const audience = t.service.registry.byAudience(`${t.origin}/api/bbs`)!.audience;
    const a = await authorize(t, cookie, {
      clientId: "bbs",
      redirectUri: `${BBS_ORIGIN}/callback`,
      audience,
    });
    expect(a.status, a.body).toBe(302);
    const verify = vi.spyOn(clientSecretStore, "verify");
    const ok = await token(
      t,
      {
        grant_type: "authorization_code",
        code: a.code!,
        redirect_uri: `${BBS_ORIGIN}/callback`,
        code_verifier: a.verifier,
      },
      basic("bbs", SECRET),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toBe(SECRET);
    verify.mockRestore();
  });

  test("the seeded row is reconciled on every field, secret included", async () => {
    const row = await t.service.db.clients.byId("bbs");
    expect(row).toMatchObject({
      clientId: "bbs",
      redirectUris: [`${BBS_ORIGIN}/callback`],
      tokenEndpointAuthMethod: "client_secret_basic",
      skipConsent: true,
      grantTypes: ["authorization_code", "refresh_token"],
    });
    // Drift the row the way a half-deployed config would, then boot again: seeding repairs it.
    await t.service.db.clients.update("bbs", {
      redirectUris: ["https://old.example/callback"],
      tokenEndpointAuthMethod: "none",
      clientSecret: null,
    });
    const { ensureFirstPartyClients } = await import("../src/clients.ts");
    await ensureFirstPartyClients(t.service.db, t.service.config, () => new Date());
    const fixed = await t.service.db.clients.byId("bbs");
    expect(fixed?.redirectUris).toEqual([`${BBS_ORIGIN}/callback`]);
    expect(fixed?.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(fixed?.clientSecret).toBe(await hashClientSecret(SECRET));
  });

  test("without BBS_ORIGIN the bbs row is not seeded and the dev-token client still is", async () => {
    const bare = await createTestService();
    try {
      expect(await bare.service.db.clients.byId("bbs")).toBeUndefined();
      expect(await bare.service.db.clients.byId("herkules-web")).toBeDefined();
    } finally {
      await bare.close();
    }
  });
});
