/**
 * Title rendering. The season/team/labels/topic split is the server's
 * (`titleParts` on every summary), so all that is left here is the one thing
 * the corpus's own text needs cleaning of.
 */

/** Excerpts copied from the forum often begin with a literal 简介 label. */
export function cleanExcerpt(excerpt: string | null): string | null {
  const cleaned = excerpt?.replace(/^\s*简介\s*[:：]?\s*/, "").trim();
  return cleaned ? cleaned : null;
}
