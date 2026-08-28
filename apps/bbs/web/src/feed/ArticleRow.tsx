import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { ArticleSummaryDTO } from "../../../src/api/dto.ts";
import { formatCount, formatDate } from "../lib/format.ts";
import { cleanExcerpt } from "../lib/title.ts";
import type { Segment } from "../search/snippet.ts";
import { Snippet } from "../search/Snippet.tsx";
import { leafOf } from "../url.ts";

/**
 * The row's content with no router in it, so `renderToString` can smoke it.
 * `headline` and `tags` are the two router-aware slots; without them the row
 * renders as plain text (what the tests assert over).
 */
/* Three lines; below `md` the eyebrow chips wrap under the headline and the
   meta line collapses to one clipped line. */
const ROW =
  "group relative flex flex-col gap-[3px] border-t border-line px-3.5 pt-[11px] pb-3 [contain-intrinsic-size:auto_96px] [content-visibility:auto] last:border-b hover:bg-surface hover:[content-visibility:visible] focus-within:bg-surface max-md:px-2";
const EYEBROW =
  "eyebrow mr-1.5 inline [&>*]:mr-1 [&>*]:inline-block [&>*]:whitespace-nowrap max-md:order-1 max-md:mr-0 max-md:flex max-md:flex-wrap max-md:gap-x-1.5 max-md:gap-y-1 max-md:[&>*]:mr-0";
const BOX =
  "rounded-[3px] border border-line bg-surface-2 px-[7px] text-xs leading-[19px] text-ink-2";
const TAG =
  "flex-none rounded-[3px] border border-line-2 px-1.5 font-body text-[11.5px] leading-[17px] whitespace-nowrap text-muted-foreground max-md:inline-block max-md:align-[-1px]";
const TAGS = "flex min-w-0 flex-[0_1_auto] gap-[5px] overflow-hidden max-md:ml-2.5 max-md:inline";

export function ArticleRowBody({
  article,
  snippet,
  headline,
  tags,
}: {
  article: ArticleSummaryDTO;
  snippet?: readonly Segment[] | undefined;
  headline?: ReactNode;
  tags?: ReactNode;
}) {
  // The AI one-liner is the best summary the library has; the crawled excerpt
  // (introduction, else the body's head) is the fallback chain behind it.
  const excerpt = cleanExcerpt(article.tldr ?? article.excerpt ?? article.introduction);
  const { season, team, labels, topic } = article.titleParts;
  const hasEyebrow = article.isPinned || season !== null || team !== null || labels.length > 0;
  // Empty segments are dropped, so a row with no links prints no `0 链接`.
  const facts = [
    formatDate(article.publishedAt),
    article.author ?? "",
    formatCount(article.bodyChars, "字"),
    formatCount(article.linkCount, "链接"),
    formatCount(article.imageCount, "图"),
  ].filter(Boolean);

  return (
    <article className={ROW}>
      <div className="min-w-0 leading-normal max-md:flex max-md:flex-col max-md:gap-1">
        {hasEyebrow && (
          <span className={EYEBROW}>
            {article.isPinned && <span className="font-mono text-xs text-accent">置顶</span>}
            {season && (
              <span className={`${BOX} font-mono tracking-[0.03em] tabular-nums`}>{season}</span>
            )}
            {team && <span className={BOX}>{team}</span>}
            {labels.map((label) => (
              <span className="font-mono text-[11.5px] text-muted-foreground" key={label}>
                {label}
              </span>
            ))}
          </span>
        )}
        <h2 className="m-0 inline font-body text-base leading-[inherit] font-medium">
          {headline ?? topic}
        </h2>
      </div>
      <div className="meta flex min-w-0 items-center gap-3.5 leading-relaxed max-md:block max-md:overflow-hidden max-md:text-ellipsis max-md:whitespace-nowrap">
        <span className="min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap max-md:inline">
          {facts.map((fact, index) => (
            <span
              className="not-first:before:mx-[7px] not-first:before:text-line-2 not-first:before:content-['·']"
              key={index}
            >
              {fact}
            </span>
          ))}
        </span>
        {tags !== undefined ? (
          tags
        ) : article.tags.length > 0 ? (
          <span className={TAGS}>
            {article.tags.map((tag) => (
              <span className={TAG} key={tag}>
                {leafOf(tag)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {excerpt && (
        <p className="mt-px max-w-[var(--measure)] overflow-hidden text-[13.5px] leading-[22px] text-ellipsis whitespace-nowrap text-ink-2 group-hover:overflow-visible group-hover:whitespace-normal">
          {excerpt}
        </p>
      )}
      {snippet && snippet.length > 0 && <Snippet segments={snippet} />}
    </article>
  );
}

/** One list row: eyebrow, headline, mono meta line, tag chips, excerpt and (on `/search`) a snippet. */
export function ArticleRow({
  article,
  snippet,
}: {
  article: ArticleSummaryDTO;
  snippet?: readonly Segment[] | undefined;
}) {
  return (
    <ArticleRowBody
      article={article}
      snippet={snippet}
      headline={
        <Link
          className="text-[inherit] hover:underline"
          to="/articles/$id"
          params={{ id: article.id }}
        >
          {article.titleParts.topic}
        </Link>
      }
      tags={
        article.tags.length > 0 ? (
          <span className={TAGS}>
            {article.tags.map((tag) => (
              // `group` is derived from `tag` by url.ts's transform; never sent here.
              <Link
                className={`${TAG} hover:border-accent hover:text-accent hover:no-underline`}
                key={tag}
                to="/"
                search={{ tag, scope: "all" }}
              >
                {leafOf(tag)}
              </Link>
            ))}
          </span>
        ) : null
      }
    />
  );
}
