/**
 * The feed, the reader page, the raw-content endpoint, the merged AI read and
 * the head-injection read. One SQL statement each; the comments are the statements.
 *
 * PUBLIC is the invariant that keeps this file honest: every query pins
 * `articles.status = 'fetched'`. rm-wenku expressed the rule by having the HTTP
 * handler mutate a shared params struct (ground-A #15); there is no admin route
 * here and no way to ask for another status, so the rule is structural.
 */
import type { LibraryDeps } from "./index.ts";
import type {
  Article,
  ArticleAi,
  ArticleContent,
  ArticleId,
  ArticleListQuery,
  ArticleSummary,
  ContentFormat,
  HeadMeta,
  Page,
} from "./types.ts";

/** Characters of `body_text` pulled for the excerpt (rm-wenku's figure); 200 after whitespace collapse never needs more. */
export const EXCERPT_SOURCE_CHARS = 800;
export const EXCERPT_CHARS = 200;

/**
 * ONE query. `$k` is the keyset predicate from cursor.ts:
 *
 *   SELECT a.id, a.source_article_id, a.canonical_url, a.title, a.title_season, a.title_team,
 *          a.title_topic, a.title_labels, a.author, a.published_at, a.discovered_at, a.fetched_at,
 *          a.is_pinned, a.introduction, coalesce(length(a.body_text), 0) AS body_chars,
 *          substr(a.body_text, 1, 800) AS body_head, t.tags, l.link_count, i.image_count,
 *          ai.overview_json ->> 'tldr' AS tldr
 *   FROM articles a
 *   LEFT JOIN LATERAL (SELECT array_agg(tag ORDER BY position) AS tags FROM article_tags WHERE article_id = a.id) t ON true
 *   LEFT JOIN LATERAL (SELECT count(*) AS link_count  FROM article_links  WHERE article_id = a.id) l ON true
 *   LEFT JOIN LATERAL (SELECT count(*) AS image_count FROM article_images WHERE article_id = a.id) i ON true
 *   LEFT JOIN article_ai ai ON ai.article_id = a.id AND ai.status = 'ready'
 *   WHERE a.status = 'fetched'
 *     [AND EXISTS (SELECT 1 FROM article_tags x WHERE x.article_id = a.id AND x.tag = :tag)]
 *     [AND EXISTS (SELECT 1 FROM article_tags x WHERE x.article_id = a.id AND x.group_name = :group)]
 *     [AND <q predicate>] [AND $k]
 *   ORDER BY coalesce(a.published_at, a.discovered_at) DESC, a.listing_position ASC, a.id DESC
 *   LIMIT :limit + 1;                                   -- the extra row decides nextCursor
 *
 * The `q` predicate reuses the search seam so the list and `/api/search` cannot disagree
 * about what a query means (columns() in search.ts):
 *   scope=all   -> EXISTS (SELECT 1 FROM article_search s WHERE s.article_id = a.id AND <search.match(ARTICLE_COLUMNS, terms)>)
 *   scope=kb    -> EXISTS (SELECT 1 FROM kb_search      s WHERE s.article_id = a.id AND <search.match(KB_COLUMNS, terms)>)
 *   scope=title -> EXISTS (SELECT 1 FROM article_search s WHERE s.article_id = a.id AND <search.match(TITLE_COLUMNS, terms)>)
 *                  where TITLE_COLUMNS.document = substr(s.document, 1, length(s.title)) — the folded title, no SQL fold.
 * Tag ORDER is `position` (SQLite rowid) — the source's own order, not alphabetical; the eyebrow chips depend on it.
 */
export function listArticles(
  deps: LibraryDeps,
  query: ArticleListQuery,
): Promise<Page<ArticleSummary>> {
  void deps;
  void query;
  throw new Error("not implemented");
}

/**
 * ONE query: the summary projection plus
 *   a.content_format, a.content_html, a.body_text,
 *   links:  (SELECT jsonb_agg(jsonb_build_object('url', l.url, 'kind', l.kind,
 *              'label', coalesce(nullif(l.label, ''), tgt.title),
 *              'articleId', CASE WHEN tgt.status = 'fetched' THEN tgt.id END,
 *              'position', l.position) ORDER BY l.position)
 *            FROM article_links l LEFT JOIN articles tgt ON tgt.id = l.target_article_id WHERE l.article_id = a.id)
 *   images: (SELECT jsonb_agg(jsonb_build_object('url', im.url, 'alt', coalesce(nullif(im.alt, ''), im.caption),
 *              'position', im.position) ORDER BY im.position) FROM article_images im WHERE im.article_id = a.id)
 * Rendering and link resolution happened at import; the label fallback and alt/caption collapse
 * stay dynamic because they are joins on the target's current row.
 * NOT ported: the `request_refresh_if_stale` UPDATE this GET used to perform (ground-A #9).
 */
export function getArticle(deps: LibraryDeps, id: ArticleId): Promise<Article | null> {
  void deps;
  void id;
  throw new Error("not implemented");
}

/**
 * ONE query: `SELECT content_format, content_raw, content_html, body_text FROM articles WHERE id = :id AND status = 'fetched'`, then:
 *   markdown && content_format = 'markdown' -> content_raw (format "markdown"); markdown otherwise -> body_text ("text")
 *   html -> content_html ?? body_text; text -> body_text
 */
export function getContent(
  deps: LibraryDeps,
  id: ArticleId,
  format: ContentFormat,
): Promise<ArticleContent | null> {
  void deps;
  void id;
  void format;
  throw new Error("not implemented");
}

/**
 * ONE query: `SELECT a.id, ai.status, ai.model, ai.generated_at, ai.error, ai.overview_json, ai.kb_json, ai.images_json
 * FROM articles a LEFT JOIN article_ai ai ON ai.article_id = a.id WHERE a.id = :id AND a.status = 'fetched'`.
 * No article -> null. No AI row -> { status: "pending", overview: null, kb: null, images: [] } (800 of 905 fetched
 * articles; "pending" is the shape the reader panel understands — the SPA's 8-second poll goes away in round 2).
 * JSON parsed by ai-json.ts.
 */
export function getArticleAi(deps: LibraryDeps, id: ArticleId): Promise<ArticleAi | null> {
  void deps;
  void id;
  throw new Error("not implemented");
}

/**
 * ONE query, three columns: `SELECT title, title_topic, introduction, substr(body_text, 1, 300), author, published_at,
 * (first image url) FROM articles … WHERE id = :id AND status = 'fetched'`. Two columns' worth of work for a crawler;
 * never the full article (candidate B pulled content_html to render a <title>).
 */
export function getHead(deps: LibraryDeps, id: ArticleId): Promise<HeadMeta | null> {
  void deps;
  void id;
  throw new Error("not implemented");
}

/** `introduction`, else the whitespace-collapsed head of the body cut to EXCERPT_CHARS. Pure. Presentation trims (简介：) belong to round 2. */
export function excerptOf(introduction: string | null, bodyHead: string | null): string | null {
  void introduction;
  void bodyHead;
  throw new Error("not implemented");
}
