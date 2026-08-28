/**
 * Link targets, forwards only.
 *
 * Frame 2 asks for "the back-fill of `target_article_id` on existing links that
 * point at the new article". An inverse SQL rule (`url = $canonical OR url ~
 * '/article/<id>'`) would put URL matching in a second place — exactly the
 * divergence Frame 2's second kill criterion watches for. So: ONLY
 * `import/derive.ts resolveLinkTarget` matches a URL to an article, on both
 * write paths, and the back-fill runs that same forward function over the links
 * that are currently unresolved.
 *
 * The index it needs is rebuilt from ONE query per write that needs it
 * (`SELECT id, canonical_url, source_article_id FROM articles WHERE source_id = $1`,
 * ~1 000 rows, ~1 ms). At ≤ 6 detail writes a minute that is cheaper to reason
 * about than a cache with boot state and a merge point.
 */
import { eq, inArray, isNull } from "drizzle-orm";

import type { BbsDb } from "../db/index.ts";
import { articleLinks, articles } from "../db/schema.ts";
import type { LinkTargetIndex } from "../import/derive.ts";
import { resolveLinkTarget } from "../import/derive.ts";

/** Inside the caller's transaction. Sees rows this transaction inserted (the new article itself included). */
export async function loadLinkTargets(tx: BbsDb, sourceId: string): Promise<LinkTargetIndex> {
  const rows = await tx
    .select({
      id: articles.id,
      canonicalUrl: articles.canonicalUrl,
      sourceArticleId: articles.sourceArticleId,
    })
    .from(articles)
    .where(eq(articles.sourceId, sourceId));
  const byCanonicalUrl = new Map<string, string>();
  const bySourceArticleId = new Map<string, string>();
  for (const r of rows) {
    byCanonicalUrl.set(r.canonicalUrl, r.id);
    bySourceArticleId.set(r.sourceArticleId, r.id);
  }
  return { byCanonicalUrl, bySourceArticleId };
}

/**
 * The back-fill, inside the same transaction as a write that INSERTED article
 * rows (discovery, backfill page). Skipped by the caller when nothing was new.
 *
 *   SELECT id, url FROM article_links WHERE target_article_id IS NULL
 *   for each: target = resolveLinkTarget(index, url)
 *   UPDATE article_links SET target_article_id = $t WHERE id = ANY($ids)   -- grouped by target
 *
 * Idempotent: a resolved link leaves the candidate set; a link whose target is
 * deleted returns to NULL (ON DELETE SET NULL) and is reconsidered. ~3 000 rows,
 * sequential scan, milliseconds; if it ever matters the fix is a partial index
 * `WHERE target_article_id IS NULL`, never a second rule. Returns rows updated.
 */
export async function resolveDanglingLinks(tx: BbsDb, index: LinkTargetIndex): Promise<number> {
  const dangling = await tx
    .select({ id: articleLinks.id, url: articleLinks.url })
    .from(articleLinks)
    .where(isNull(articleLinks.targetArticleId));
  const byTarget = new Map<string, string[]>();
  for (const link of dangling) {
    const target = resolveLinkTarget(index, link.url);
    if (!target) continue;
    const ids = byTarget.get(target) ?? [];
    ids.push(link.id);
    byTarget.set(target, ids);
  }
  let updated = 0;
  for (const [target, ids] of byTarget) {
    await tx
      .update(articleLinks)
      .set({ targetArticleId: target })
      .where(inArray(articleLinks.id, ids));
    updated += ids.length;
  }
  return updated;
}
