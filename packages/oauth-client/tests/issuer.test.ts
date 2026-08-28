import { describe, expect, test } from "vite-plus/test";
import {
  basicAuthorization,
  createIssuerClient,
  endpointsFor,
  type GrantResult,
} from "../src/issuer.ts";

const endpoints = endpointsFor("https://h.test/auth/", "http://auth:3001/auth");

interface Seen {
  url: string;
  headers: Headers;
  body: URLSearchParams;
}

/** A token endpoint that answers with `reply` and records what it was sent. */
function stub(reply: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: req.headers, body: new URLSearchParams(await req.text()) });
    return reply();
  };
  const client = createIssuerClient({
    endpoints,
    client: { id: "bbs", secret: "s3cret:with/odd chars" },
    redirectUri: "https://bbs.test/callback",
    fetch,
  });
  return { client, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("endpointsFor", () => {
  test("derives browser-facing authorize from the issuer and server-side token/revoke from the internal address", () => {
    expect(endpoints).toEqual({
      authorize: "https://h.test/auth/oauth2/authorize",
      token: "http://auth:3001/auth/oauth2/token",
      revoke: "http://auth:3001/auth/oauth2/revoke",
    });
  });
});

describe("createIssuerClient", () => {
  test("exchange: client_secret_basic (form-encoded per RFC 6749), no resource, no client_id in the body", async () => {
    const { client, seen } = stub(() => json(200, { access_token: "at", refresh_token: "rt" }));
    const r = await client.exchange("code1", "verifier1");
    expect(r).toEqual({ kind: "tokens", tokens: { accessToken: "at", refreshToken: "rt" } });
    const call = seen[0]!;
    expect(call.url).toBe(endpoints.token);
    expect(call.headers.get("authorization")).toBe(
      basicAuthorization("bbs", "s3cret:with/odd chars"),
    );
    expect(
      Buffer.from(call.headers.get("authorization")!.slice("Basic ".length), "base64").toString(),
    ).toBe(`bbs:${encodeURIComponent("s3cret:with/odd chars")}`);
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(call.body)).toEqual({
      grant_type: "authorization_code",
      code: "code1",
      redirect_uri: "https://bbs.test/callback",
      code_verifier: "verifier1",
    });
  });

  test("refresh sends only grant_type and refresh_token", async () => {
    const { client, seen } = stub(() => json(200, { access_token: "at2", refresh_token: "rt2" }));
    await client.refresh("rt1");
    expect(Object.fromEntries(seen[0]!.body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt1",
    });
  });

  test("classification of every answer", async () => {
    const cases: [Response | Error, GrantResult["kind"], Partial<GrantResult>][] = [
      [json(200, { access_token: "at" }), "unavailable", {}],
      [json(200, { refresh_token: "rt" }), "unavailable", {}],
      [
        json(401, { error: "invalid_client", error_description: "bad" }),
        "client_auth",
        { description: "bad" },
      ],
      [json(400, { error: "invalid_client" }), "client_auth", {}],
      [
        json(400, { error: "invalid_grant", error_description: "revoked" }),
        "rejected",
        { error: "invalid_grant", description: "revoked" },
      ],
      [json(400, { error: "unauthorized_client" }), "rejected", { error: "unauthorized_client" }],
      [json(500, { error: "server_error" }), "unavailable", {}],
      [new Response("<html>", { status: 502 }), "unavailable", {}],
      [new Response("not json", { status: 200 }), "unavailable", {}],
      [new TypeError("fetch failed"), "unavailable", {}],
    ];
    for (const [reply, kind, extra] of cases) {
      const { client } = stub(() => (reply instanceof Error ? Promise.reject(reply) : reply));
      const r = await client.refresh("rt");
      expect(r.kind, String(reply instanceof Error ? reply : reply.status)).toBe(kind);
      expect(r).toMatchObject(extra);
    }
  });

  test("revoke: true on 2xx, false otherwise, never throws; RFC 7009 body", async () => {
    const ok = stub(() => json(200, {}));
    expect(await ok.client.revoke("rt1")).toBe(true);
    expect(ok.seen[0]!.url).toBe(endpoints.revoke);
    expect(Object.fromEntries(ok.seen[0]!.body)).toEqual({
      token: "rt1",
      token_type_hint: "refresh_token",
    });
    expect(await stub(() => json(400, { error: "invalid_request" })).client.revoke("rt1")).toBe(
      false,
    );
    expect(await stub(() => Promise.reject(new Error("down"))).client.revoke("rt1")).toBe(false);
  });
});
