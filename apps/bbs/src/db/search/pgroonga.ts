/**
 * The pre-planned fallback behind the same `SearchIndex`. Not built in v1 — it
 * exists as a file so the seam is visible and the swap has a named destination.
 * It becomes real only if done-predicate check 5 fails (< 15/20 top-5 overlap
 * with FTS5 on the golden set); that is explicitly NOT a kill criterion.
 *
 *   match  -> document &@~ :query            (PGroonga query syntax, terms AND-ed)
 *   score  -> pgroonga_score(tableoid, ctid)
 *   stats  -> unused (PGroonga has its own idf); return empty maps
 * Snippets stay in TypeScript over the raw fields, unchanged by the swap.
 *
 * Carried forward so it is not rediscovered: `NormalizerNFKC150` folds width and
 * case in the index — keep writing `document` folded anyway, so the alignment
 * CHECK and the snippet path are untouched; `TRUNCATE` strands Groonga index
 * files, so the import must run `SELECT pgroonga_vacuum()` after COMMIT
 * (herkules-old learned this); the custom image forces Docker into the search
 * test path, which is the reason it is the fallback.
 */
import type { SearchIndex, SqlRunner } from "./index.ts";

export function createPgroongaIndex(run: SqlRunner): SearchIndex {
  void run;
  throw new Error("not implemented: pgroonga is the check-5 fallback, see apps/bbs/DESIGN.md");
}
