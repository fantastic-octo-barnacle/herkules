import { describe, expect, it } from "vite-plus/test";
import { createApi } from "../src/api.ts";
import { sessionQuery } from "../src/session.tsx";

function apiReturning(body: string, contentType = "application/json") {
  return createApi(async () => new Response(body, { headers: { "content-type": contentType } }));
}

const validSession = {
  user: {
    id: "u",
    name: "Member",
    email: "member@example.com",
    image: null,
    role: "admin",
    githubLogin: "member",
    githubId: "123",
    createdAt: "2026-09-14T00:00:00Z",
  },
  session: { id: "s", expiresAt: "2026-09-15T00:00:00Z", createdAt: "2026-09-14T00:00:00Z" },
};

describe("session response boundary", () => {
  for (const [section, fields] of Object.entries({
    user: ["id", "name", "email", "image", "githubLogin", "githubId", "createdAt"],
    session: ["id", "expiresAt", "createdAt"],
  })) {
    it.each(fields)(`rejects missing required ${section}.%s`, async (field) => {
      const value: Record<string, Record<string, unknown>> = structuredClone(validSession);
      delete value[section]![field];
      await expect(apiReturning(JSON.stringify(value)).session()).rejects.toMatchObject({
        code: "invalid_response",
      });
    });
  }

  it("rejects the asset preview's HTML fallback and leaves its session signed out", async () => {
    const api = apiReturning('<html><div id="root"></div></html>', "text/html");
    await expect(api.session()).rejects.toMatchObject({ code: "invalid_response" });
    const query = sessionQuery(api);
    // Exercise the same query function used by SessionProvider and route guards.
    await expect(query.queryFn!({} as never)).resolves.toBeNull();
  });

  it.each(["{}", '{"user":null}', '{"user":{"id":"u"}}', "[]"])(
    "rejects malformed sessions: %s",
    async (body) => {
      await expect(apiReturning(body).session()).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  it("preserves signed-out and valid signed-in sessions", async () => {
    await expect(apiReturning("null").session()).resolves.toBeNull();
    const session = validSession;
    await expect(apiReturning(JSON.stringify(session)).session()).resolves.toEqual(session);
  });
});
