/**
 * THE PGROONGA SEAM.
 *
 * FRAME: the planned check-5 fallback is "PGroonga on the two search tables (a
 * migration and an image change, not a rewrite)". This interface is what makes
 * that true: everything that knows how full-text matching and ranking are done
 * in SQL is behind `match` / `score` / `stats`; src/library never writes a
 * `LIKE`, a `similarity()` or a `&@~`. Snippets are NOT here — they are pure
 * TypeScript over the raw fields (snippet.ts) and identical under both engines.
 *
 * Swapping to PGroonga is exactly three things: a migration adding
 * `USING pgroonga (document) WITH (normalizers='NormalizerNFKC150')` next to the
 * GIN index, the custom Postgres image in compose, and `SEARCH_INDEX=pgroonga`.
 * Both indexes can coexist on the same column during the cutover.
 *
 * The interface is expression-shaped rather than "run the search for me" on
 * purpose: ranking and the tag/group/status filters have to end up in ONE SQL
 * statement (that is how the N+1s stay dead), so the index contributes
 * fragments and src/library/search.ts owns the statement.
 */
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { Term } from "./terms.ts";

export type { Term } from "./terms.ts";
export { MAX_TERMS, parseTerms } from "./terms.ts";

/** One weighted field of a search table, in `document` order. */
export interface SearchField {
  readonly name: string;
  /** The RAW column (snippets are cut from it; lengths are read from it). */
  readonly column: SQLWrapper;
}

/**
 * The columns of one search table the index may look at. `fields` are in
 * `document` order; their newline-joined concatenation is index-aligned with
 * `document` (the table's CHECK). That alignment is what lets an implementation
 * address the FOLDED field i as
 *   substr(document, 1 + Σ_{j<i}(length(field_j) + 1), length(field_i))
 * without any SQL-side fold (`fieldSlice` in trgm.ts). A caller may pass a
 * narrower view — `scope=title` is `{ document: <title slice>, fields: [title] }`.
 */
export interface SearchColumns {
  readonly document: SQLWrapper;
  readonly fields: readonly SearchField[];
}

/** The article search table's fields, in `document` order. The import writes `document` from the SAME list (derive.ts). */
export const ARTICLE_SEARCH_FIELDS = [
  "title",
  "author",
  "tags",
  "introduction",
  "body_text",
] as const;

export const KB_SEARCH_FIELDS = [
  "tldr",
  "problem",
  "approach",
  "components",
  "parameters",
  "decisions",
  "pitfalls",
  "entities",
  "keywords",
  "captions",
] as const;

/**
 * Corpus statistics the ranking expression needs, gathered once per search
 * (one aggregate query) rather than per row: the idf half of bm25 and the
 * per-field length normalisation, which pg_trgm gives us nothing for.
 */
export interface CorpusStats {
  readonly documents: number;
  /** term.text -> number of documents containing it. */
  readonly df: ReadonlyMap<string, number>;
  /** field name -> mean length of that raw field. */
  readonly avgFieldLength: ReadonlyMap<string, number>;
}

export interface SearchIndex {
  readonly kind: "trgm" | "pgroonga";
  /** One aggregate query over the search table; cached per request, never across (a stale idf is a silently wrong rank). */
  stats(cols: SearchColumns, terms: readonly Term[]): Promise<CorpusStats>;
  /** Boolean SQL: this row contains EVERY term (FTS5's implicit AND). The only recall definition in the system. */
  match(cols: SearchColumns, terms: readonly Term[]): SQL;
  /** Numeric SQL, higher is better, a pure function of the row (keyset paging on `(score, id)` must be stable). */
  score(cols: SearchColumns, terms: readonly Term[], stats: CorpusStats): SQL;
}

/** Minimal escape hatch for `stats`; src/library passes `(q) => db.execute(q)`. Rows are validated where they are read (boundary). */
export type SqlRunner = (query: SQL) => Promise<unknown>;

export function selectSearchIndex(kind: "trgm" | "pgroonga", run: SqlRunner): SearchIndex {
  void kind;
  void run;
  // TODO kind === "pgroonga" ? createPgroongaIndex(run) : createTrgmIndex(run)
  throw new Error("not implemented");
}
