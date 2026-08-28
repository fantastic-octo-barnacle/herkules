/**
 * Query string -> terms. Pure.
 *
 * DELIBERATE DEVIATION FROM FTS5 (stated in DESIGN.md, approved by the user):
 * rm-wenku dropped every term shorter than 3 characters (trigram floor) and, if
 * nothing survived, fell back to a date-ordered title LIKE with no score and no
 * snippet (`articles.rs:1338`). Two-character words — 步兵, 电机, 云台, 底盘 — are
 * the NORM in this corpus, so that floor silently threw away the user's most
 * specific word. Substring matching has no floor: every non-empty term survives
 * and is AND-ed. Below 3 characters the GIN index cannot help (a padded trigram
 * cannot serve a `%XY%` pattern) and Postgres seq-scans 905 rows: milliseconds.
 * Cost: golden-set queries whose FTS5 top-5 came from the degraded path will
 * differ from ours. There is no `mode` field because there is no mode.
 */
import type { NormalizedText } from "./normalize.ts";
import { normalize } from "./normalize.ts";

/** A pathological query must not build an 8-way index intersection with 40 LIKE rechecks per row. */
export const MAX_TERMS = 8;

/** A term as it will be matched: folded, and with LIKE metacharacters neutralised. */
export interface Term {
  /** What the user typed (trimmed), for echoing back. */
  readonly raw: string;
  /** Folded; compared against `document` and searched in `normalize(field)` for snippets. */
  readonly text: NormalizedText;
  /** `text` with `%`, `_` and `\` escaped; goes into `LIKE '%' || pattern || '%' ESCAPE '\'`. */
  readonly pattern: string;
}

/** Whitespace-split, `"` stripped, folded, de-duplicated, capped at MAX_TERMS. Empty for a blank query. */
export function parseTerms(query: string): readonly Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const raw of query.replaceAll('"', " ").trim().split(/\s+/)) {
    if (!raw) continue;
    const term = toTerm(raw);
    if (seen.has(term.text)) continue;
    seen.add(term.text);
    out.push(term);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

export function toTerm(raw: string): Term {
  const text = normalize(raw);
  return { raw, text, pattern: text.replace(/[\\%_]/g, (m) => `\\${m}`) };
}
