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
 *
 * The result is SEGMENTS, not a marked string: forum prose contains literal
 * `[1]` reference markers, so a client parsing `[`/`]` back out would be
 * ambiguous. `mcp/present.ts` joins segments with the FTS5 markers for the
 * model-facing text; the SPA renders `hit` segments as highlights.
 */
import { normalize } from "./normalize.ts";
import type { Term } from "./terms.ts";
import type { SnippetSegment } from "../../library/types.ts";

export const SNIPPET_OPEN = "[";
export const SNIPPET_CLOSE = "]";
export const SNIPPET_ELLIPSIS = "…";
/** Characters of context on each side of the chosen window. FTS5's 60 "tokens" ≈ 60 chars under trigram. */
export const SNIPPET_RADIUS = 60;
/** Occurrences considered per term per field; beyond this a window cannot get better, only slower. */
const MAX_HITS_PER_TERM = 50;

interface Hit {
  readonly start: number;
  readonly end: number;
  readonly term: number;
}

/**
 * Returns undefined when no term occurs in any field (possible: the match came
 * from `author` or `tags`, which are not snippet material) — callers show the
 * excerpt instead.
 */
export function snippet(
  fields: readonly string[],
  terms: readonly Term[],
): readonly SnippetSegment[] | undefined {
  let best: { field: string; hits: Hit[]; center: number; coverage: number } | undefined;
  for (const field of fields) {
    if (!field) continue;
    const folded = normalize(field);
    const hits = findHits(folded, terms);
    if (hits.length === 0) continue;
    // Best window: the hit position around which the most distinct terms occur.
    let center = hits[0]!.start;
    let coverage = 0;
    for (const h of hits) {
      const seen = new Set<number>();
      for (const o of hits) {
        if (o.start >= h.start - SNIPPET_RADIUS && o.end <= h.start + SNIPPET_RADIUS)
          seen.add(o.term);
      }
      if (seen.size > coverage) {
        coverage = seen.size;
        center = h.start;
      }
    }
    if (!best || coverage > best.coverage) best = { field, hits, center, coverage };
  }
  if (!best) return undefined;
  return cut(best.field, best.hits, best.center);
}

/** Every occurrence of every term, longest term first so a longer term claims its span before a shorter one nested in it. */
function findHits(folded: string, terms: readonly Term[]): Hit[] {
  const hits: Hit[] = [];
  const order = terms
    .map((_, i) => i)
    .sort((a, b) => terms[b]!.text.length - terms[a]!.text.length);
  for (const term of order) {
    const text = terms[term]!.text;
    if (!text) continue;
    let from = 0;
    let n = 0;
    while (n < MAX_HITS_PER_TERM) {
      const at = folded.indexOf(text, from);
      if (at < 0) break;
      hits.push({ start: at, end: at + text.length, term });
      from = at + 1;
      n++;
    }
  }
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

function cut(field: string, hits: readonly Hit[], center: number): readonly SnippetSegment[] {
  let start = Math.max(0, center - SNIPPET_RADIUS);
  let end = Math.min(field.length, center + SNIPPET_RADIUS);
  // Never split a surrogate pair at either edge.
  if (start > 0 && isLow(field.charCodeAt(start))) start--;
  if (end < field.length && isLow(field.charCodeAt(end))) end++;
  // Merge overlapping hits inside the window; drop the ones outside it.
  const spans: { start: number; end: number }[] = [];
  for (const h of hits) {
    if (h.end <= start || h.start >= end) continue;
    const s = Math.max(h.start, start);
    const e = Math.min(h.end, end);
    const last = spans[spans.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else spans.push({ start: s, end: e });
  }
  const out: SnippetSegment[] = [];
  const push = (text: string, hit: boolean) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.hit === hit) out[out.length - 1] = { text: last.text + text, hit };
    else out.push({ text, hit });
  };
  if (start > 0) push(SNIPPET_ELLIPSIS, false);
  let at = start;
  for (const s of spans) {
    push(collapse(field.slice(at, s.start)), false);
    push(field.slice(s.start, s.end), true);
    at = s.end;
  }
  push(collapse(field.slice(at, end)), false);
  if (end < field.length) push(SNIPPET_ELLIPSIS, false);
  return out;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
