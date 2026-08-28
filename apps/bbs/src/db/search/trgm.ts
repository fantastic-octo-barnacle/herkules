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
 *
 * Constants (k1, b, idf, avglen) are inlined with `sql.raw` from numbers this
 * file computes — never from user input — so both drivers see typed literals
 * instead of untyped `$n` parameters inside arithmetic.
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { rowsOf } from "../index.ts";
import type { CorpusStats, SearchColumns, SearchIndex, SqlRunner } from "./index.ts";
import type { Term } from "./terms.ts";

/** bm25's saturation and length-normalisation constants; FTS5 uses the same defaults. */
export const K1 = 1.2;
export const B = 0.75;

export function createTrgmIndex(run: SqlRunner): SearchIndex {
  return {
    kind: "trgm",
    stats: (cols, terms) => trgmStats(run, cols, terms),
    match: trgmMatch,
    score: trgmScore,
  };
}

/**
 * The folded field i, sliced out of `document`:
 *   substr(document, 1 + Σ_{j<i}(length(field_j) + 1), length(field_i))
 * Legal only because of the length-preserving fold and the table's alignment CHECK.
 */
export function fieldSlice(cols: SearchColumns, i: number): SQL {
  const field = cols.fields[i];
  if (!field) throw new RangeError(`fieldSlice: no field ${i}`);
  const start = sql.join(
    [sql`1`, ...cols.fields.slice(0, i).map((f) => sql`length(${f.column}) + 1`)],
    sql` + `,
  );
  return sql`substr(${cols.document}, ${start}, length(${field.column}))`;
}

/**
 * One query, one row:
 *   SELECT count(*) AS documents,
 *          count(*) FILTER (WHERE <match for t1 alone>) AS df_0, …,
 *          avg(length(<field_0>)) AS avg_0, …
 *   FROM <the search table>
 * Index-assisted FILTERs; sub-millisecond at 905 rows.
 */
export async function trgmStats(
  run: SqlRunner,
  cols: SearchColumns,
  terms: readonly Term[],
): Promise<CorpusStats> {
  const selects = [
    sql`count(*)::int AS documents`,
    ...terms.map(
      (t, i) => sql`count(*) FILTER (WHERE ${trgmMatch(cols, [t])})::int AS ${sql.raw(`df_${i}`)}`,
    ),
    ...cols.fields.map(
      (f, i) =>
        sql`coalesce(avg(length(${f.column})), 0)::double precision AS ${sql.raw(`avg_${i}`)}`,
    ),
  ];
  const row = rowsOf(await run(sql`SELECT ${sql.join(selects, sql`, `)} FROM ${cols.from}`))[0];
  if (!row) throw new Error("trgmStats: aggregate returned no row");
  return {
    documents: num(row.documents),
    df: new Map(terms.map((t, i) => [t.text, num(row[`df_${i}`])])),
    avgFieldLength: new Map(cols.fields.map((f, i) => [f.name, num(row[`avg_${i}`])])),
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function trgmMatch(cols: SearchColumns, terms: readonly Term[]): SQL {
  if (terms.length === 0) return sql`true`;
  return sql.join(
    terms.map((t) => sql`${cols.document} LIKE ${`%${t.pattern}%`} ESCAPE '\\'`),
    sql` AND `,
  );
}

export function trgmScore(cols: SearchColumns, terms: readonly Term[], stats: CorpusStats): SQL {
  if (terms.length === 0 || cols.fields.length === 0) return sql`0::double precision`;
  const n = Math.max(stats.documents, 1);
  const lit = (x: number) => sql.raw(x.toPrecision(12));
  const parts = terms.flatMap((t) => {
    const df = stats.df.get(t.text) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    return cols.fields.map((f, i) => {
      const slice = fieldSlice(cols, i);
      const tf = sql`((length(${slice}) - length(replace(${slice}, ${t.text}, '')))::double precision / length(${t.text}::text))`;
      const avg = Math.max(stats.avgFieldLength.get(f.name) ?? 0, 1);
      const norm = sql`(${lit(K1)} * (1 - ${lit(B)} + ${lit(B)} * length(${f.column}) / ${lit(avg)}))`;
      return sql`(${lit(idf)} * ${tf} * ${lit(K1 + 1)} / nullif(${tf} + ${norm}, 0))`;
    });
  });
  return sql`coalesce(${sql.join(parts, sql` + `)}, 0)::double precision`;
}
