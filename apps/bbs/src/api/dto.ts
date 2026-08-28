/**
 * Domain -> HTTP wire, as a TYPE. `c.json()` already renders `Date` as ISO 8601
 * and drops nothing, so no mapping functions exist; this file names what the
 * SPA receives so `hc<AppType>` consumers and round 2 can talk about it.
 *
 * The MCP presenter (mcp/present.ts) renders the SAME domain values differently
 * — `YYYY-MM-DD` in Asia/Shanghai, content paged by characters — because that
 * is what reads well to a model. Two presenters, one domain (ground-A #11).
 */
import type {
  Article,
  ArticleAi,
  ArticleSummary,
  EntityDetail,
  KbBrowse,
  LibraryStatus,
  Page,
  SearchPage,
  TagIndex,
  Viewer,
} from "../library/types.ts";

/**
 * `Date -> string`, brands erased, applied recursively. String LITERAL unions
 * (`Viewer.role`, `ArticleAi.status`, `ArticleLink.kind`) survive — `hc`'s own
 * inference keeps them, and `T extends string ? string` would silently widen them.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends string & { readonly __brand: unknown }
    ? string
    : T extends readonly (infer E)[]
      ? readonly Wire<E>[]
      : T extends object
        ? { readonly [K in keyof T]: Wire<T[K]> }
        : T;

export type ArticleSummaryDTO = Wire<ArticleSummary>;
export type ArticleDTO = Wire<Article>;
export type ArticleAiDTO = Wire<ArticleAi>;
export type ArticlePageDTO = Wire<Page<ArticleSummary>>;
export type SearchPageDTO = Wire<SearchPage>;
export type TagIndexDTO = Wire<TagIndex>;
export type KbBrowseDTO = Wire<KbBrowse>;
export type EntityDetailDTO = Wire<EntityDetail>;
export type LibraryStatusDTO = Wire<LibraryStatus>;
export type ViewerDTO = Wire<Viewer>;

/** The repo's error envelope (auth-middleware renders the same shape for 401/403/503). */
export interface ErrorDTO {
  readonly error: string;
  readonly error_description: string;
}
