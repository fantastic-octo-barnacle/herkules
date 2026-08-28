/**
 * Done-predicate 1 minus the real IDEs: the real auth service (PGlite, fake
 * GitHub) logs a user in, an MCP client registers, consents and gets a token,
 * and the directory verifies it cross-process-style (JWKS over fetch) and
 * resolves names through the user-info API.
 */
import { createTestService, type TestService } from "@herkules/auth/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createService } from "../src/main.ts";
import { connect, fetchVia, legacyCall } from "./helpers.ts";

describe("directory against the real auth service", () => {
  let auth: TestService;
  let directory: ReturnType<typeof createService>;
  let fetch: typeof globalThis.fetch;
  let resource: string;
  let alice: { cookie: string; userId: string };
  let bob: { cookie: string; userId: string };

  beforeAll(async () => {
    auth = await createTestService();
    resource = `${auth.origin}/mcp/directory`;
    directory = createService({
      env: { PUBLIC_ORIGIN: auth.origin, NODE_ENV: "test" },
      fetch: fetchVia(auth.app),
    });
    fetch = fetchVia(directory.app);
    auth.github.user({ id: 1, login: "alice", name: "Alice Liddell", org: "active" });
    auth.github.user({ id: 2, login: "bob", org: "active" });
    const a = await auth.login("alice");
    const b = await auth.login("bob");
    if (!a.ok || !b.ok) throw new Error("login failed");
    alice = a;
    bob = b;
  });
  afterAll(async () => {
    await directory.close();
    await auth.close();
  });

  it("login -> DCR -> consent -> token -> whoami names the caller", async () => {
    const session = await auth.mcpClient(alice.cookie, resource);
    const client = await connect(resource, session.accessToken, fetch);
    try {
      const me = await client.callTool({ name: "whoami", arguments: {} });
      expect(me.isError).toBeFalsy();
      expect(me.structuredContent).toMatchObject({
        id: alice.userId,
        displayName: "Alice Liddell",
        role: "member",
        clientId: session.clientId,
        resource,
      });

      const list = await client.callTool({ name: "list_members", arguments: {} });
      const members = (list.structuredContent as { members: { id: string }[] }).members;
      expect(members.map((m) => m.id).sort()).toEqual([alice.userId, bob.userId].sort());

      const one = await client.callTool({ name: "get_member", arguments: { id: bob.userId } });
      expect(one.structuredContent).toMatchObject({ id: bob.userId, displayName: "bob" });
    } finally {
      await client.close();
    }
  });

  it("a token minted for another registry audience is refused here", async () => {
    const session = await auth.mcpClient(alice.cookie, `${auth.origin}/api/notes`);
    const res = await legacyCall(resource, session.accessToken, fetch, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("a disabled member's live token still verifies here but the directory refuses to resolve it", async () => {
    const session = await auth.mcpClient(bob.cookie, resource);
    await auth.makeAdmin(alice.userId);
    const disabled = await auth.fetch(`/auth/api/admin/users/${bob.userId}/disabled`, {
      method: "PUT",
      cookie: alice.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true, reason: "test" }),
    });
    expect(disabled.status).toBe(200);
    const client = await connect(resource, session.accessToken, fetch);
    try {
      // JWTs are unrevocable for their ≤15 minutes (FRAME accepts this); the user-info API closes the gap.
      const list = await client.callTool({ name: "list_members", arguments: {} });
      expect(list.isError).toBe(true);
      expect(JSON.stringify(list.content)).toContain("account_disabled");
    } finally {
      await client.close();
    }
  });
});
