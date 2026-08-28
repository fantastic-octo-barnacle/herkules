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
 *
 * Snippets reach the model as ONE string with FTS5's `[term]` markers (the SPA
 * gets the segments and renders highlights; a model reads brackets fine).
 */
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../db/search/snippet.ts";
import type { ArticleSummary, KbCard, SearchHit, SnippetSegment } from "../library/types.ts";

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
  const snippet = "snippet" in a && a.snippet ? renderSnippet(a.snippet) : undefined;
  return {
    id: a.id,
    title: a.title,
    ...(a.author ? { author: a.author } : {}),
    date: shanghaiDate(a.publishedAt ?? a.discoveredAt),
    url: a.url,
    tags: a.tags,
    ...(a.excerpt ? { excerpt: a.excerpt } : {}),
    ...(snippet ? { snippet } : {}),
    ...(a.tldr ? { tldr: a.tldr } : {}),
    score: "score" in a ? a.score : 0,
    bodyChars: a.bodyChars,
  };
}

/** Segments -> `…text [hit] text…`: hits wrapped in the FTS5 markers, everything else verbatim. */
export function renderSnippet(segments: readonly SnippetSegment[]): string {
  return segments
    .map((s) => (s.hit ? `${SNIPPET_OPEN}${s.text}${SNIPPET_CLOSE}` : s.text))
    .join("");
}

/** Compact card for `search_kb` / `get_entity` (compact=true): id, title, date, tldr, ≤ 8 entities, ≤ 3 pitfalls. */
export function kbCardOut(card: KbCard): Record<string, unknown> {
  return {
    id: card.articleId,
    title: card.title,
    ...(card.author ? { author: card.author } : {}),
    ...(card.publishedAt ? { date: shanghaiDate(card.publishedAt) } : {}),
    tldr: card.tldr,
    genre: card.genre,
    maturity: card.maturity,
    ...(card.problem ? { problem: card.problem } : {}),
    domain: card.domain,
    robotTypes: card.robotTypes,
    entities: card.entities.slice(0, 8),
    pitfalls: card.pitfalls.slice(0, 3),
  };
}

export interface ContentSlice {
  readonly text: string;
  readonly offset: number;
  readonly nextOffset?: number;
  readonly totalChars: number;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Character-safe slice; `nextOffset` present iff more remains. Never splits a surrogate pair. */
export function sliceContent(body: string, offset: number, maxChars: number): ContentSlice {
  const total = body.length;
  let start = Math.min(Math.max(0, Math.floor(offset)), total);
  if (start > 0 && start < total && isLow(body.charCodeAt(start))) start += 1;
  let end = Math.min(total, start + Math.max(1, Math.floor(maxChars)));
  if (end > start && end < total && isHigh(body.charCodeAt(end - 1))) end -= 1;
  return {
    text: body.slice(start, end),
    offset: start,
    ...(end < total ? { nextOffset: end } : {}),
    totalChars: total,
  };
}

const shanghai = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Date -> `YYYY-MM-DD` in Asia/Shanghai via Intl with a fixed timeZone (no local-clock dependency). */
export function shanghaiDate(at: Date): string {
  const parts = shanghai.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
