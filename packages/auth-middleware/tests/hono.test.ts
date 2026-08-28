import { Hono } from "hono";
import { expect, test } from "vite-plus/test";
import { honoAuth, type AuthEnv } from "../src/hono.ts";
import { apiResource } from "../src/index.ts";
import { createTestIssuer } from "../src/testing.ts";

const RESOURCE = "https://herkules.dev/api/files";

test("honoAuth: typed principal on success, verifier response on failure", async () => {
  const issuer = await createTestIssuer();
  const auth = apiResource({ resource: RESOURCE, issuer: issuer.issuer, fetch: issuer.fetch });
  const app = new Hono<AuthEnv>();
  app.use("/api/*", honoAuth(auth));
  app.get("/api/files", (c) => c.json({ me: c.var.principal.subject }));
  app.delete("/api/files", honoAuth(auth, { role: "admin" }), (c) => c.json({ ok: true }));

  const anon = await app.request("/api/files");
  expect(anon.status).toBe(401);
  expect(anon.headers.get("www-authenticate")).toBe(
    'Bearer resource_metadata="https://herkules.dev/.well-known/oauth-protected-resource/api/files"',
  );

  const token = await issuer.mint({ audience: RESOURCE, subject: "u9" });
  const ok = await app.request("/api/files", { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ me: "u9" });

  const denied = await app.request("/api/files", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(denied.status).toBe(403);
  expect(denied.headers.has("www-authenticate")).toBe(false);
});
