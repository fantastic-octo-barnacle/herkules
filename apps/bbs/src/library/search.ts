/**
 * Ranked search. The one place `SearchIndex` is composed into a statement and
 * the one place snippets are attached.
 *
 * Two queries, always: (1) `search.stats(cols, terms)`; (2) the page:
 *
 *   SELECT <SUMMARY_COLUMNS>,
 *          <search.score(cols, terms, stats)>  AS score,
 *          <raw snippet fields>                                -- ≤ limit+1 rows
 *   FROM article_search                                    -- kb_search for scope=kb
 *   JOIN articles ON articles.id = article_search.article_id
 *   LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready'
 *   WHERE <search.match(cols, terms)>
 *     AND articles.status = 'fetched'                      -- the JOIN already implies it (905 of 969 have a row);
 *     [AND tag / group EXISTS clauses]                     --   the predicate stays so a `skipped` row can never leak
 *     [AND <rankAfter>]                                    -- (<score expr>, id) < (:cursorScore, :cursorId)
 *   ORDER BY score DESC, articles.id DESC
 *   LIMIT :limit + 1
 *
 * `scope=title` runs the same statement over TITLE_COLUMNS (the folded title
 * sliced out of `document`; ranking over that one field). `scope=kb` snippets
 * from the kb fields in KB_SEARCH_FIELDS order. Snippets: db/search/snippet.ts
 * over the raw fields, in TypeScript, engine-independent.
 *
 * A blank `q` (no terms after parsing) throws QueryError("empty_query") -> 400,
 * as rm-wenku's `/search` did.
 */
import type { SQL } from "drizzle-orm";
import { and, sql } from "drizzle-orm";

import { rowsOf } from "../db/index.ts";
import { articleSearch, articles, kbSearch } from "../db/schema.ts";
import type { SearchColumns } from "../db/search/index.ts";
import { ARTICLE_SEARCH_FIELDS, KB_SEARCH_FIELDS, parseTerms } from "../db/search/index.ts";
import { snippet } from "../db/search/snippet.ts";
import {
  AI_JOIN,
  FETCHED,
  SUMMARY_COLUMNS,
  groupFilter,
  num,
  str,
  summaryOf,
  tagFilter,
} from "./articles.ts";
import { decodeCursor, encodeCursor, rankAfter } from "./cursor.ts";
import type { LibraryDeps } from "./index.ts";
import type { ArticleId, SearchPage, SearchQuery, SearchScope } from "./types.ts";
import { QueryError } from "./types.ts";

const ARTICLE_COLUMN = {
  title: articleSearch.title,
  author: articleSearch.author,
  tags: articleSearch.tags,
  introduction: articleSearch.introduction,
  body_text: articleSearch.bodyText,
} as const;

const KB_COLUMN = {
  tldr: kbSearch.tldr,
  problem: kbSearch.problem,
  approach: kbSearch.approach,
  components: kbSearch.components,
  parameters: kbSearch.parameters,
  decisions: kbSearch.decisions,
  pitfalls: kbSearch.pitfalls,
  entities: kbSearch.entities,
  keywords: kbSearch.keywords,
  captions: kbSearch.captions,
} as const;

export async function search(deps: LibraryDeps, query: SearchQuery): Promise<SearchPage> {
  const terms = parseTerms(query.q);
  if (terms.length === 0) throw new QueryError("empty_query", "search needs at least one term");
  const scope = query.scope ?? "all";
  const cols = columns(scope);
  const stats = await deps.search.stats(cols, terms);
  const score = deps.search.score(cols, terms, stats);

  const conds: SQL[] = [deps.search.match(cols, terms), FETCHED];
  if (query.tag) conds.push(tagFilter(query.tag));
  if (query.group) conds.push(groupFilter(query.group));
  if (query.cursor) {
    const key = decodeCursor(query.cursor, "rank");
    if (!key || key.kind !== "rank") throw new QueryError("invalid_cursor", "unusable cursor");
    conds.push(rankAfter(key, score));
  }
  const table = scope === "kb" ? kbSearch : articleSearch;
  const snippetFields =
    scope === "kb" ? KB_SEARCH_FIELDS : (["body_text", "introduction", "title"] as const);
  const snippetColumns = snippetFields.map(
    (f, i) =>
      sql`${scope === "kb" ? KB_COLUMN[f as keyof typeof KB_COLUMN] : ARTICLE_COLUMN[f as keyof typeof ARTICLE_COLUMN]} AS ${sql.raw(`snip_${i}`)}`,
  );
  const limit = Math.max(1, query.limit);
  const rows = rowsOf(
    await deps.db.execute(sql`
      SELECT ${SUMMARY_COLUMNS}, (${score}) AS score, ${sql.join(snippetColumns, sql`, `)}
      FROM ${table}
      JOIN ${articles} ON ${articles.id} = ${table.articleId}
      ${AI_JOIN}
      WHERE ${and(...conds)}
      ORDER BY score DESC, ${articles.id} DESC
      LIMIT ${sql.raw(String(limit + 1))}`),
  );
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  return {
    items: page.map((r) => ({
      ...summaryOf(r),
      score: num(r.score),
      snippet:
        snippet(
          snippetFields.map((_, i) => str(r[`snip_${i}`]) ?? ""),
          terms,
        ) ?? null,
    })),
    nextCursor: last
      ? encodeCursor({ kind: "rank", score: num(last.score), id: String(last.id) as ArticleId })
      : null,
    terms: terms.map((t) => t.raw),
  };
}

/**
 * The `SearchColumns` view for each scope, over the (unaliased) search table:
 *   all   -> { from: article_search, document: article_search.document, fields: ARTICLE_SEARCH_FIELDS as raw columns }
 *   kb    -> { from: kb_search,      document: kb_search.document,      fields: KB_SEARCH_FIELDS }
 *   title -> { from: article_search, document: substr(document, 1, length(title)), fields: [title] }
 * The title view is how `scope=title` gets width/case folding with no SQL fold and no extra index.
 */
export function columns(scope: SearchScope): SearchColumns {
  switch (scope) {
    case "kb":
      return {
        from: kbSearch,
        document: kbSearch.document,
        fields: KB_SEARCH_FIELDS.map((name) => ({ name, column: KB_COLUMN[name] })),
      };
    case "title":
      return {
        from: articleSearch,
        document: sql`substr(${articleSearch.document}, 1, length(${articleSearch.title}))`,
        fields: [{ name: "title", column: articleSearch.title }],
      };
    default:
      return {
        from: articleSearch,
        document: articleSearch.document,
        fields: ARTICLE_SEARCH_FIELDS.map((name) => ({ name, column: ARTICLE_COLUMN[name] })),
      };
  }
}

/** The EXISTS predicate `articles.ts` uses for `q` on the feed, so list and search share one recall definition. */
export function feedMatch(deps: LibraryDeps, scope: SearchScope, q: string): SQL {
  const terms = parseTerms(q);
  if (terms.length === 0) return sql`true`;
  const cols = columns(scope);
  const table = scope === "kb" ? kbSearch : articleSearch;
  return sql`EXISTS (SELECT 1 FROM ${cols.from} WHERE ${table.articleId} = ${articles.id} AND ${deps.search.match(cols, terms)})`;
}
