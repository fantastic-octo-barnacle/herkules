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
    <article className="feed-row">
      <div className="feed-row-head">
        {hasEyebrow && (
          <span className="eyebrow feed-eyebrow">
            {article.isPinned && <span className="feed-pin">置顶</span>}
            {season && <span className="feed-season">{season}</span>}
            {team && <span className="feed-team">{team}</span>}
            {labels.map((label) => (
              <span className="feed-label" key={label}>
                {label}
              </span>
            ))}
          </span>
        )}
        <h2 className="feed-headline">{headline ?? topic}</h2>
      </div>
      <div className="meta feed-row-meta">
        <span className="feed-facts">
          {facts.map((fact, index) => (
            <span key={index}>{fact}</span>
          ))}
        </span>
        {tags !== undefined ? (
          tags
        ) : article.tags.length > 0 ? (
          <span className="feed-tags">
            {article.tags.map((tag) => (
              <span className="feed-tag" key={tag}>
                {leafOf(tag)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {excerpt && <p className="feed-excerpt">{excerpt}</p>}
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
        <Link className="feed-headline-link" to="/articles/$id" params={{ id: article.id }}>
          {article.titleParts.topic}
        </Link>
      }
      tags={
        article.tags.length > 0 ? (
          <span className="feed-tags">
            {article.tags.map((tag) => (
              // `group` is derived from `tag` by url.ts's transform; never sent here.
              <Link className="feed-tag" key={tag} to="/" search={{ tag, scope: "all" }}>
                {leafOf(tag)}
              </Link>
            ))}
          </span>
        ) : null
      }
    />
  );
}
