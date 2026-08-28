/**
 * The directory against the middleware's test issuer and an in-memory
 * user-info API: challenge shape, audience binding, both protocol eras, and
 * graceful degradation when the auth service is unreachable.
 */
import { mcpResource } from "@herkules/auth-middleware";
import { createTestIssuer, type TestIssuer } from "@herkules/auth-middleware/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createApp } from "../src/app.ts";
import type { Member, UserInfo } from "@herkules/auth-middleware/userinfo";
import { UserInfoError } from "@herkules/auth-middleware/userinfo";
import { connect, fetchVia, legacyCall, rpcResult } from "./helpers.ts";

const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/mcp/directory`;
const ISSUER = `${ORIGIN}/auth`;
const PRM = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/directory`;

const MEMBERS: readonly Member[] = [
  {
    id: "u_alice",
    displayName: "Alice",
    avatarUrl: `${ORIGIN}/auth/avatars/u_alice`,
    githubId: "1",
  },
  { id: "u_bob", displayName: "Bob", avatarUrl: `${ORIGIN}/auth/avatars/u_bob`, githubId: "2" },
];

function fakeUserInfo(state: { down: boolean; seenTokens: string[] }): UserInfo {
  const guard = (token: string) => {
    state.seenTokens.push(token);
    if (state.down) throw new UserInfoError(503, "unavailable", "auth service down");
  };
  return {
    async member(token, id) {
      guard(token);
      return MEMBERS.find((m) => m.id === id);
    },
    async members(token) {
      guard(token);
      return MEMBERS;
    },
    async me(token) {
      guard(token);
      return {
        kind: "token",
        userId: "u_alice",
        role: "member",
        clientId: "c",
        audiences: [RESOURCE],
        jti: "j",
      };
    },
  };
}

describe("mcp-directory", () => {
  let issuer: TestIssuer;
  let app: ReturnType<typeof createApp>;
  let fetch: typeof globalThis.fetch;
  const state = { down: false, seenTokens: [] as string[] };

  beforeEach(async () => {
    issuer = await createTestIssuer({ issuer: ISSUER });
    state.down = false;
    state.seenTokens = [];
    app = createApp({
      auth: mcpResource({ resource: RESOURCE, issuer: ISSUER, fetch: issuer.fetch }),
      userInfo: fakeUserInfo(state),
    });
    fetch = fetchVia(app.app);
  });
  afterEach(() => app.close());

  it("healthz is open", async () => {
    const res = await fetch(`${RESOURCE}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("no token: 401 with the PRM pointer that starts IDE discovery", async () => {
    const res = await legacyCall(RESOURCE, undefined, fetch, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM}"`);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
  });

  it("token for another audience: 401 invalid_token", async () => {
    const token = await issuer.mint({ audience: `${ORIGIN}/mcp/other`, subject: "u_alice" });
    const res = await legacyCall(RESOURCE, token, fetch, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("expired token: 401 token expired", async () => {
    const token = await issuer.mint({ audience: RESOURCE, subject: "u_alice", expiresIn: -120 });
    const res = await legacyCall(RESOURCE, token, fetch, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error_description="token expired"');
  });

  it("2025-era stateless POST (today's Claude Code / VS Code): whoami answers", async () => {
    const token = await issuer.mint({
      audience: RESOURCE,
      subject: "u_alice",
      role: "admin",
      clientId: "ide_1",
    });
    const listed = await legacyCall(RESOURCE, token, fetch, "tools/list");
    expect(listed.status).toBe(200);
    const tools = (await rpcResult(listed)) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual([
      "get_member",
      "list_members",
      "whoami",
    ]);

    const called = await legacyCall(RESOURCE, token, fetch, "tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(called.status).toBe(200);
    const body = (await rpcResult(called)) as { result: { structuredContent: unknown } };
    expect(body.result.structuredContent).toMatchObject({
      id: "u_alice",
      displayName: "Alice",
      role: "admin",
      clientId: "ide_1",
      resource: RESOURCE,
    });
    // The caller's own token was forwarded, never anything else.
    expect(new Set(state.seenTokens)).toEqual(new Set([token]));
  });

  it("SDK 2.0 client: list_members and get_member", async () => {
    const token = await issuer.mint({ audience: RESOURCE, subject: "u_bob" });
    const client = await connect(RESOURCE, token, fetch);
    try {
      const list = await client.callTool({ name: "list_members", arguments: {} });
      expect(list.structuredContent).toEqual({ members: MEMBERS });

      const one = await client.callTool({ name: "get_member", arguments: { id: "u_alice" } });
      expect(one.structuredContent).toEqual(MEMBERS[0]);

      const none = await client.callTool({ name: "get_member", arguments: { id: "u_nobody" } });
      expect(none.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("auth service down: whoami still answers from the token; list_members is a tool error", async () => {
    const token = await issuer.mint({ audience: RESOURCE, subject: "u_alice" });
    state.down = true;
    const client = await connect(RESOURCE, token, fetch);
    try {
      const me = await client.callTool({ name: "whoami", arguments: {} });
      expect(me.isError).toBeFalsy();
      expect(me.structuredContent).toMatchObject({ id: "u_alice", role: "member" });
      expect(me.structuredContent).not.toHaveProperty("displayName");

      const list = await client.callTool({ name: "list_members", arguments: {} });
      expect(list.isError).toBe(true);
      expect(JSON.stringify(list.content)).toContain("unavailable");
    } finally {
      await client.close();
    }
  });

  it("JWKS is fetched once across requests", async () => {
    const token = await issuer.mint({ audience: RESOURCE, subject: "u_alice" });
    for (let i = 0; i < 3; i += 1) {
      const res = await legacyCall(RESOURCE, token, fetch, "tools/list");
      expect(res.status).toBe(200);
    }
    expect(issuer.jwksFetches).toBe(1);
  });
});
