/**
 * Smoke renders of the reader's leaves. `.ts` with `createElement` rather than
 * `.tsx`: the package's `test.include` is `web/tests/**\/*.test.ts`.
 *
 * Only the router-free leaves are here. `ArticlePage`, `Prose`, `ReaderSidebar`
 * and `KbPanel`'s entity chips need a router or a DOM and are covered by
 * `contract.test.ts` / manual review instead (see the report).
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ArticleAiDTO, ArticleDTO } from "../../src/api/dto.ts";
import { AiOverview } from "../src/reader/AiOverview.tsx";
import { KbPanelBody } from "../src/reader/KbPanel.tsx";
import { Lightbox } from "../src/reader/Lightbox.tsx";
import type { Heading } from "../src/reader/prose.ts";
import { Resources } from "../src/reader/Resources.tsx";
import { Toc } from "../src/reader/Toc.tsx";

const EMPTY_KB = {
  domain: [],
  robotTypes: [],
  problem: null,
  approach: null,
  components: [],
  parameters: [],
  interfaces: [],
  toolchain: [],
  designDecisions: [],
  pitfalls: [],
  cost: null,
  references: [],
  entities: [],
  claims: [],
  openQuestions: [],
  searchKeywords: [],
} satisfies NonNullable<ArticleAiDTO["kb"]>;

const OVERVIEW = {
  genre: "算法/库",
  tldr: "一句话结论",
  summary: "这是摘要。",
  keyPoints: ["要点一", "要点二"],
  appliesWhen: "有 NUC 的步兵",
  package: ["源码", "标定工具"],
  maturity: { status: "上场验证", evidence: "全国赛用过" },
  caveats: ["相机需要重新标定"],
  readingGuide: "先看第三节",
  extras: {
    quickStart: ["克隆仓库"],
    portingChecklist: [],
    compat: [],
    lessons: [],
    thesis: null,
    arguments: [],
    actions: [],
  },
  faq: [{ question: "要多少算力？", answer: "NUC 够。", source: "正文" }],
} satisfies NonNullable<ArticleAiDTO["overview"]>;

function ai(patch: Partial<ArticleAiDTO>): ArticleAiDTO {
  return {
    articleId: "01ARTICLE",
    status: "pending",
    overview: null,
    kb: null,
    images: [],
    model: null,
    generatedAt: null,
    error: null,
    ...patch,
  } as ArticleAiDTO;
}

describe("AiOverview", () => {
  it("says the overview is not generated, and does not invent one", () => {
    const html = renderToString(createElement(AiOverview, { ai: ai({ status: "pending" }) }));
    expect(html).toContain("尚未生成");
    expect(html).not.toContain("要点");
  });

  it("shows the generator's own error line", () => {
    const html = renderToString(
      createElement(AiOverview, { ai: ai({ status: "failed", error: "上游超时" }) }),
    );
    expect(html).toContain("概览生成失败");
    expect(html).toContain("上游超时");
  });

  it("renders the ready overview with genre-adapted labels", () => {
    const html = renderToString(
      createElement(AiOverview, {
        ai: ai({ status: "ready", overview: OVERVIEW, model: "claude" }),
      }),
    );
    expect(html).toContain("一句话结论");
    expect(html).toContain("要点一");
    expect(html).toContain("仓库里有什么"); // sectionLabels("算法/库").package
    expect(html).toContain("上场验证");
    expect(html).toContain("常见问题");
    expect(html).toContain("claude");
  });

  it("treats a ready row with no overview as not generated", () => {
    const html = renderToString(createElement(AiOverview, { ai: ai({ status: "ready" }) }));
    expect(html).toContain("尚未生成");
  });
});

describe("KbPanelBody", () => {
  it("renders only the sections that have rows", () => {
    const html = renderToString(
      createElement(KbPanelBody, {
        kb: {
          ...EMPTY_KB,
          problem: "识别距离不够",
          parameters: [{ name: "曝光", value: "2", unit: "ms", context: "室内", source: "3.1" }],
          pitfalls: ["白平衡会漂"],
        },
      }),
    );
    expect(html).toContain("识别距离不够");
    expect(html).toContain("曝光");
    expect(html).toContain(" ms"); // value and unit are one cell
    expect(html).toContain("白平衡会漂");
    expect(html).not.toContain("组件");
    expect(html).not.toContain("参考");
  });
});

describe("Resources", () => {
  it("renders external links with rel=noopener and lists image captions", () => {
    const links = [
      {
        url: "https://github.com/a/b",
        kind: "repository",
        label: null,
        articleId: null,
        position: 0,
      },
    ] as unknown as ArticleDTO["links"];
    const images = [{ url: "https://cdn/1.png", alt: "云台", position: 0 }] as ArticleDTO["images"];
    const html = renderToString(createElement(Resources, { links, images }));
    expect(html).toContain("仓库"); // linkKindText("repository")
    expect(html).toContain("github.com/a/b");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("云台");
  });

  it("renders nothing when the article has neither links nor images", () => {
    expect(renderToString(createElement(Resources, { links: [], images: [] }))).toBe("");
  });
});

describe("Toc", () => {
  it("anchors each heading and marks the active one", () => {
    const headings: readonly Heading[] = [
      { id: "sec-1", level: 2, text: "背景" },
      { id: "sec-2", level: 3, text: "标定" },
    ];
    const html = renderToString(createElement(Toc, { headings, activeId: "sec-2" }));
    expect(html).toContain('href="#sec-1"');
    expect(html).toContain('data-level="3"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("背景");
  });
});

describe("Lightbox", () => {
  it("renders nothing until an image is picked", () => {
    // A closed Radix dialog mounts no content at all (the open one lives in a portal).
    const html = renderToString(createElement(Lightbox, { src: null, alt: "", onClose: () => {} }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("图片");
  });
});
