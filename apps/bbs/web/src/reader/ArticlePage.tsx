import { Badge } from "@herkules/ui/components/badge";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import type { ArticleDTO } from "../../../src/api/dto.ts";
import { hasContent } from "../lib/ai.ts";
import { formatCount, formatDate } from "../lib/format.ts";
import { articleRoute } from "../routes.tsx";
import { NotFound } from "../shell/NotFound.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";
import { groupOf } from "../url.ts";
import { AiOverview } from "./AiOverview.tsx";
import { KbPanel } from "./KbPanel.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { Prose } from "./Prose.tsx";
import { prepareProse, type Heading } from "./prose.ts";
import { ReaderSidebar, type SidebarSection } from "./ReaderSidebar.tsx";
import "./reader.css";
import { Resources } from "./Resources.tsx";
import { Toc, useActiveHeading } from "./Toc.tsx";

/** A stable empty array: `useActiveHeading`'s effect keys off identity. */
const NO_HEADINGS: readonly Heading[] = [];

/** A season / team box in the eyebrow row. */
const BOX =
  "rounded-[3px] border border-line bg-surface px-2 text-[12.5px] leading-[22px] whitespace-nowrap text-ink-2";

export function ArticlePage() {
  const { id } = articleRoute.useParams();
  const { q } = articleRoute.useRouteContext();
  const { data: article } = useSuspenseQuery(q.article(id)); // the loader already ensured it
  const { data: ai, isError: aiFailed } = useQuery(q.ai(id)); // prefetched by the loader on real navigations
  const prose = useMemo(() => (article ? prepareProse(article) : null), [article]);
  // The server injects `title` (src/library/articles.ts getHead), not `titleParts.topic`;
  // the same string here is what keeps the first paint's <title> from flickering.
  usePageTitle(article?.title ?? null);

  const headings = prose?.headings ?? NO_HEADINGS;
  const activeId = useActiveHeading(headings);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  const navigate = useNavigate();
  const onNavigate = useCallback(
    (path: string) => {
      // `prepareProse` only ever writes `/articles/{id}` hrefs, so the tail is the id.
      void navigate({ to: "/articles/$id", params: { id: path.slice("/articles/".length) } });
    },
    [navigate],
  );
  const onImage = useCallback((src: string, alt: string) => setImage({ src, alt }), []);

  if (!article || !prose) return <NotFound what="article" />; // null is data: the server said 404

  const { titleParts } = article;
  const deck = prose.deck && prose.deck !== titleParts.topic ? prose.deck : null;
  const hasEyebrow = Boolean(titleParts.season ?? titleParts.team) || titleParts.labels.length > 0;

  const sections: SidebarSection[] = [];
  if (headings.length >= 2) {
    sections.push({
      id: "toc",
      label: "目录",
      node: <Toc headings={headings} activeId={activeId} />,
    });
  }
  // `undefined` is "the AI read has not answered yet" (it is a plain query, not
  // a suspense one); `null` is the server's 404, which is an answer.
  if (ai !== undefined || aiFailed) {
    sections.push({
      id: "ai",
      label: "AI 概览",
      node: ai ? (
        <AiOverview ai={ai} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {aiFailed ? "AI 概览加载失败。" : "无 AI 概览。"}
        </p>
      ),
    });
  }
  if (ai?.status === "ready" && ai.kb && hasContent(ai.kb)) {
    sections.push({ id: "kb", label: "规格", node: <KbPanel kb={ai.kb} /> });
  }
  if (article.links.length > 0 || article.images.length > 0) {
    sections.push({
      id: "resources",
      label: "资源",
      node: <Resources links={article.links} images={article.images} />,
    });
  }

  return (
    <div className="page [--measure:1240px] max-lg:pb-24 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-14">
      <article className="flex min-w-0 max-w-[780px] flex-col">
        {hasEyebrow && (
          <div className="eyebrow flex flex-wrap items-center gap-1.5">
            {titleParts.season && (
              <span className={`${BOX} font-mono tracking-[0.03em] tabular-nums`}>
                {titleParts.season}
              </span>
            )}
            {titleParts.team && <span className={BOX}>{titleParts.team}</span>}
            {titleParts.labels.map((label) => (
              <span
                className="font-mono text-[11.5px] tracking-[0.02em] whitespace-nowrap text-muted-foreground"
                key={label}
              >
                {label}
              </span>
            ))}
          </div>
        )}
        <h1 className="page-title mt-2 mb-2.5">{titleParts.topic}</h1>
        {deck && <p className="-mt-0.5 mb-2.5 text-[17px] leading-relaxed text-ink-2">{deck}</p>}
        <MetaStrip article={article} />

        <Prose html={prose.html} onNavigate={onNavigate} onImage={onImage} />
        <Lightbox src={image?.src ?? null} alt={image?.alt ?? ""} onClose={() => setImage(null)} />

        <div className="meta mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-5">
          <span>正文与图片来自原文，版权归原作者所有；本站仅作检索与阅读。</span>
          <a href={article.url} target="_blank" rel="noopener noreferrer">
            原文链接 ↗
          </a>
        </div>
      </article>

      <ReaderSidebar sections={sections} />
    </div>
  );
}

/** One mono line under the headline — date · author · counts · 查看原文 — with the tag chips trailing it. */
function MetaStrip({ article }: { article: ArticleDTO }) {
  const items = [
    formatDate(article.publishedAt),
    article.author,
    formatCount(article.bodyChars, "字"),
    formatCount(article.linkCount, "链接"),
    formatCount(article.imageCount, "图"),
  ].filter(Boolean);
  return (
    <div className="mt-0.5 mb-7 flex flex-wrap items-center gap-x-[18px] gap-y-2 border-b border-line-2 pb-3.5 max-md:gap-x-3 max-md:gap-y-1.5">
      <div className="meta flex flex-wrap items-center [&>*+*]:before:px-2 [&>*+*]:before:opacity-60 [&>*+*]:before:content-['·']">
        {items.map((item) => (
          <span key={item}>{item}</span>
        ))}
        <a className="text-accent" href={article.url} target="_blank" rel="noopener noreferrer">
          查看原文 ↗
        </a>
      </div>
      {article.tags.length > 0 && (
        <div className="flex flex-wrap gap-[5px]">
          {article.tags.map((tag) => (
            <Badge variant="outline" className="font-mono" key={tag} asChild>
              <Link to="/" search={{ tag, scope: "all" }}>
                <b>{groupOf(tag)}</b>
                {tag.includes("/") && ` / ${tag.slice(tag.indexOf("/") + 1)}`}
              </Link>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
