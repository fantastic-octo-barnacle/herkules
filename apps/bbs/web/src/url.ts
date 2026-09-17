/**
 * URL state, validated once. Nothing else in the SPA parses `location.search`
 * and nothing builds a query string by hand: the route schemas below are what
 * `validateSearch` runs, and `<Link search>` is typed off their outputs.
 */
import * as z from "zod/mini";

export const scope = z._default(z.enum(["all", "title", "kb"]), "all");

/** The filter vocabulary `/`, `/search` and `/kb`'s `q` share. Plain object: both route schemas project it. */
/** Zod Mini, not full `zod`: the SPA only needs these few checks, and full zod is ~75 kB of the entry chunk. */
const str = (max: number) => z.optional(z.string().check(z.maxLength(max)));

const filter = z.object({
  q: z.optional(z.string().check(z.trim(), z.maxLength(200))),
  scope,
  tag: str(120),
  group: str(120),
});

/** `group` defaults to `groupOf(tag)` when only `tag` is present — in one place. */
const withGroup = <T extends { tag?: string; group?: string }>(s: T): T => ({
  ...s,
  group: s.group ?? (s.tag ? groupOf(s.tag) : undefined),
});

/** `/` — every field optional. */
export const feedSearch = z.pipe(filter, z.transform(withGroup));
export type FeedSearch = z.output<typeof feedSearch>;

/** `/search` — `q` optional at the type level; the route's `beforeLoad` redirects a blank one to `/`. */
export const rankedSearch = z.pipe(filter, z.transform(withGroup));
export type RankedSearch = z.output<typeof rankedSearch>;

export const kbSearch = z.object({
  q: z.optional(z.string().check(z.trim(), z.maxLength(200))),
  domain: str(64),
  robot: str(64),
  genre: str(64),
});
export type KbSearch = z.output<typeof kbSearch>;

export const accountSearch = z.object({ login_error: str(64) });
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
