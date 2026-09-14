import { describe, expect, it } from "vite-plus/test";
import { createApi } from "../src/api.ts";
import { sessionQuery } from "../src/session.tsx";

function apiReturning(body: string, contentType = "application/json") {
  return createApi(async () => new Response(body, { headers: { "content-type": contentType } }));
}

describe("session response boundary", () => {
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
    const session = { user: { id: "u", role: "admin" }, session: { id: "s" } };
    await expect(apiReturning(JSON.stringify(session)).session()).resolves.toEqual(session);
  });
});
