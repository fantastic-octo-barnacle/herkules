/**
 * Pagination. Pure, and the only place that knows a cursor is anything but an
 * opaque string.
 *
 * rm-wenku used a numeric OFFSET. That is wrong here for a reason specific to
 * this deployment: `bbs import` rewrites every row of `articles` in one
 * transaction, weekly, on purpose, while people are reading — an offset taken
 * before an import addresses different rows after it. Keyset paging on the
 * sort key has no such failure mode, and the key is already total:
 *
 *     ORDER BY COALESCE(published_at, discovered_at) DESC, listing_position ASC, id DESC
 *
 * (`id` is a ULID). `articles_feed_idx` is the expression index over exactly
 * that triple. Search pages on `(score DESC, id DESC)` instead, because the
 * ranking is the order. Both live in one codec so every route has one opaque
 * `cursor` parameter and one `nextCursor` field.
 */
import type { SQL } from "drizzle-orm";

import type { ArticleId, Cursor } from "./types.ts";

export interface FeedKey {
  readonly kind: "feed";
  /** COALESCE(published_at, discovered_at) of the last row returned. */
  readonly at: Date;
  readonly position: number;
  readonly id: ArticleId;
}

/** Position in one query's ranking. Only comparable against the same query. */
export interface RankKey {
  readonly kind: "rank";
  readonly score: number;
  readonly id: ArticleId;
}

export type CursorKey = FeedKey | RankKey;

/** base64url of a compact JSON tuple. Never signed: it addresses public data and forges nothing. */
export function encodeCursor(key: CursorKey): Cursor {
  void key;
  // TODO feed -> ["f", at.toISOString(), position, id]; rank -> ["r", score, id]
  throw new Error("not implemented");
}

/** Null for anything unparseable or of the wrong kind; the caller throws QueryError("invalid_cursor") -> 400. */
export function decodeCursor(raw: string, kind: CursorKey["kind"]): CursorKey | null {
  void raw;
  void kind;
  throw new Error("not implemented");
}

/**
 * The `WHERE` half of keyset paging over the feed, written as the explicit
 * three-clause chain (always index-served on `articles_feed_idx`):
 *   at < :at OR (at = :at AND (listing_position > :pos OR (listing_position = :pos AND id < :id)))
 * where `at` is the COALESCE expression. TODO: try the row-comparison form
 * `(at, -listing_position, id) < (:at, -:pos, :id)` on real Postgres with EXPLAIN; keep whichever plans.
 */
export function feedAfter(key: FeedKey): SQL {
  void key;
  throw new Error("not implemented");
}

/**
 * `(<score expr>, id) < (:score, :id)`. The score EXPRESSION must be repeated here
 * (Postgres forbids the alias in WHERE) — a real cost of ranked keyset paging and
 * one reason `limit` is capped at 100.
 */
export function rankAfter(key: RankKey, scoreExpr: SQL): SQL {
  void key;
  void scoreExpr;
  throw new Error("not implemented");
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
