/**
 * source/ — the forum, seen from inside the crawler.
 *
 * Boundary rule: nothing exported from this directory mentions JSON, HTTP
 * status codes as data, or a forum field name. Wire DTOs, zod schemas, endpoint
 * paths and the UA live in robomaster.ts and never cross this file. Callers
 * (crawl/) see `Source`, `Listing`, `ListedArticle`, `ArticleDetail`,
 * `SourceError`, `ThrottledError` — nothing else.
 *
 * Two error classes on purpose: rm-wenku's ingest treated seven failure kinds
 * identically (mark_failed) and ONE differently — Throttled, which must never
 * touch an article row. `ThrottledError` is therefore not a kind of
 * `SourceError`: `catch (e) { if (e instanceof ThrottledError) … }` is the
 * whole branch, and a new SourceFailure kind can never acquire throttle
 * semantics by accident.
 *
 * Ids: `sourceArticleId` is the forum's post id (numeric string). The local
 * `articles.id` ULID is minted by crawl/corpus.ts on first sight, never here.
 */
import type { Extracted } from "../content/extract.ts";
import type { FailureKind } from "../guard/policy.ts";

export { ThrottledError } from "../guard/index.ts";
export type { Priority } from "../guard/policy.ts";

export const SOURCE_ID = "robomaster" as const;
export type SourceId = typeof SOURCE_ID;

/** A row of the listing endpoint, already clean: text collapsed, dates parsed, URL minted + normalised. */
export interface ListedArticle {
  readonly sourceArticleId: string;
  /** Minted `{origin}/article/{id}?source=1`, normalised (content/urls.ts). What `canonical_url` stores. */
  readonly url: string;
  readonly title: string; // non-empty (a titleless post is SourceError invalid at the boundary)
  readonly author: string | null;
  readonly publishedAt: Date | null;
  readonly isPinned: boolean;
  readonly introduction: string | null;
  /** `group/name`, deduped, listing order. */
  readonly tags: readonly string[];
  /** (page-1)*pageSize + index. */
  readonly listingPosition: number;
}

export interface Listing {
  readonly items: readonly ListedArticle[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** short page || page*pageSize >= total — the backfill's stop condition, decided here once. */
  readonly isLast: boolean;
}

/** Everything one article write needs; the corpus adds only ids, timestamps and derived columns. */
export interface ArticleDetail {
  readonly sourceArticleId: string;
  readonly url: string;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: Date | null;
  readonly isPinned: boolean;
  readonly introduction: string | null;
  readonly tags: readonly string[];
  readonly format: "html" | "markdown";
  readonly raw: string;
  /** body_text + links + images, attachments/fileItems/references already folded in (content/extract.ts rules). */
  readonly extracted: Extracted;
  /** Stamped into articles.parser_version; "rm-api-v5" for this adapter. */
  readonly parserVersion: string;
}

export interface Source {
  readonly id: SourceId;
  /** Site URL for the `sources` row (constant per adapter). */
  readonly siteUrl: string;
  /**
   * 1-based. Throws SourceError or ThrottledError. `priority` reaches the guard
   * unchanged: "interactive" for a reader-requested refresh (bypasses the daily
   * reserve), "background" for discovery, pending fetches and backfill.
   */
  listPage(
    page: number,
    pageSize: number,
    priority: "interactive" | "background",
  ): Promise<Listing>;
  fetchDetail(
    sourceArticleId: string,
    priority: "interactive" | "background",
  ): Promise<ArticleDetail>;
}

/**
 * rm-wenku's SourceError minus Throttled, as a closed union behind one Error
 * class. `kind` drives two decisions downstream: the guard's breaker (via
 * breakerKind, below — the ONE source→guard mapping) and crawl/worker.ts's
 * outcome mapping (all kinds → markFailed; the switch is exhaustive).
 */
export type SourceFailure =
  | { readonly kind: "http"; readonly status: number; readonly retryAfterSec: number | null } // 429, 5xx, other 4xx, 3xx
  | { readonly kind: "network"; readonly message: string } // DNS, TLS, reset, timeout
  | { readonly kind: "blocked"; readonly message: string } // WAF/captcha: 2xx non-JSON body
  | { readonly kind: "forbidden" } // 403 — the shape Frame 2's kill criterion watches for
  | { readonly kind: "notFound" } // 404 or `data: null`; a FAILURE, retried hourly (posts are hidden temporarily)
  | { readonly kind: "invalid"; readonly message: string } // JSON shape, empty title, no content, bad arguments
  | { readonly kind: "tooLarge"; readonly bytes: number };

export class SourceError extends Error {
  override readonly name = "SourceError";
  readonly failure: SourceFailure;
  constructor(failure: SourceFailure) {
    super(describe(failure));
    this.failure = failure;
  }
  static is(err: unknown, kind?: SourceFailure["kind"]): err is SourceError {
    return err instanceof SourceError && (kind === undefined || err.failure.kind === kind);
  }
}

/** One line per kind, ≤ 500 chars — it lands in articles.last_error / poll_runs.error. */
function describe(f: SourceFailure): string {
  switch (f.kind) {
    case "http":
      return `http ${f.status}${f.retryAfterSec !== null ? ` (retry-after ${f.retryAfterSec}s)` : ""}`;
    case "network":
      return `network error: ${f.message}`.slice(0, 500);
    case "blocked":
      return `blocked: ${f.message}`.slice(0, 500);
    case "forbidden":
      return "forbidden (http 403)";
    case "notFound":
      return "not found";
    case "invalid":
      return `invalid response: ${f.message}`.slice(0, 500);
    case "tooLarge":
      return `response too large (${f.bytes} bytes)`;
  }
}

/**
 * The ONE place a source failure becomes guard vocabulary. Kinds absent here
 * (notFound, invalid, tooLarge, other 4xx, 3xx) do not open the circuit: a
 * malformed post is our problem, not the server's. rm-wenku error.rs.
 */
export function breakerKind(err: SourceError): FailureKind | null {
  const f = err.failure;
  switch (f.kind) {
    case "http":
      if (f.status === 429) return "rateLimited";
      if (f.status >= 500) return "serverError";
      return null;
    case "forbidden":
      return "forbidden";
    case "network":
      return "network";
    case "blocked":
      return "blocked";
    default:
      return null;
  }
}
