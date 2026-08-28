/**
 * URL state, validated once. Nothing else in the SPA parses `location.search`
 * and nothing builds a query string by hand: the route schemas below are what
 * `validateSearch` runs, and `<Link search>` is typed off their outputs.
 */
import { z } from "zod";

export const scope = z.enum(["all", "title", "kb"]).default("all");

/** The filter vocabulary `/`, `/search` and `/kb`'s `q` share. Plain object: both route schemas project it. */
const filter = z.object({
  q: z.string().trim().max(200).optional(),
  scope,
  tag: z.string().max(120).optional(),
  group: z.string().max(120).optional(),
});

/** `group` defaults to `groupOf(tag)` when only `tag` is present — in one place. */
const withGroup = <T extends { tag?: string; group?: string }>(s: T): T => ({
  ...s,
  group: s.group ?? (s.tag ? groupOf(s.tag) : undefined),
});

/** `/` — every field optional. */
export const feedSearch = filter.transform(withGroup);
export type FeedSearch = z.output<typeof feedSearch>;

/** `/search` — `q` optional at the type level; the route's `beforeLoad` redirects a blank one to `/`. */
export const rankedSearch = filter.transform(withGroup);
export type RankedSearch = z.output<typeof rankedSearch>;

export const kbSearch = z.object({
  q: z.string().trim().max(200).optional(),
  domain: z.string().max(64).optional(),
  robot: z.string().max(64).optional(),
  genre: z.string().max(64).optional(),
});
export type KbSearch = z.output<typeof kbSearch>;

export const accountSearch = z.object({ login_error: z.string().max(64).optional() });
export type AccountSearch = z.output<typeof accountSearch>;

/**
 * `硬件/机器人硬件` -> `硬件`; a tag without `/` is its own group. Mirrors
 * `article_tags.group_name`, which Postgres GENERATEs as `split_part(tag, '/', 1)`
 * — everything before the FIRST slash, the whole string when there is none.
 */
/** `硬件/机器人硬件` -> `机器人硬件`: the leaf a chip shows under its own group. */
export function leafOf(tag: string): string {
  const slash = tag.indexOf("/");
  return slash === -1 ? tag : tag.slice(slash + 1);
}

/**
 * Search middleware for `/` and `/search`: the URL is the only state, so it must
 * not show what the schema already knows — `scope=all` (the default) and a
 * `group` that is just `groupOf(tag)` are stripped before the href is written.
 */
export function stripDerived<T extends { scope: string; tag?: string; group?: string }>(
  search: T,
): T {
  const out: Record<string, unknown> = { ...search };
  if (out.scope === "all") delete out.scope;
  if (search.tag && search.group === groupOf(search.tag)) delete out.group;
  return out as T;
}

export function groupOf(tag: string): string {
  const slash = tag.indexOf("/");
  return slash === -1 ? tag : tag.slice(0, slash);
}
