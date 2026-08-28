import { describe, expect, test } from "vite-plus/test";
import {
  AUDITED_PATHS,
  decodeCursor,
  decodeOwnJwtPayload,
  encodeCursor,
  uuidv7,
} from "../src/audit.ts";

const jwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJFZERTQSJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("uuidv7 sorts by time and is a valid v7 UUID", () => {
  const a = uuidv7(new Date("2026-01-01T00:00:00Z"));
  const b = uuidv7(new Date("2026-01-01T00:00:00.001Z"));
  expect(a < b).toBe(true);
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("cursor round-trip", () => {
  const at = new Date("2026-08-28T01:02:03.004Z");
  expect(decodeCursor(encodeCursor(at, "abc"))).toEqual({ at, id: "abc" });
  expect(decodeCursor(undefined)).toBeUndefined();
  expect(() => decodeCursor("nope")).toThrow(TypeError);
});

describe("extractors", () => {
  test("login only when a session was created", () => {
    const x = AUDITED_PATHS["/callback/:id"];
    expect(
      x({
        path: "/callback/:id",
        context: { newSession: { user: { id: "u1", admittedVia: "allowlist" } } },
      }),
    ).toEqual({
      type: "login",
      userId: "u1",
      via: "allowlist",
    });
    expect(x({ path: "/callback/:id", context: { newSession: null } })).toBeUndefined();
  });

  test("token.issued from our own access token", () => {
    const x = AUDITED_PATHS["/oauth2/token"];
    const token = jwt({ sub: "u1", client_id: "c1", aud: ["https://a", "https://b"], jti: "j1" });
    expect(
      x({
        path: "/oauth2/token",
        body: { grant_type: "refresh_token" },
        context: { returned: { access_token: token } },
      }),
    ).toEqual({
      type: "token.issued",
      userId: "u1",
      clientId: "c1",
      grantType: "refresh_token",
      audiences: ["https://a", "https://b"],
      jti: "j1",
    });
    expect(
      x({ path: "/oauth2/token", context: { returned: { error: "invalid_grant" } } }),
    ).toBeUndefined();
    expect(decodeOwnJwtPayload("opaque")).toBeUndefined();
  });

  test("consent granted / denied", () => {
    const x = AUDITED_PATHS["/oauth2/consent"];
    const ctx = (accept: boolean) => ({
      path: "/oauth2/consent",
      body: {
        accept,
        oauth_query: "client_id=c1&resource=https%3A%2F%2Fa&resource=https%3A%2F%2Fb",
      },
      context: {
        session: { user: { id: "u1" } },
        returned: { redirect: true, url: "http://127.0.0.1/cb?code=x" },
      },
    });
    expect(x(ctx(true))).toEqual({
      type: "consent.granted",
      userId: "u1",
      clientId: "c1",
      resources: ["https://a", "https://b"],
    });
    expect(x(ctx(false))).toEqual({ type: "consent.denied", userId: "u1", clientId: "c1" });
    expect(x({ ...ctx(true), context: { session: null, returned: {} } })).toBeUndefined();
  });

  test("client.registered", () => {
    const x = AUDITED_PATHS["/oauth2/register"];
    expect(
      x({
        path: "/oauth2/register",
        context: {
          returned: {
            client_id: "c1",
            client_name: "IDE",
            redirect_uris: ["http://127.0.0.1:1/cb"],
          },
        },
      }),
    ).toEqual({
      type: "client.registered",
      clientId: "c1",
      name: "IDE",
      redirectUris: ["http://127.0.0.1:1/cb"],
      discovery: "dcr",
    });
  });
});
