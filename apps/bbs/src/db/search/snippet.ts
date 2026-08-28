/**
 * FTS5 `snippet(fts, -1, '[', ']', '…', 60)` in TypeScript over the RAW fields
 * of the ≤ limit+1 hit rows. Pure, engine-independent (identical under
 * PGroonga), and the whole of "snippets computed in TypeScript" (FRAME).
 *
 * Positions are found on `normalize(field)` and applied to `field` — legal
 * because the fold is length-preserving — so the snippet reads the way the
 * article reads: `【RM2026-开源】` keeps its brackets, `HPM5361` its capitals,
 * even though the query `hpm5361` matched.
 *
 * Field choice reproduces FTS5's `-1` (best column): the field and window
 * containing the most DISTINCT terms wins, ties to the earlier field in
 * `fields` order (callers pass body, introduction, title — the prose first).
 */
import type { Term } from "./terms.ts";

export const SNIPPET_OPEN = "[";
export const SNIPPET_CLOSE = "]";
export const SNIPPET_ELLIPSIS = "…";
/** Characters of context on each side of the chosen window. FTS5's 60 "tokens" ≈ 60 chars under trigram. */
export const SNIPPET_RADIUS = 60;

/**
 * Returns undefined when no term occurs in any field (possible: the match came
 * from `author` or `tags`, which are not snippet material) — callers show the
 * excerpt instead.
 */
export function snippet(fields: readonly string[], terms: readonly Term[]): string | undefined {
  void fields;
  void terms;
  // TODO for field of fields:
  //        folded = normalize(field); hits = every indexOf position of every term (cap 50 per term), longest term first
  //        best window = argmax over hit positions p of |distinct terms with a hit in [p - RADIUS, p + RADIUS]|, tie -> earliest
  //      keep the field with the highest coverage (first wins ties); none -> undefined
  //      cut = [max(0, p - RADIUS), min(len, p + RADIUS)], snapped outward off a low surrogate
  //      emit field.slice(cut) with OPEN/CLOSE around every (merged, non-overlapping) hit inside it,
  //      whitespace collapsed, ELLIPSIS prefixed/suffixed where the cut is not at an edge
  throw new Error("not implemented");
}
