/**
 * Smoke renders of the router-free halves of the feed and search rows. No DOM
 * library: `renderToString` catches a crashing component and pins the meta
 * line's rules. `.ts` with `createElement` because the vitest include pattern
 * is `web/tests/**\/*.test.ts` — a `.tsx` file would not be collected.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ArticleSummaryDTO } from "../../src/api/dto.ts";
import { ArticleRowBody } from "../src/feed/ArticleRow.tsx";
import { Snippet } from "../src/search/Snippet.tsx";
import type { Segment } from "../src/search/snippet.ts";
import { trimSegments } from "../src/search/snippet.ts";

const article: ArticleSummaryDTO = {
  id: "a1",
  sourceArticleId: "123",
  url: "https://bbs.robomaster.com/article/123",
  title: "[2024赛季][东林Ares]自瞄开源",
  titleParts: { season: "2024赛季", team: "东林Ares", labels: ["开源"], topic: "自瞄" },
  author: "阿雷斯",
  publishedAt: "2024-03-02T10:00:00.000Z",
  discoveredAt: "2024-03-03T10:00:00.000Z",
  fetchedAt: "2024-03-03T10:00:00.000Z",
  isPinned: true,
  tags: ["视觉/自瞄"],
  introduction: null,
  excerpt: "简介：一个自瞄方案",
  bodyChars: 820,
  linkCount: 2,
  imageCount: 0,
  tldr: null,
};

describe("ArticleRowBody", () => {
  const html = renderToString(createElement(ArticleRowBody, { article }));

  it("renders the topic, the eyebrow parts and the Shanghai date", () => {
    expect(html).toContain("自瞄");
    expect(html).toContain("2024赛季");
    expect(html).toContain("东林Ares");
    expect(html).toContain("置顶");
    expect(html).toContain("2024-03-02");
  });

  it("prints the non-zero counts and drops the zero ones", () => {
    expect(html).toContain("820 字");
    expect(html).toContain("2 链接");
    expect(html).not.toContain("图");
  });

  it("strips the corpus's 简介 label from the excerpt", () => {
    expect(html).toContain("一个自瞄方案");
    expect(html).not.toContain("简介：");
  });

  it("prefers the AI one-liner over the crawled excerpt", () => {
    const withTldr = renderToString(
      createElement(ArticleRowBody, { article: { ...article, tldr: "一句话总结" } }),
    );
    expect(withTldr).toContain("一句话总结");
    expect(withTldr).not.toContain("一个自瞄方案");
  });
});

describe("Snippet", () => {
  const segments: readonly Segment[] = [
    { text: "关于", hit: false },
    { text: "自瞄", hit: true },
    { text: "的", hit: false },
    { text: "底盘", hit: true },
  ];

  it("marks every hit segment and nothing else", () => {
    const html = renderToString(createElement(Snippet, { segments }));
    expect(html.match(/<mark>/g)).toHaveLength(2);
    expect(html).toContain("<mark>自瞄</mark>");
    expect(html).toContain("<mark>底盘</mark>");
  });

  it("keeps every hit after trimming, inside a row", () => {
    const long: readonly Segment[] = [
      { text: "前".repeat(400), hit: false },
      { text: "自瞄", hit: true },
      { text: "后".repeat(400), hit: false },
    ];
    const html = renderToString(
      createElement(ArticleRowBody, { article, snippet: trimSegments(long) }),
    );
    expect(html.match(/<mark>/g)).toHaveLength(1);
    expect(html).toContain("<mark>自瞄</mark>");
    expect(html).toContain("…");
  });
});
