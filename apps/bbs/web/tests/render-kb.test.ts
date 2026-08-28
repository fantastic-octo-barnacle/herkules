/**
 * Smoke renders of the KB screens' router-free leaves. `vite.config.ts` includes
 * `web/tests/**\/*.test.ts` only, so this file is `.ts` and builds elements with
 * `createElement` instead of JSX.
 */
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { KbBrowseDTO } from "../../src/api/dto.ts";
import { EntitySectionsView } from "../src/kb/EntitySectionsView.tsx";
import type { ArticleRef } from "../src/kb/EntitySectionsView.tsx";
import { KbCardBody } from "../src/kb/KbCard.tsx";
import type { EntitySections } from "../src/kb/model.ts";

type Card = KbBrowseDTO["cards"][number];

function card(over: Partial<Card> = {}): Card {
  return {
    articleId: "01J0000000000000000000000A",
    title: "【RM2026·步兵】底盘功率控制",
    author: "老王",
    publishedAt: "2026-03-04T02:00:00.000Z",
    tldr: "用超级电容做功率缓冲。",
    genre: "复盘",
    maturity: "上场验证",
    problem: "功率限制下加速不足。",
    domain: ["电控"],
    robotTypes: ["步兵"],
    entities: ["超级电容"],
    pitfalls: [],
    ...over,
  } as unknown as Card;
}

const EMPTY: EntitySections = {
  comparison: [],
  otherParameters: [],
  asComponent: [],
  decisions: [],
  pitfalls: [],
};

/** In the app this is a `<Link>`; the leaf takes it as a prop so tests need no router. */
const plainRef = (ref: ArticleRef) => ref.title;

describe("KbCardBody", () => {
  it("renders the meta line, the tldr and the problem", () => {
    const html = renderToString(h(KbCardBody, { card: card() }));
    expect(html).toContain("老王 · 2026-03-04");
    expect(html).toContain("用超级电容做功率缓冲。");
    // React separates adjacent text nodes with a comment, so the label and the
    // value are asserted apart.
    expect(html).toContain("问题：");
    expect(html).toContain("功率限制下加速不足。");
    expect(html).toContain("上场验证");
  });

  it("contains no links — every URL on a card is rendered by the page", () => {
    expect(renderToString(h(KbCardBody, { card: card() }))).not.toContain("<a");
  });

  it("drops a problem that only repeats the tldr, and a missing author's column", () => {
    const html = renderToString(
      h(KbCardBody, { card: card({ author: null, problem: "用超级电容做功率缓冲。" }) }),
    );
    expect(html).not.toContain("问题：");
    expect(html).toContain("2026-03-04");
    expect(html).not.toContain(" · ");
  });

  it("shows no maturity badge for a status the vocabulary does not know", () => {
    const html = renderToString(h(KbCardBody, { card: card({ maturity: "随便写的" }) }));
    expect(html).not.toContain("随便写的");
  });
});

describe("EntitySectionsView", () => {
  it("renders 参数对比 rows with unit, context and the article reference", () => {
    const sections: EntitySections = {
      ...EMPTY,
      comparison: [
        {
          articleId: "A1",
          title: "底盘功率控制",
          name: "电容容量",
          value: "16",
          unit: "F",
          context: "常温",
        },
        {
          articleId: "A2",
          title: "另一篇",
          name: "峰值电流",
          value: "40",
          unit: null,
          context: null,
        },
      ],
    };
    const html = renderToString(h(EntitySectionsView, { sections, renderArticle: plainRef }));
    expect(html).toContain("参数对比");
    expect(html).toContain("电容容量");
    expect(html).toContain("16 F");
    expect(html).toContain("常温");
    expect(html).toContain("底盘功率控制");
    // No unit: the value stands alone rather than gaining a trailing space.
    expect(html).toContain(">40<");
    expect(html.match(/<tr/g)).toHaveLength(3); // header + two rows
  });

  it("omits every empty section", () => {
    const html = renderToString(
      h(EntitySectionsView, { sections: EMPTY, renderArticle: plainRef }),
    );
    for (const heading of ["参数对比", "其他参数", "作为组件", "相关取舍", "相关踩坑"]) {
      expect(html).not.toContain(heading);
    }
  });

  it("renders only the sections that have rows", () => {
    const sections: EntitySections = {
      ...EMPTY,
      pitfalls: [{ articleId: "A1", title: "底盘功率控制", pitfall: "电容放电时会掉压。" }],
    };
    const html = renderToString(h(EntitySectionsView, { sections, renderArticle: plainRef }));
    expect(html).toContain("相关踩坑");
    expect(html).toContain("电容放电时会掉压。");
    expect(html).not.toContain("参数对比");
    expect(html).not.toContain("作为组件");
  });
});
