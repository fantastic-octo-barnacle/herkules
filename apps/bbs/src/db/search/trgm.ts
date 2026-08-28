/**
 * `pg_trgm` on stock Postgres 17 — the v1 `SearchIndex`.
 *
 * RECALL is substring conjunction, exactly FTS5-trigram's semantics:
 *
 *     document LIKE '%' || :t1 || '%' ESCAPE '\' AND document LIKE '%' || :t2 || '%' …
 *
 * served by the table's `gin_trgm_ops` index for terms ≥ 3 characters and by a
 * 905-row seq scan below that (terms.ts). NOT `similarity()`: measured on
 * pg_trgm 1.6, a 2-character Chinese term mid-sentence scores exactly 0.0 and
 * `%` returns 0 rows where LIKE returns thousands — pg_trgm pads each "word"
 * with blanks and an unbroken CJK run is one word, so `步兵` has only padded
 * trigrams and none of them occur inside `大学步兵开源`. Using it for recall
 * would change the result SET, which is the one thing check 5 cannot absorb.
 * Terms are pre-folded and `document` is stored folded, so plain LIKE is
 * already case- and width-insensitive; ILIKE is avoided on purpose.
 *
 * RANKING is bm25's shape without bm25 — what FTS5's default `bm25()` did:
 *   tf(t, f)  = (length(F) - length(replace(F, t, ''))) / length(t)      F = fieldSlice(f)
 *   idf(t)    = ln(1 + (N - df + 0.5) / (df + 0.5))                      from CorpusStats
 *   part      = idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length(f) / avglen(f)))
 *   score     = Σ_t Σ_f part,  k1 = 1.2, b = 0.75
 * `fieldSlice` is the folded field read straight out of `document` (see
 * index.ts): no `lower()`, no SQL fold, no locale dependence anywhere. The
 * `replace()` trick is O(field) per row and runs only on rows `match` admitted.
 *
 * What this gives up versus PGroonga: no CJK segmentation (`机器` matches inside
 * `机器人`, as FTS5 also did) and no NFKC beyond width+case.
 */
import type { SQL } from "drizzle-orm";

import type { CorpusStats, SearchColumns, SearchIndex, SqlRunner } from "./index.ts";
import type { Term } from "./terms.ts";

/** bm25's saturation and length-normalisation constants; FTS5 uses the same defaults. */
export const K1 = 1.2;
export const B = 0.75;

export function createTrgmIndex(run: SqlRunner): SearchIndex {
  void run;
  // TODO return { kind: "trgm", stats: (c, t) => trgmStats(run, c, t), match: trgmMatch, score: trgmScore }
  throw new Error("not implemented");
}

/**
 * The folded field i, sliced out of `document`:
 *   substr(document, 1 + Σ_{j<i}(length(field_j) + 1), length(field_i))
 * Legal only because of the length-preserving fold and the table's alignment CHECK.
 */
export function fieldSlice(cols: SearchColumns, i: number): SQL {
  void cols;
  void i;
  // TODO start = sql`1` joined with ` + length(${cols.fields[j].column}) + 1` for j < i
  //      return sql`substr(${cols.document}, ${start}, length(${cols.fields[i].column}))`
  throw new Error("not implemented");
}

/**
 * One query, one row:
 *   SELECT count(*) AS documents,
 *          count(*) FILTER (WHERE <match for t1 alone>) AS df_0, …,
 *          avg(length(<field_0>)) AS avg_0, …
 *   FROM <the search table>
 * Index-assisted FILTERs; sub-millisecond at 905 rows.
 */
export function trgmStats(
  run: SqlRunner,
  cols: SearchColumns,
  terms: readonly Term[],
): Promise<CorpusStats> {
  void run;
  void cols;
  void terms;
  throw new Error("not implemented");
}

export function trgmMatch(cols: SearchColumns, terms: readonly Term[]): SQL {
  void cols;
  void terms;
  // TODO terms.length === 0 ? sql`true`
  //      : and(...terms.map((t) => sql`${cols.document} LIKE ${"%" + t.pattern + "%"} ESCAPE '\\'`))
  throw new Error("not implemented");
}

export function trgmScore(cols: SearchColumns, terms: readonly Term[], stats: CorpusStats): SQL {
  void cols;
  void terms;
  void stats;
  void K1;
  void B;
  // TODO coalesce(sql.join(terms.flatMap((t) => cols.fields.map((f, i) => {
  //        const F    = fieldSlice(cols, i)
  //        const tf   = sql`((length(${F}) - length(replace(${F}, ${t.text}, ''))) / ${t.text.length}::numeric)`
  //        const norm = sql`(${K1} * (1 - ${B} + ${B} * length(${f.column}) / greatest(${avg(f.name)}, 1)))`
  //        return sql`${idf(t)} * ${tf} * ${K1 + 1} / nullif(${tf} + ${norm}, 0)`
  //      })), sql` + `), 0)::double precision
  throw new Error("not implemented");
}
