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
 *
 * The predicates reference the `articles` table UNALIASED (drizzle renders
 * `"articles"."published_at"`); every statement in src/library keeps `articles`
 * under its own name and aliases only secondary joins (`aliasedTable`).
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { articles } from "../db/schema.ts";
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
  const tuple =
    key.kind === "feed"
      ? ["f", key.at.toISOString(), key.position, key.id]
      : ["r", key.score, key.id];
  return Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url") as Cursor;
}

/** Null for anything unparseable or of the wrong kind; the caller throws QueryError("invalid_cursor") -> 400. */
export function decodeCursor(raw: string, kind: CursorKey["kind"]): CursorKey | null {
  let tuple: unknown;
  try {
    tuple = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(tuple)) return null;
  if (kind === "feed") {
    const [tag, at, position, id] = tuple as unknown[];
    if (tag !== "f" || typeof at !== "string" || typeof position !== "number" || !isId(id)) {
      return null;
    }
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || !Number.isInteger(position)) return null;
    return { kind: "feed", at: date, position, id: id as ArticleId };
  }
  const [tag, score, id] = tuple as unknown[];
  if (tag !== "r" || typeof score !== "number" || !Number.isFinite(score) || !isId(id)) return null;
  return { kind: "rank", score, id: id as ArticleId };
}

function isId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(v);
}

/** The feed's sort expression; also what `feedAfter` compares against. */
export const FEED_AT: SQL = sql`coalesce(${articles.publishedAt}, ${articles.discoveredAt})`;

/**
 * The `WHERE` half of keyset paging over the feed, written as the explicit
 * three-clause chain (always index-served on `articles_feed_idx`):
 *   at < :at OR (at = :at AND (listing_position > :pos OR (listing_position = :pos AND id < :id)))
 * where `at` is the COALESCE expression. The row-comparison form
 * `(at, -listing_position, id) < (:at, -:pos, :id)` cannot use the index because the
 * index key is `listing_position ASC`, not its negation; the chain matches the key exactly.
 */
export function feedAfter(key: FeedKey): SQL {
  const at = sql`${key.at.toISOString()}::timestamptz`;
  return sql`(${FEED_AT} < ${at} OR (${FEED_AT} = ${at} AND (${articles.listingPosition} > ${key.position} OR (${articles.listingPosition} = ${key.position} AND ${articles.id} < ${key.id}))))`;
}

/**
 * `(<score expr>, id) < (:score, :id)`. The score EXPRESSION must be repeated here
 * (Postgres forbids the alias in WHERE) — a real cost of ranked keyset paging and
 * one reason `limit` is capped at 100.
 */
export function rankAfter(key: RankKey, scoreExpr: SQL): SQL {
  return sql`((${scoreExpr}) < ${key.score}::double precision OR ((${scoreExpr}) = ${key.score}::double precision AND ${articles.id} < ${key.id}))`;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
