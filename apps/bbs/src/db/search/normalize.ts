/**
 * THE fold: applied to every indexed `document` at import and to every query
 * term at search time. Pure, no imports, and the ONLY definition in the system.
 * There is deliberately no SQL twin (candidate A's `bbs_fold()` wrapped
 * `lower()`, which is not length-preserving); wherever SQL needs folded text it
 * slices `document`, never re-folds (db/search/trgm.ts).
 *
 * THE INVARIANT, and the reason both the ranking slices and the snippet path work:
 *
 *     normalize(s).length === s.length   (UTF-16 code units), and
 *     normalize(s)[i] is the fold of s[i].
 *
 * So an offset found in the folded text is the same offset in the raw text:
 * `substr(document, start, length(field))` IS the folded field, and a snippet can
 * be cut from the ORIGINAL — original case, original 【】 — around a match found
 * in the fold. `article_search_document_aligned` CHECKs the length half at the
 * database, on every imported row. (Postgres `length()` counts code points, not
 * code units; the fold never touches a surrogate half, so both counts are
 * preserved and the CHECK holds in either unit.)
 *
 * What the fold does, all of it strictly 1:1:
 *   - U+FF01…U+FF5E (full-width ASCII) -> U+0021…U+007E   （）：，Ａ -> ():,a
 *   - U+3000 (ideographic space)       -> U+0020
 *   - per code unit `toLowerCase()`, kept only when it stays one code unit
 *     ('İ' -> 'i̇' would shift offsets; it is left alone)
 * Not done: NFKC (not length-preserving), diacritics (irrelevant here), CJK
 * variants. PGroonga's `NormalizerNFKC150` did width+case for free; this is the
 * stock-Postgres half of it. FTS5-trigram folded ASCII case only, so the port is
 * strictly MORE forgiving — it can add recall on the golden set, never remove it.
 */

/** Stamped into `import_runs.normalize_version`; bump when the fold changes (forces a re-import). */
export const NORMALIZE_VERSION = "1";

/** A string produced by `normalize`. Offsets into it index the source string too. */
export type NormalizedText = string & { readonly __normalized: unique symbol };

/** Per-code-unit fold table, filled lazily for the BMP units actually seen. */
const cache = new Map<number, string>();

function foldUnit(c: number): string {
  const hit = cache.get(c);
  if (hit !== undefined) return hit;
  let code = c;
  if (code >= 0xff01 && code <= 0xff5e) code -= 0xfee0;
  else if (code === 0x3000) code = 0x20;
  const ch = String.fromCharCode(code);
  const lower = ch.toLowerCase();
  const out = lower.length === 1 ? lower : ch;
  cache.set(c, out);
  return out;
}

export function normalize(input: string): NormalizedText {
  let out = "";
  let runStart = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // Fast path: ASCII that is not an upper-case letter, and every CJK ideograph, fold to themselves.
    if (c < 0x41 || (c > 0x5a && c < 0x80) || (c >= 0x4e00 && c <= 0x9fff)) continue;
    const folded = foldUnit(c);
    if (folded.charCodeAt(0) === c) continue;
    out += input.slice(runStart, i) + folded;
    runStart = i + 1;
  }
  return (runStart === 0 ? input : out + input.slice(runStart)) as NormalizedText;
}
