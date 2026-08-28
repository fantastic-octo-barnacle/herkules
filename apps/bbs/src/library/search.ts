/**
 * Ranked search. The one place `SearchIndex` is composed into a statement and
 * the one place snippets are attached.
 *
 * Two queries, always: (1) `search.stats(cols, terms)`; (2) the page:
 *
 *   SELECT <ArticleSummary projection from articles.ts>,
 *          <search.score(cols, terms, stats)>  AS score,
 *          s.title, s.introduction, s.body_text            -- raw snippet material, ≤ limit+1 rows
 *   FROM article_search s                                  -- kb_search for scope=kb
 *   JOIN articles a ON a.id = s.article_id
 *   LEFT JOIN article_ai ai ON ai.article_id = a.id AND ai.status = 'ready'
 *   LEFT JOIN LATERAL (…tags…) t ON true
 *   WHERE <search.match(cols, terms)>
 *     AND a.status = 'fetched'                             -- the JOIN already implies it (905 of 969 have a row);
 *     [AND tag / group EXISTS clauses]                     --   the predicate stays so a `skipped` row can never leak
 *     [AND (<score expr>, a.id) < (:cursorScore, :cursorId)]   -- rankAfter
 *   ORDER BY score DESC, a.id DESC
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

import type { SearchColumns } from "../db/search/index.ts";
import type { LibraryDeps } from "./index.ts";
import type { SearchPage, SearchQuery, SearchScope } from "./types.ts";

export function search(deps: LibraryDeps, query: SearchQuery): Promise<SearchPage> {
  void deps;
  void query;
  // TODO terms = parseTerms(query.q); if (!terms.length) throw new QueryError("empty_query", …)
  //      cols = columns(query.scope ?? "all"); stats = await deps.search.stats(cols, terms)
  //      … the statement above …
  //      rows.map((r) => ({ ...summary(r), score: r.score,
  //                         snippet: snippet(snippetFields(query.scope, r), terms) ?? null }))
  //      terms echoed as terms.map((t) => t.raw)
  throw new Error("not implemented");
}

/**
 * The `SearchColumns` view for each scope, over the table alias `s`:
 *   all   -> { document: s.document, fields: ARTICLE_SEARCH_FIELDS as raw columns }
 *   kb    -> { document: s.document, fields: KB_SEARCH_FIELDS }
 *   title -> { document: substr(s.document, 1, length(s.title)), fields: [title] }
 * The title view is how `scope=title` gets width/case folding with no SQL fold and no extra index.
 */
export function columns(scope: SearchScope): SearchColumns {
  void scope;
  throw new Error("not implemented");
}

/** The EXISTS predicate `articles.ts` uses for `q` on the feed, so list and search share one recall definition. */
export function feedMatch(deps: LibraryDeps, scope: SearchScope, q: string): SQL {
  void deps;
  void scope;
  void q;
  throw new Error("not implemented");
}
