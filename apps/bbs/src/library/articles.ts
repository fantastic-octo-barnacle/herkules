/**
 * The feed, the reader page, the raw-content endpoint, the merged AI read and
 * the head-injection read. One SQL statement each; the comments are the statements.
 *
 * PUBLIC is the invariant that keeps this file honest: every query pins
 * `articles.status = 'fetched'`. rm-wenku expressed the rule by having the HTTP
 * handler mutate a shared params struct (ground-A #15); there is no admin route
 * here and no way to ask for another status, so the rule is structural.
 *
 * Statements are written with `sql` templates over the schema's column objects
 * (names stay in sync with schema.ts) and read through `rowsOf` (one shape on
 * both hosts). `articles` is never aliased — cursor.ts's predicates name it.
 */
import type { SQL } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";

import { rowsOf } from "../db/index.ts";
import { articleAi, articleImages, articleLinks, articleTags, articles } from "../db/schema.ts";
import { truncateChars } from "../content/text.ts";
import { parseImageCaptions, parseKbEntry, parseOverview } from "./ai-json.ts";
import { FEED_AT, decodeCursor, encodeCursor, feedAfter } from "./cursor.ts";
import type { LibraryDeps } from "./index.ts";
import { feedMatch } from "./search.ts";
import type {
  Article,
  ArticleAi,
  ArticleContent,
  ArticleId,
  ArticleImage,
  ArticleLink,
  ArticleListQuery,
  ArticleSummary,
  ContentFormat,
  HeadMeta,
  Page,
} from "./types.ts";
import { QueryError } from "./types.ts";

/** Characters of `body_text` pulled for the excerpt (rm-wenku's figure); 200 after whitespace collapse never needs more. */
export const EXCERPT_SOURCE_CHARS = 800;
export const EXCERPT_CHARS = 200;

// ── shared projection ───────────────────────────────────────────────────────

export const FETCHED: SQL = sql`${articles.status} = 'fetched'`;

/** `LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready'`. */
export const AI_JOIN: SQL = sql`LEFT JOIN ${articleAi} ON ${articleAi.articleId} = ${articles.id} AND ${articleAi.status} = 'ready'`;

/** The `ArticleSummary` columns, aliased to snake_case keys `summaryOf` reads. */
export const SUMMARY_COLUMNS: SQL = sql`
  ${articles.id} AS id, ${articles.sourceArticleId} AS source_article_id, ${articles.canonicalUrl} AS url,
  ${articles.title} AS title, ${articles.titleSeason} AS title_season, ${articles.titleTeam} AS title_team,
  ${articles.titleTopic} AS title_topic, to_jsonb(${articles.titleLabels}) AS title_labels,
  ${articles.author} AS author, ${articles.publishedAt} AS published_at, ${articles.discoveredAt} AS discovered_at,
  ${articles.fetchedAt} AS fetched_at, ${articles.isPinned} AS is_pinned, ${articles.introduction} AS introduction,
  coalesce(length(${articles.bodyText}), 0)::int AS body_chars,
  substr(${articles.bodyText}, 1, ${sql.raw(String(EXCERPT_SOURCE_CHARS))}) AS body_head,
  (SELECT coalesce(jsonb_agg(${articleTags.tag} ORDER BY ${articleTags.position}), '[]'::jsonb)
     FROM ${articleTags} WHERE ${articleTags.articleId} = ${articles.id}) AS tags,
  (SELECT count(*)::int FROM ${articleLinks} WHERE ${articleLinks.articleId} = ${articles.id}) AS link_count,
  (SELECT count(*)::int FROM ${articleImages} WHERE ${articleImages.articleId} = ${articles.id}) AS image_count,
  ${articleAi.overviewJson} ->> 'tldr' AS tldr`;

export function tagFilter(tag: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${articleTags} WHERE ${articleTags.articleId} = ${articles.id} AND ${articleTags.tag} = ${tag})`;
}

export function groupFilter(group: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${articleTags} WHERE ${articleTags.articleId} = ${articles.id} AND ${articleTags.groupName} = ${group})`;
}

type Row = Record<string, unknown>;

export function summaryOf(r: Row): ArticleSummary {
  const introduction = str(r.introduction);
  return {
    id: String(r.id) as ArticleId,
    sourceArticleId: String(r.source_article_id),
    url: String(r.url),
    title: String(r.title),
    titleParts: {
      season: str(r.title_season),
      team: str(r.title_team),
      labels: strings(r.title_labels),
      topic: str(r.title_topic) ?? String(r.title),
    },
    author: str(r.author),
    publishedAt: date(r.published_at),
    discoveredAt: date(r.discovered_at) ?? new Date(0),
    fetchedAt: date(r.fetched_at),
    isPinned: r.is_pinned === true,
    tags: strings(r.tags),
    introduction,
    excerpt: excerptOf(introduction, str(r.body_head)),
    bodyChars: num(r.body_chars),
    linkCount: num(r.link_count),
    imageCount: num(r.image_count),
    tldr: str(r.tldr),
  };
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function date(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** A jsonb array (already parsed by both drivers; a string is parsed defensively) with non-strings dropped. */
export function strings(v: unknown): readonly string[] {
  const parsed = typeof v === "string" ? tryJson(v) : v;
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

export function json(v: unknown): unknown {
  return typeof v === "string" ? tryJson(v) : v;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── the feed ────────────────────────────────────────────────────────────────

/**
 * ONE query. `$k` is the keyset predicate from cursor.ts:
 *
 *   SELECT <SUMMARY_COLUMNS>, coalesce(published_at, discovered_at) AS feed_at, listing_position
 *   FROM articles
 *   LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready'
 *   WHERE articles.status = 'fetched'
 *     [AND EXISTS (SELECT 1 FROM article_tags WHERE article_id = articles.id AND tag = :tag)]
 *     [AND EXISTS (SELECT 1 FROM article_tags WHERE article_id = articles.id AND group_name = :group)]
 *     [AND <q predicate>] [AND $k]
 *   ORDER BY coalesce(published_at, discovered_at) DESC, listing_position ASC, id DESC
 *   LIMIT :limit + 1;                                   -- the extra row decides nextCursor
 *
 * The `q` predicate reuses the search seam so the list and `/api/search` cannot disagree
 * about what a query means (feedMatch in search.ts): an EXISTS over article_search
 * (scope all/title) or kb_search (scope kb). Tag ORDER is `position` (SQLite rowid) — the
 * source's own order, not alphabetical; the eyebrow chips depend on it.
 */
export async function listArticles(
  deps: LibraryDeps,
  query: ArticleListQuery,
): Promise<Page<ArticleSummary>> {
  const conds: SQL[] = [FETCHED];
  if (query.tag) conds.push(tagFilter(query.tag));
  if (query.group) conds.push(groupFilter(query.group));
  if (query.q?.trim()) conds.push(feedMatch(deps, query.scope ?? "all", query.q));
  if (query.cursor) {
    const key = decodeCursor(query.cursor, "feed");
    if (!key || key.kind !== "feed") throw new QueryError("invalid_cursor", "unusable cursor");
    conds.push(feedAfter(key));
  }
  const limit = Math.max(1, query.limit);
  const rows = rowsOf(
    await deps.db.execute(sql`
      SELECT ${SUMMARY_COLUMNS}, ${FEED_AT} AS feed_at, ${articles.listingPosition} AS listing_position
      FROM ${articles} ${AI_JOIN}
      WHERE ${and(...conds)}
      ORDER BY ${FEED_AT} DESC, ${articles.listingPosition} ASC, ${articles.id} DESC
      LIMIT ${sql.raw(String(limit + 1))}`),
  );
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  return {
    items: page.map(summaryOf),
    nextCursor: last
      ? encodeCursor({
          kind: "feed",
          at: date(last.feed_at) ?? new Date(0),
          position: num(last.listing_position),
          id: String(last.id) as ArticleId,
        })
      : null,
  };
}

/**
 * ONE query: the summary projection plus
 *   content_format, content_html, body_text,
 *   links:  (SELECT jsonb_agg(jsonb_build_object('url', l.url, 'kind', l.kind,
 *              'label', coalesce(nullif(l.label, ''), tgt.title),
 *              'articleId', CASE WHEN tgt.status = 'fetched' THEN tgt.id END,
 *              'position', l.position) ORDER BY l.position)
 *            FROM article_links l LEFT JOIN articles tgt ON tgt.id = l.target_article_id WHERE l.article_id = articles.id)
 *   images: (SELECT jsonb_agg(jsonb_build_object('url', im.url, 'alt', coalesce(nullif(im.alt, ''), im.caption),
 *              'position', im.position) ORDER BY im.position) FROM article_images im WHERE im.article_id = articles.id)
 * Rendering and link resolution happened at import; the label fallback and alt/caption collapse
 * stay dynamic because they are joins on the target's current row.
 * NOT ported: the `request_refresh_if_stale` UPDATE this GET used to perform (ground-A #9).
 */
export async function getArticle(deps: LibraryDeps, id: ArticleId): Promise<Article | null> {
  const row = rowsOf(
    await deps.db.execute(sql`
      SELECT ${SUMMARY_COLUMNS},
        ${articles.contentFormat} AS content_format, ${articles.contentHtml} AS content_html,
        ${articles.bodyText} AS body_text,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'url', l.url, 'kind', l.kind,
            'label', coalesce(nullif(l.label, ''), tgt.title),
            'articleId', CASE WHEN tgt.status = 'fetched' THEN tgt.id END,
            'position', l.position) ORDER BY l.position), '[]'::jsonb)
         FROM article_links l LEFT JOIN articles tgt ON tgt.id = l.target_article_id
         WHERE l.article_id = ${articles.id}) AS links,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'url', im.url, 'alt', coalesce(nullif(im.alt, ''), im.caption), 'position', im.position)
            ORDER BY im.position), '[]'::jsonb)
         FROM article_images im WHERE im.article_id = ${articles.id}) AS images
      FROM ${articles} ${AI_JOIN}
      WHERE ${articles.id} = ${id} AND ${FETCHED}`),
  )[0];
  if (!row) return null;
  const format = str(row.content_format);
  const links = json(row.links);
  const images = json(row.images);
  return {
    ...summaryOf(row),
    contentFormat: format === "html" || format === "markdown" ? format : null,
    contentHtml: str(row.content_html),
    bodyText: str(row.body_text),
    links: Array.isArray(links) ? links.map(linkOf) : [],
    images: Array.isArray(images) ? images.map(imageOf) : [],
  };
}

const LINK_KINDS = new Set(["repository", "document", "download", "video", "cloud_drive", "other"]);

function linkOf(v: unknown): ArticleLink {
  const r = (v ?? {}) as Row;
  const kind = str(r.kind) ?? "other";
  return {
    url: str(r.url) ?? "",
    kind: (LINK_KINDS.has(kind) ? kind : "other") as ArticleLink["kind"],
    label: str(r.label),
    articleId: (str(r.articleId) as ArticleId | null) ?? null,
    position: num(r.position),
  };
}

function imageOf(v: unknown): ArticleImage {
  const r = (v ?? {}) as Row;
  return { url: str(r.url) ?? "", alt: str(r.alt), position: num(r.position) };
}

/**
 * ONE query: `SELECT content_format, content_raw, content_html, body_text FROM articles WHERE id = :id AND status = 'fetched'`, then:
 *   markdown && content_format = 'markdown' -> content_raw (format "markdown"); markdown otherwise -> body_text ("text")
 *   html -> content_html ?? body_text; text -> body_text
 */
export async function getContent(
  deps: LibraryDeps,
  id: ArticleId,
  format: ContentFormat,
): Promise<ArticleContent | null> {
  const row = (
    await deps.db
      .select({
        contentFormat: articles.contentFormat,
        contentRaw: articles.contentRaw,
        contentHtml: articles.contentHtml,
        bodyText: articles.bodyText,
      })
      .from(articles)
      .where(and(eq(articles.id, id), FETCHED))
      .limit(1)
  )[0];
  if (!row) return null;
  const text = row.bodyText ?? "";
  if (format === "markdown" && row.contentFormat === "markdown" && row.contentRaw !== null) {
    return { format: "markdown", body: row.contentRaw };
  }
  if (format === "html" && row.contentHtml !== null)
    return { format: "html", body: row.contentHtml };
  return { format: "text", body: text };
}

/**
 * ONE query: `SELECT articles.id, ai.status, ai.model, ai.generated_at, ai.error, ai.overview_json, ai.kb_json, ai.images_json
 * FROM articles LEFT JOIN article_ai ai ON ai.article_id = articles.id WHERE articles.id = :id AND articles.status = 'fetched'`.
 * No article -> null. No AI row -> { status: "pending", overview: null, kb: null, images: [] } (800 of 905 fetched
 * articles; "pending" is the shape the reader panel understands — the SPA's 8-second poll goes away in round 2).
 * JSON parsed by ai-json.ts.
 */
export async function getArticleAi(deps: LibraryDeps, id: ArticleId): Promise<ArticleAi | null> {
  const row = (
    await deps.db
      .select({
        id: articles.id,
        status: articleAi.status,
        model: articleAi.model,
        generatedAt: articleAi.generatedAt,
        error: articleAi.error,
        overview: articleAi.overviewJson,
        kb: articleAi.kbJson,
        images: articleAi.imagesJson,
      })
      .from(articles)
      .leftJoin(articleAi, eq(articleAi.articleId, articles.id))
      .where(and(eq(articles.id, id), FETCHED))
      .limit(1)
  )[0];
  if (!row) return null;
  const status = row.status === "ready" || row.status === "failed" ? row.status : "pending";
  return {
    articleId: id,
    status,
    overview: status === "ready" ? parseOverview(row.overview) : null,
    kb: status === "ready" ? parseKbEntry(row.kb) : null,
    images: status === "ready" ? parseImageCaptions(row.images) : [],
    model: row.model ?? null,
    generatedAt: row.generatedAt ?? null,
    error: row.error ?? null,
  };
}

/**
 * ONE query, a handful of scalar columns: `SELECT title, introduction, substr(body_text, 1, 300), author,
 * published_at, (first image url) FROM articles WHERE id = :id AND status = 'fetched'`. Two columns' worth of
 * work for a crawler; never the full article (candidate B pulled content_html to render a <title>).
 */
export async function getHead(deps: LibraryDeps, id: ArticleId): Promise<HeadMeta | null> {
  // Raw on purpose: inside `db.select()` drizzle renders columns in `sql` fields unqualified,
  // so a correlated `article_images.article_id = articles.id` would compare two local columns.
  const row = rowsOf(
    await deps.db.execute(sql`
      SELECT ${articles.title} AS title, ${articles.introduction} AS introduction,
        substr(${articles.bodyText}, 1, 300) AS body_head, ${articles.author} AS author,
        ${articles.publishedAt} AS published_at,
        (SELECT ${articleImages.url} FROM ${articleImages} WHERE ${articleImages.articleId} = ${articles.id}
           ORDER BY ${articleImages.position} LIMIT 1) AS image
      FROM ${articles} WHERE ${articles.id} = ${id} AND ${FETCHED}`),
  )[0];
  if (!row) return null;
  const title = String(row.title);
  return {
    title,
    description: excerptOf(str(row.introduction), str(row.body_head)) ?? title,
    path: `/articles/${id}`,
    type: "article",
    image: str(row.image),
    publishedAt: date(row.published_at),
    author: str(row.author),
  };
}

/** `introduction`, else the whitespace-collapsed head of the body cut to EXCERPT_CHARS. Pure. Presentation trims (简介：) belong to round 2. */
export function excerptOf(introduction: string | null, bodyHead: string | null): string | null {
  const intro = introduction?.trim();
  if (intro) return intro;
  const body = bodyHead?.replace(/\s+/g, " ").trim();
  if (!body) return null;
  // Code-point truncation: a UTF-16 slice can split an emoji into a lone
  // surrogate, which reaches the reader and the bot cards as U+FFFD.
  return truncateChars(body, EXCERPT_CHARS);
}
