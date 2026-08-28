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
 * database, on every imported row.
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

export function normalize(input: string): NormalizedText {
  void input;
  // TODO out = new Array(input.length)
  //      for i in 0..input.length:
  //        c = input.charCodeAt(i)
  //        if (c >= 0xff01 && c <= 0xff5e) c -= 0xfee0
  //        else if (c === 0x3000) c = 0x20
  //        ch = String.fromCharCode(c); lower = ch.toLowerCase()
  //        out[i] = lower.length === 1 ? lower : ch
  //      return out.join("") as NormalizedText
  //      Surrogate halves never fold (neither is in any range above), so pairs survive intact.
  throw new Error("not implemented");
}
