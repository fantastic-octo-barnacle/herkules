/**
 * Domain -> what reads well to a model. Pure functions, no I/O, no SQL.
 *
 * NOT the HTTP DTOs and not to be unified with them. rm-wenku made three
 * choices on purpose (ground-A #11) and they are kept:
 *  1. `date` is `YYYY-MM-DD` in Asia/Shanghai, not an epoch or an ISO instant.
 *  2. `ArticleHit` is FLAT — no nested `titleParts`, no counts a model will not use.
 *  3. Content is paged by CHARACTERS (`max_chars` default 30 000, max 100 000,
 *     `offset`), never splitting a surrogate pair. Byte paging on CJK cuts code points.
 * rm-wenku's UTC+8 dates and UTC-midnight quota boundaries disagreed by eight
 * hours (ground-A #18); there are no quotas here, so there is one timezone.
 */
import type { ArticleSummary, KbCard, SearchHit } from "../library/types.ts";

export const DISPLAY_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_MAX_CHARS = 30_000;
export const MAX_MAX_CHARS = 100_000;

export interface ArticleHit {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  /** `YYYY-MM-DD` in Asia/Shanghai, from publishedAt ?? discoveredAt. */
  readonly date: string;
  readonly url: string;
  readonly tags: readonly string[];
  readonly excerpt?: string;
  readonly snippet?: string;
  readonly tldr?: string;
  readonly score: number;
  readonly bodyChars: number;
}

export function articleHit(a: ArticleSummary | SearchHit): ArticleHit {
  void a;
  throw new Error("not implemented");
}

/** Compact card for `search_kb` / `get_entity` (compact=true): id, title, date, tldr, ≤ 8 parameters, ≤ 3 pitfalls. */
export function kbCardOut(card: KbCard): Record<string, unknown> {
  void card;
  throw new Error("not implemented");
}

export interface ContentSlice {
  readonly text: string;
  readonly offset: number;
  readonly nextOffset?: number;
  readonly totalChars: number;
}

/** Character-safe slice; `nextOffset` present iff more remains. Never splits a surrogate pair. */
export function sliceContent(body: string, offset: number, maxChars: number): ContentSlice {
  void body;
  void offset;
  void maxChars;
  throw new Error("not implemented");
}

/** Date -> `YYYY-MM-DD` in Asia/Shanghai via Intl with a fixed timeZone (no local-clock dependency). */
export function shanghaiDate(at: Date): string {
  void at;
  throw new Error("not implemented");
}
