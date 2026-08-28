/**
 * Request validation. Every query string entering the app is parsed here into
 * the library's own argument shape; nothing downstream re-checks a bound and
 * nothing downstream sees a raw string (validate at the edge, trust inside).
 */
import { z } from "zod";

import { DEFAULT_LIMIT, MAX_LIMIT } from "../library/cursor.ts";

/** rm-wenku treated `limit=0` as "default"; the SPA still sends it on first load. */
const limit = (max = MAX_LIMIT, fallback: number = DEFAULT_LIMIT) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .transform((n) => (!n ? fallback : Math.min(n, max)));

export const scope = z.enum(["all", "title", "kb"]).default("all");

export const articleListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  scope,
  tag: z.string().max(120).optional(),
  group: z.string().max(120).optional(),
  cursor: z.string().max(512).optional(),
  limit: limit(),
});

/** 400 on blank, as rm-wenku did — an empty ranked search has no meaning. */
export const searchQuery = articleListQuery.extend({ q: z.string().trim().min(1).max(200) });

export const kbBrowseQuery = z.object({
  q: z.string().trim().max(200).optional(),
  domain: z.string().max(64).optional(),
  robot: z.string().max(64).optional(),
  genre: z.string().max(64).optional(),
  limit: limit(1000, 200),
});

export const entityListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  limit: limit(500, 200),
});

export const contentQuery = z.object({
  format: z.enum(["text", "markdown", "html"]).default("text"),
});

/** 26 Crockford base32 characters. Rejecting here is what makes `ArticleId` a real brand. */
export const articleIdParam = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

/** `/kb/entities/:name` accepts a display name or a key; `entityKey()` normalises either. */
export const entityNameParam = z.string().min(1).max(200);
