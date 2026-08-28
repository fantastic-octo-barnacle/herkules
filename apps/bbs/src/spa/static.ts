/**
 * Serving the built SPA from the same container, with head injection. No repo
 * precedent — `services/web` is a Caddy image with `try_files` — so the shape
 * is stated here:
 *
 *   GET /assets/*                     serveStatic, `cache-control: public, max-age=31536000, immutable`
 *   GET /favicon.*, /robots.txt, /fonts/*   serveStatic, `public, max-age=3600`
 *   GET *                             the SPA document, `cache-control: no-cache`; head injected for
 *                                     /articles/:id and /kb/:name. UNKNOWN ids get the plain shell
 *                                     with status 404 so crawlers do not index them (the SPA renders
 *                                     its own not-found screen; a 404 document is still a document).
 *
 * ROUTE ORDER in app.ts is load-bearing: the fallback is registered LAST, after
 * /healthz, /mcp/bbs, /login, /callback, /logout and /api/*, so it can never
 * shadow them and a 404 from /api/* stays JSON.
 *
 * `webDir === null` (dev) disables all of it: the Vite dev server is the origin
 * and proxies the dynamic paths here. Head injection is therefore NOT exercised
 * in dev, which is why it has its own test against a fixture index.html.
 */
import type { ViewerEnv } from "@herkules/oauth-client/hono";
import type { Hono } from "hono";

import type { Library } from "../library/index.ts";
import type { HeadTemplate } from "./head.ts";

export interface StaticDeps {
  /** Absolute path to the built SPA, or null to disable (dev). */
  readonly webDir: string | null;
  readonly library: Library;
  /** For canonical URLs and `og:url` — the APP origin, never the platform origin. */
  readonly appOrigin: string;
}

export interface SpaHandler {
  /** Registers the asset routes and the fallback on the app, in that order. Call LAST. */
  mount(app: Hono<ViewerEnv>): void;
  /** Null when `webDir` is null. Exposed so a test can render a head without HTTP. */
  readonly template: HeadTemplate | null;
}

/** Reads and parses `${webDir}/index.html` once. Throws at boot on a missing file or marker. */
export async function createSpaHandler(deps: StaticDeps): Promise<SpaHandler> {
  void deps;
  // TODO if (!deps.webDir) return { mount: () => {}, template: null }
  //      template = loadHeadTemplate(await readFile(join(webDir, "index.html"), "utf8"))
  //      mount(app):
  //        app.use("/assets/*", serveStatic({ root: webDir }) + immutable cache header)   // @hono/node-server/serve-static
  //        app.get("*", async (c) => {
  //          route = headRouteOf(new URL(c.req.url).pathname)
  //          if (!route) return html(template.plain, 200)
  //          meta = route.kind === "article"
  //            ? (aid = articleId(route.id)) && await deps.library.head(aid)
  //            : await deps.library.entityHead(entityKey(route.id))
  //          return meta ? html(template.render(meta, deps.appOrigin), 200) : html(template.plain, 404)
  //        })
  //      html() sets `content-type: text/html; charset=utf-8` and `cache-control: no-cache`.
  throw new Error("not implemented");
}
