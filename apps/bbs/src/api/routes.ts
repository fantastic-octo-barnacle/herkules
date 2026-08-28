/**
 * The REST surface, in route order, and the source of `AppType` — the SPA's
 * whole type contract. No OpenAPI, no codegen, no `/api/v1` compatibility:
 * `hc<AppType>` reads this file at compile time.
 *
 * MECHANICAL CONSTRAINT: Hono RPC infers from ONE chained expression. A route
 * added with `api.get(...)` on a later statement compiles, runs, and is
 * invisible to `hc`. Every route is in the single chain below and `AppType` is
 * its type. `basePath("/api")` (mounted with `app.route("/", …)`) is what makes
 * the RPC client's paths match the mounted paths.
 *
 * ACCESS POLICY: every route is a read and v1 has NO writes at all — no
 * POST/PUT/PATCH/DELETE, and no table an HTTP request could reach
 * (`import_runs` is the CLI's; everything else is truncate-reload cargo). So
 * FRAME's "every non-read requires a member" is vacuously satisfied, and
 * `oauth.guard()` protects exactly one route, `/api/me`, because knowing who
 * you are requires being someone. `/api/viewer` answers "who is looking?" with
 * 200 + null for nobody, so anonymous page loads never 401; `/api/me` answers
 * "who am I?" and is done-predicate 3's member-only route (401 anonymous).
 */
import type { Principal } from "@herkules/auth-middleware";
import type { HonoOAuth, ViewerEnv } from "@herkules/oauth-client/hono";
import { Hono } from "hono";
import { z } from "zod";

import type { ArticleId, Library, Viewer } from "../library/index.ts";
import { QueryError, entityKey } from "../library/index.ts";
import type { UserInfo } from "@herkules/auth-middleware/userinfo";
import * as s from "./schemas.ts";

export interface ApiDeps {
  readonly library: Library;
  readonly oauth: HonoOAuth;
  /** Display name and avatar, fetched with the caller's own token (mcp-directory's pattern). */
  readonly userInfo: UserInfo;
  readonly onError?: (error: Error) => void;
}

const CONTENT_TYPES = {
  text: "text/plain; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

export function createApi(deps: ApiDeps) {
  const lib = deps.library;
  const notFound = { error: "not_found", error_description: "no such row" } as const;
  const id = (raw: string) => s.articleIdParam.parse(raw) as ArticleId;

  return new Hono<ViewerEnv>()
    .basePath("/api")
    .use("*", deps.oauth.viewer())
    .onError((err, c) => {
      if (err instanceof z.ZodError) {
        return c.json({ error: "invalid_request", error_description: z.prettifyError(err) }, 400);
      }
      if (err instanceof QueryError) {
        return c.json({ error: err.code, error_description: err.message }, 400);
      }
      deps.onError?.(err);
      return c.json({ error: "internal", error_description: "internal error" }, 500);
    })
    .get("/articles", async (c) => {
      const q = s.articleListQuery.parse(c.req.query());
      return c.json(await lib.articles({ ...q, cursor: q.cursor as never }));
    })
    .get("/articles/:id", async (c) => {
      const article = await lib.article(id(c.req.param("id")));
      return article ? c.json(article) : c.json(notFound, 404);
    })
    .get("/articles/:id/content", async (c) => {
      const { format } = s.contentQuery.parse(c.req.query());
      const content = await lib.content(id(c.req.param("id")), format);
      if (!content) return c.json(notFound, 404);
      return c.body(content.body, 200, {
        "content-type": CONTENT_TYPES[content.format],
        "x-content-format": content.format,
        "x-content-type-options": "nosniff",
      });
    })
    .get("/articles/:id/ai", async (c) => {
      const ai = await lib.ai(id(c.req.param("id")));
      return ai ? c.json(ai) : c.json(notFound, 404);
    })
    .get("/tags", async (c) => c.json(await lib.tags()))
    .get("/search", async (c) => {
      const q = s.searchQuery.parse(c.req.query());
      return c.json(await lib.search({ ...q, cursor: q.cursor as never }));
    })
    .get("/kb/browse", async (c) =>
      c.json(await lib.kbBrowse(s.kbBrowseQuery.parse(c.req.query()))),
    )
    .get("/kb/entities", async (c) =>
      c.json({ items: await lib.entities(s.entityListQuery.parse(c.req.query())) }),
    )
    .get("/kb/entities/:name", async (c) => {
      const detail = await lib.entity(entityKey(s.entityNameParam.parse(c.req.param("name"))));
      return detail ? c.json(detail) : c.json(notFound, 404);
    })
    .get("/status", async (c) => c.json(await lib.status()))
    .get("/viewer", async (c) => c.json({ viewer: await viewerOf(c.var.principal, deps.userInfo) }))
    .get("/me", deps.oauth.guard({ role: "member" }), async (c) =>
      c.json(await viewerOf(c.var.principal, deps.userInfo)),
    );
}

/** What `hc<AppType>` is instantiated with in the SPA. Exported as a type only. */
export type AppType = ReturnType<typeof createApi>;

/**
 * Principal -> Viewer. The archive knows a `sub` and a role; display name and
 * avatar come from `GET /auth/api/users/:id` with the caller's OWN token, as
 * services/mcp-directory does — this app never holds a credential for user
 * data, and a banned user's token is refused there. A user-info outage
 * degrades to id + role rather than failing the request. `undefined` -> null.
 */
export function viewerOf(
  principal: Principal | undefined,
  userInfo: UserInfo,
): Promise<Viewer | null> {
  void principal;
  void userInfo;
  // TODO if (!principal) return null
  //      m = await userInfo.member(principal.token, principal.subject).catch(() => undefined)
  //      return { id: principal.subject, role: principal.role, displayName: m?.displayName ?? principal.subject, avatarUrl: m?.avatarUrl ?? null }
  throw new Error("not implemented");
}
