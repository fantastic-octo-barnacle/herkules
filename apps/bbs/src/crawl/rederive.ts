/**
 * Derived columns follow the code, not the import. `corpus_versions` (one
 * row) records which RENDER / NORMALIZE / TITLE version produced what is on
 * disk; when the code's differ, every derived column is recomputed in batches
 * inside the migration phase (`bbs migrate`, and again at API boot — both are
 * no-ops once the row matches). `bbs rederive --force` is the same pass, forced.
 *
 * Contract with `bbs import`: import writes derived columns with the current
 * code but does not touch corpus_versions (untouched by decision), so the pass
 * after an import recomputes everything and finds it equal — done predicate 4
 * is `changed === 0` on the imported corpus. Rows are written only when a
 * value differs (updated_at untouched: a rederive is not an edit).
 */
import { asc, eq, gt } from "drizzle-orm";

import { RENDER_VERSION, renderArticleHtml } from "../content/render.ts";
import { TITLE_VERSION, splitTitle } from "../content/title.ts";
import type { BbsDb } from "../db/index.ts";
import { KB_SEARCH_FIELDS } from "../db/search/index.ts";
import { NORMALIZE_VERSION } from "../db/search/normalize.ts";
import { articleLinks, articleSearch, articles, corpusVersions, kbSearch } from "../db/schema.ts";
import { buildDocument } from "../import/derive.ts";

export interface Versions {
  readonly render: string;
  readonly normalize: string;
  readonly title: string;
}

export const CURRENT_VERSIONS: Versions = {
  render: RENDER_VERSION,
  normalize: NORMALIZE_VERSION,
  title: TITLE_VERSION,
};

export interface RederiveReport {
  readonly articles: number;
  readonly changed: {
    contentHtml: number;
    titleParts: number;
    articleDocument: number;
    kbDocument: number;
  };
  readonly from: Versions | null;
  readonly to: Versions;
  readonly skipped: boolean; // versions already equal and not forced
}

export interface RederiveOptions {
  readonly force?: boolean;
  readonly batchSize?: number; // 500
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

function sameArray(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Per batch, one transaction:
 *   articles: content_html = renderArticleHtml(format, raw, canonical_url, title, links by position); title_* = splitTitle(title)
 *   article_search.document = buildDocument([title, author, tags, introduction, body_text]) from the search row's own columns
 *   kb_search.document likewise (NORMALIZE only)
 * Which columns are recomputed follows which versions differ (all three when forced). The versions row
 * is upserted LAST, in its own statement, so a crash mid-pass reruns the pass next boot.
 */
export async function rederive(db: BbsDb, options: RederiveOptions = {}): Promise<RederiveReport> {
  const batchSize = options.batchSize ?? 500;
  const log = options.log ?? (() => undefined);
  const to = CURRENT_VERSIONS;
  const stored = (await db.select().from(corpusVersions).where(eq(corpusVersions.id, 1)))[0];
  const from: Versions | null = stored
    ? {
        render: stored.renderVersion,
        normalize: stored.normalizeVersion,
        title: stored.titleVersion,
      }
    : null;
  const changed = { contentHtml: 0, titleParts: 0, articleDocument: 0, kbDocument: 0 };
  const force = options.force ?? false;
  const doRender = force || from?.render !== to.render;
  const doTitle = force || from?.title !== to.title;
  const doDocuments = force || from?.normalize !== to.normalize;
  let count = 0;

  if (!doRender && !doTitle && !doDocuments) {
    return { articles: 0, changed, from, to, skipped: true };
  }
  log(
    `rederive: ${from ? `${from.render}/${from.normalize}/${from.title}` : "unknown"} → ${to.render}/${to.normalize}/${to.title}${force ? " (forced)" : ""}`,
  );

  if (doRender || doTitle) {
    let after = "";
    for (;;) {
      const batch = await db
        .select({
          id: articles.id,
          canonicalUrl: articles.canonicalUrl,
          title: articles.title,
          contentFormat: articles.contentFormat,
          contentRaw: articles.contentRaw,
          contentHtml: articles.contentHtml,
          titleSeason: articles.titleSeason,
          titleTeam: articles.titleTeam,
          titleTopic: articles.titleTopic,
          titleLabels: articles.titleLabels,
        })
        .from(articles)
        .where(gt(articles.id, after))
        .orderBy(asc(articles.id))
        .limit(batchSize);
      if (batch.length === 0) break;
      count += batch.length;
      await db.transaction(async (tx) => {
        for (const row of batch) {
          const set: Partial<typeof articles.$inferInsert> = {};
          if (doRender && row.contentRaw !== null) {
            const links = await tx
              .select({ url: articleLinks.url, label: articleLinks.label })
              .from(articleLinks)
              .where(eq(articleLinks.articleId, row.id))
              .orderBy(asc(articleLinks.position));
            const html = renderArticleHtml({
              format: row.contentFormat === "markdown" ? "markdown" : "html",
              raw: row.contentRaw,
              baseUrl: row.canonicalUrl,
              title: row.title,
              links,
            });
            if (html !== row.contentHtml) {
              set.contentHtml = html;
              changed.contentHtml += 1;
            }
          }
          if (doTitle) {
            const parts = splitTitle(row.title);
            if (
              parts.season !== row.titleSeason ||
              parts.team !== row.titleTeam ||
              parts.topic !== row.titleTopic ||
              !sameArray(row.titleLabels, parts.labels)
            ) {
              set.titleSeason = parts.season;
              set.titleTeam = parts.team;
              set.titleTopic = parts.topic;
              set.titleLabels = [...parts.labels];
              changed.titleParts += 1;
            }
          }
          if (Object.keys(set).length > 0) {
            await tx.update(articles).set(set).where(eq(articles.id, row.id));
          }
        }
      });
      after = batch[batch.length - 1]!.id;
    }
  }

  if (doDocuments) {
    let after = "";
    for (;;) {
      const batch = await db
        .select()
        .from(articleSearch)
        .where(gt(articleSearch.articleId, after))
        .orderBy(asc(articleSearch.articleId))
        .limit(batchSize);
      if (batch.length === 0) break;
      await db.transaction(async (tx) => {
        for (const row of batch) {
          const document = buildDocument([
            row.title,
            row.author,
            row.tags,
            row.introduction,
            row.bodyText,
          ]);
          if (document !== row.document) {
            await tx
              .update(articleSearch)
              .set({ document })
              .where(eq(articleSearch.articleId, row.articleId));
            changed.articleDocument += 1;
          }
        }
      });
      after = batch[batch.length - 1]!.articleId;
    }
    after = "";
    for (;;) {
      const batch = await db
        .select()
        .from(kbSearch)
        .where(gt(kbSearch.articleId, after))
        .orderBy(asc(kbSearch.articleId))
        .limit(batchSize);
      if (batch.length === 0) break;
      await db.transaction(async (tx) => {
        for (const row of batch) {
          const document = buildDocument(KB_SEARCH_FIELDS.map((f) => row[f]));
          if (document !== row.document) {
            await tx
              .update(kbSearch)
              .set({ document })
              .where(eq(kbSearch.articleId, row.articleId));
            changed.kbDocument += 1;
          }
        }
      });
      after = batch[batch.length - 1]!.articleId;
    }
  }

  const now = (options.now ?? (() => new Date()))();
  await db
    .insert(corpusVersions)
    .values({
      id: 1,
      renderVersion: to.render,
      normalizeVersion: to.normalize,
      titleVersion: to.title,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: corpusVersions.id,
      set: {
        renderVersion: to.render,
        normalizeVersion: to.normalize,
        titleVersion: to.title,
        updatedAt: now,
      },
    });
  log(
    `rederive: ${count} articles; changed content_html ${changed.contentHtml}, title parts ${changed.titleParts}, article documents ${changed.articleDocument}, kb documents ${changed.kbDocument}`,
  );
  return { articles: count, changed, from, to, skipped: false };
}
