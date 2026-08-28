/**
 * Search snippets. Round 1 puts SEGMENTS on the wire (`{ text, hit }`) rather
 * than a `[term]`-marked string, because forum prose contains literal `[1]`
 * reference markers that cannot be parsed back out. So this module never
 * parses anything; it only decides how much of the non-hit text fits.
 */
import type { SearchPageDTO } from "../../../src/api/dto.ts";

export type Segment = NonNullable<SearchPageDTO["items"][number]["snippet"]>[number];

/** One row of the feed has room for roughly this much snippet. */
export const SNIPPET_MAX = 160;

const ELLIPSIS = "…";

/**
 * Collapses whitespace, trims the ends, and caps the result at `max`
 * characters **while keeping every hit segment intact** — a snippet that
 * dropped a match would be lying about why the row is in the results. The
 * budget left over is shared evenly among the non-hit runs, each cut from the
 * side away from its neighbouring hit, with `…` marking the cut. When the hits
 * alone exceed `max` the result is longer than `max`: hits win.
 */
export function trimSegments(
  segments: readonly Segment[],
  max: number = SNIPPET_MAX,
): readonly Segment[] {
  const collapsed = segments
    .map((s) => ({ text: s.text.replace(/\s+/g, " "), hit: s.hit }))
    .filter((s) => s.hit || s.text.length > 0);
  if (collapsed.length === 0) return [];

  // Trim only the outer edges; interior single spaces are real word boundaries.
  const first = collapsed[0];
  const last = collapsed[collapsed.length - 1];
  if (first && !first.hit) first.text = first.text.replace(/^\s+/, "");
  if (last && !last.hit) last.text = last.text.replace(/\s+$/, "");

  const total = collapsed.reduce((n, s) => n + s.text.length, 0);
  if (total <= max) return collapsed.filter((s) => s.hit || s.text.length > 0);

  const hitChars = collapsed.reduce((n, s) => (s.hit ? n + s.text.length : n), 0);
  const gaps = collapsed.filter((s) => !s.hit);
  const budget = Math.max(0, max - hitChars);
  const share = gaps.length === 0 ? 0 : Math.floor(budget / gaps.length);

  const lastIndex = collapsed.length - 1;
  const out: Segment[] = [];
  for (const [index, segment] of collapsed.entries()) {
    if (segment.hit) {
      out.push(segment);
      continue;
    }
    if (segment.text.length <= share) {
      if (segment.text.length > 0) out.push(segment);
      continue;
    }
    // Keep the side that touches a hit: the tail before the first hit, the head
    // after the last one, both ends in between.
    const head = index === 0 ? "" : segment.text.slice(0, Math.ceil(share / 2)).trimEnd();
    const tail =
      index === lastIndex
        ? ""
        : segment.text.slice(-Math.max(1, Math.floor(share / 2))).trimStart();
    const text =
      index === 0
        ? `${ELLIPSIS}${tail}`
        : index === lastIndex
          ? `${head}${ELLIPSIS}`
          : `${head}${ELLIPSIS}${tail}`;
    out.push({ text, hit: false });
  }
  return out;
}
