/**
 * Server-side `<title>` / `og:*` injection for `/articles/:id` and `/kb/:name`.
 * Pure string work; the read that feeds it lives in static.ts.
 *
 * WHY A BOOT-TIME PARSE OF THE BUILT FILE, not a build-time template: Vite emits
 * hashed asset names, so the only document that references the right bundle is
 * the one Vite just produced. The server reads `${webDir}/index.html` once at
 * boot, splits it at the markers, and renders by concatenating three strings —
 * no per-request parse, no knowledge of asset names.
 *
 * THE CONTRACT with web/index.html (round 2), byte-for-byte and checked at boot:
 *
 *     <!--bbs:head-->
 *       <title>RM 文库</title> <meta name="description" …> …default og tags…
 *     <!--/bbs:head-->
 *
 * Everything between the markers is REPLACED, which is why the defaults live
 * inside them: the static file is a valid page on its own (what the Vite dev
 * server serves) and the server never merges tags. `loadHeadTemplate` THROWS on
 * a missing or misordered marker — a bad build is a container that will not
 * start, instead of a month of link previews saying "RM 文库".
 *
 * Escaping is the security boundary: an article title is forum content landing
 * inside an attribute value. `escapeAttribute` is the only way text enters the head.
 */
import type { HeadMeta } from "../library/types.ts";

export const HEAD_OPEN = "<!--bbs:head-->";
export const HEAD_CLOSE = "<!--/bbs:head-->";

export interface HeadTemplate {
  /** `prefix + tags(meta) + suffix`. Cheap enough to run per request. */
  render(meta: HeadMeta, appOrigin: string): string;
  /** The file as built, markers included — served for every route with no metadata of its own. */
  readonly plain: string;
}

/** Throws a boot error naming the missing marker; never returns a template that silently does nothing. */
export function loadHeadTemplate(indexHtml: string): HeadTemplate {
  void indexHtml;
  // TODO a = indexHtml.indexOf(HEAD_OPEN), b = indexHtml.indexOf(HEAD_CLOSE)
  //      if (a < 0 || b < 0 || b < a) throw new Error(`index.html is missing ${HEAD_OPEN} … ${HEAD_CLOSE}`)
  //      prefix = indexHtml.slice(0, a + HEAD_OPEN.length); suffix = indexHtml.slice(b)
  throw new Error("not implemented");
}

/**
 * `<title>{title} · RM 文库</title>`, `<meta name=description>`, `<link rel=canonical>`,
 * and the og/twitter pairs rm-wenku emitted: og:type, og:title, og:description, og:url,
 * og:image, og:site_name, article:published_time, article:author, twitter:card.
 * Description whitespace-collapsed and cut at 200 chars; `og:url` = appOrigin + meta.path.
 */
export function renderHeadTags(meta: HeadMeta, appOrigin: string): string {
  void meta;
  void appOrigin;
  throw new Error("not implemented");
}

/** Which URLs get real metadata. Two, exactly as rm-wenku had. Everything else: `plain`. */
export function headRouteOf(pathname: string): { kind: "article" | "entity"; id: string } | null {
  void pathname;
  // TODO /^\/articles\/([^/]+)$/ -> article; /^\/kb\/([^/]+)$/ -> entity (decodeURIComponent); else null
  throw new Error("not implemented");
}

export function escapeAttribute(text: string): string {
  void text;
  // TODO & < > " ' -> entities
  throw new Error("not implemented");
}
