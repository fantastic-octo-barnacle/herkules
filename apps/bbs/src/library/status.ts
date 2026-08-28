/**
 * Library counts for `/api/status`, the Status page and MCP `library_status`.
 *
 * rm-wenku's status was a live crawler/AI console over SSE. None of that has a
 * data source here — the crawler and the generator run on the old box — so what
 * is left is genuinely static between imports: counts plus "when did this
 * corpus arrive". ONE query of scalar subselects:
 *   total/fetched/skipped articles, tags, images, links, ai ready, ai missing
 *   (fetched with no article_ai row), entities with article_count > 0,
 *   max(poll_runs.started_at), max(sources.backfill_completed_at), the sources
 *   row's name/site_url, max(import_runs.finished_at) WHERE ok AND NOT noop.
 * Deliberately NOT reported: cost totals and the AI budget (`ai_usage.cost_usd`
 * is a frozen historical number that would read as live spend).
 */
import type { LibraryDeps } from "./index.ts";
import type { LibraryStatus } from "./types.ts";

export function getStatus(deps: LibraryDeps): Promise<LibraryStatus> {
  void deps;
  throw new Error("not implemented");
}
