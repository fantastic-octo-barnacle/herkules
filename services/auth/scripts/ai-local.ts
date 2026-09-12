/** Development-only identity fixture. Never imported by the production entrypoint. */
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createTestService } from "../src/testing.ts";
if (process.env.AI_LOCAL_FIXTURES !== "true") throw new Error("AI_LOCAL_FIXTURES=true is required");
const t = await createTestService({
  env: {
    PUBLIC_ORIGIN: "http://localhost:4012",
    DATABASE_URL: process.env.AI_LOCAL_AUTH_DB ?? "pglite://memory",
    AI_PORTAL_ORIGIN: "http://localhost:4010",
    AI_CLIENT_SECRET: (await readFile(process.env.AI_CLIENT_SECRET_FILE!, "utf8")).trim(),
    AI_SYNC_SECRET: (await readFile(process.env.AI_SYNC_SECRET_FILE!, "utf8")).trim(),
  },
});
for (const [i, login] of ["alice", "bob"].entries())
  t.github.user({ id: 100 + i, login, name: `${login} (local test)`, org: "active" });
const app = new Hono();
const escape = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
app.get("/login", (c) =>
  c.html(`<h1>Local AI test sign-in</h1><p>Test identities only. No GitHub credentials are used.</p>
<form method="post" action="/dev/login"><input type="hidden" name="oauth_query" value="${escape(new URL(c.req.url).search.slice(1))}">
<button name="user" value="alice">Sign in as Alice</button> <button name="user" value="bob">Sign in as Bob</button></form>`),
);
app.post("/dev/login", async (c) => {
  const input = await c.req.parseBody();
  if (typeof input.user !== "string" || !["alice", "bob"].includes(input.user))
    return c.text("Unknown fixture", 400);
  const login = await t.login(input.user, {
    oauthQuery: typeof input.oauth_query === "string" ? input.oauth_query || undefined : undefined,
  });
  if (!login.ok) return c.text("Fixture sign-in refused", 403);
  for (const cookie of login.cookie.split("; "))
    c.header("Set-Cookie", `${cookie}; Path=/; HttpOnly; SameSite=Lax`, { append: true });
  return c.redirect(
    typeof input.oauth_query === "string" && input.oauth_query
      ? `/auth/oauth2/authorize?${input.oauth_query}`
      : login.location || "/",
  );
});
app.post("/dev/:action/:user", async (c) => {
  // Local smoke tests use this to exercise issuer revocation against a real New API session.
  const login = String(c.req.param("user"));
  if (!["alice", "bob"].includes(login)) return c.notFound();
  const user = await t.service.db.users.byLogin(login);
  if (!user) return c.notFound();
  const action = c.req.param("action");
  if (!["enable", "disable"].includes(action)) return c.notFound();
  await t.service.users.setDisabled(
    { kind: "system", job: "ai-local-test" },
    user.id,
    action === "disable",
  );
  return c.json({ disabled: true });
});
app.get("/", (c) =>
  c.html(
    '<p>Local identity fixture is running. <a href="http://localhost:4010/login">Open AI portal</a></p>',
  ),
);
app.route("/", t.app);
// Docker reaches the host fixture through host.docker.internal; this is opt-in test infrastructure.
const server = serve({ fetch: app.fetch, port: 4012, hostname: "127.0.0.1" });
process.on("SIGTERM", () => {
  server.close();
  void t.close();
});
