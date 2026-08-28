/** The MCP presenters: Shanghai dates, flat hits with bracketed snippets, surrogate-safe paging. */
import { describe, expect, it } from "vite-plus/test";

import type { ArticleId, ArticleSummary, KbCard, SearchHit } from "../src/library/types.ts";
import {
  articleHit,
  kbCardOut,
  renderSnippet,
  shanghaiDate,
  sliceContent,
} from "../src/mcp/present.ts";

const ID = "01J0000000000000000000000A" as ArticleId;

const summary: ArticleSummary = {
  id: ID,
  sourceArticleId: "1",
  url: "https://bbs.robomaster.com/article/1",
  title: "【RM2026-开源】步兵底盘",
  titleParts: { season: "RM2026", team: null, labels: ["开源"], topic: "步兵底盘" },
  author: "Kaiser",
  publishedAt: new Date("2026-03-01T17:30:00.000Z"), // 01:30 next day in Shanghai
  discoveredAt: new Date("2026-03-05T00:00:00.000Z"),
  fetchedAt: null,
  isPinned: false,
  tags: ["硬件/机器人硬件"],
  introduction: null,
  excerpt: "大学步兵开源底盘",
  bodyChars: 1234,
  linkCount: 2,
  imageCount: 1,
  tldr: "一句话",
};

describe("shanghaiDate", () => {
  it("renders the calendar day in Asia/Shanghai, not UTC", () => {
    expect(shanghaiDate(new Date("2026-03-01T17:30:00.000Z"))).toBe("2026-03-02");
    expect(shanghaiDate(new Date("2026-03-01T15:59:59.000Z"))).toBe("2026-03-01");
  });
});

describe("articleHit", () => {
  it("is flat, dated in Shanghai, and omits empty optionals", () => {
    const hit = articleHit(summary);
    expect(hit).toEqual({
      id: ID,
      title: summary.title,
      author: "Kaiser",
      date: "2026-03-02",
      url: summary.url,
      tags: ["硬件/机器人硬件"],
      excerpt: "大学步兵开源底盘",
      tldr: "一句话",
      score: 0,
      bodyChars: 1234,
    });
    expect("titleParts" in hit).toBe(false);
    const anon = articleHit({
      ...summary,
      author: null,
      excerpt: null,
      tldr: null,
      publishedAt: null,
    });
    expect(anon.date).toBe("2026-03-05");
    expect("author" in anon).toBe(false);
    expect("snippet" in anon).toBe(false);
  });
  it("joins snippet segments with the FTS5 markers for a search hit", () => {
    const hit: SearchHit = {
      ...summary,
      score: 3.5,
      snippet: [
        { text: "…经验上 ", hit: false },
        { text: "PID", hit: true },
        { text: " ", hit: false },
        { text: "整定", hit: true },
        { text: " 先调 P…", hit: false },
      ],
    };
    expect(articleHit(hit).snippet).toBe("…经验上 [PID] [整定] 先调 P…");
    expect(articleHit(hit).score).toBe(3.5);
    expect(articleHit({ ...hit, snippet: null }).snippet).toBeUndefined();
    expect(renderSnippet([])).toBe("");
  });
});

describe("kbCardOut", () => {
  it("caps entities at 8 and pitfalls at 3", () => {
    const card: KbCard = {
      articleId: ID,
      title: "t",
      author: null,
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      tldr: "tl",
      genre: "教程",
      maturity: "已验证",
      problem: null,
      domain: ["控制"],
      robotTypes: ["步兵"],
      entities: Array.from({ length: 10 }, (_, i) => `e${i}`),
      pitfalls: ["a", "b", "c", "d"],
    };
    const out = kbCardOut(card);
    expect(out).toMatchObject({ id: ID, date: "2026-01-01", genre: "教程", domain: ["控制"] });
    expect(out.entities).toHaveLength(8);
    expect(out.pitfalls).toEqual(["a", "b", "c"]);
    expect("author" in out).toBe(false);
    expect("problem" in out).toBe(false);
  });
});

describe("sliceContent", () => {
  it("pages by characters and reports nextOffset only while more remains", () => {
    const body = "abcdefghij";
    expect(sliceContent(body, 0, 4)).toEqual({
      text: "abcd",
      offset: 0,
      nextOffset: 4,
      totalChars: 10,
    });
    expect(sliceContent(body, 4, 4)).toEqual({
      text: "efgh",
      offset: 4,
      nextOffset: 8,
      totalChars: 10,
    });
    expect(sliceContent(body, 8, 4)).toEqual({ text: "ij", offset: 8, totalChars: 10 });
    expect(sliceContent(body, 50, 4)).toEqual({ text: "", offset: 10, totalChars: 10 });
  });
  it("never splits a surrogate pair at either edge", () => {
    const body = "a😀b😀c"; // 😀 is two code units
    const first = sliceContent(body, 0, 2); // would cut inside the first emoji
    expect(first.text).toBe("a");
    expect(first.nextOffset).toBe(1);
    const second = sliceContent(body, 2, 10); // offset lands on the low surrogate
    expect(second.offset).toBe(3);
    expect(second.text).toBe("b😀c");
    for (const s of [first.text, second.text]) {
      expect(/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
    }
  });
});
