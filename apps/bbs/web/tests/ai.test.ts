/** The AI panel's presentation rules, including the gate that hides an empty 规格 panel. */
import { describe, expect, it } from "vite-plus/test";

import type { ArticleAiDTO } from "../../src/api/dto.ts";
import { hasContent, maturityClass, sectionLabels } from "../src/lib/ai.ts";

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
} as unknown as NonNullable<ArticleAiDTO["kb"]>;

describe("maturityClass", () => {
  it("maps the statuses the model actually emits", () => {
    expect(maturityClass("上场验证")).toBe("pill ok");
    expect(maturityClass("测试通过")).toBe("pill info");
    expect(maturityClass("原型")).toBe("pill warn");
    expect(maturityClass("未完成")).toBe("pill warn");
    expect(maturityClass("未知")).toBe("pill");
  });

  it("hides anything it does not recognise", () => {
    expect(maturityClass("不适用")).toBe("");
    expect(maturityClass("")).toBe("");
  });
});

describe("sectionLabels", () => {
  it("adapts the labels per genre", () => {
    expect(sectionLabels("算法/库").package).toBe("仓库里有什么");
    expect(sectionLabels("工具/应用")).toMatchObject({ package: "获取与安装", caveats: "限制" });
    expect(sectionLabels("工程实践/复盘")).toMatchObject({
      appliesWhen: "照搬前提",
      caveats: "前提",
    });
    expect(sectionLabels("观点/经验").appliesWhen).toBe("适合谁读");
    expect(sectionLabels("公告/其他").appliesWhen).toBe("面向谁");
  });

  it("falls back to the defaults for an unknown genre", () => {
    expect(sectionLabels("水贴")).toEqual({
      package: "内容",
      appliesWhen: "适用",
      keyPoints: "要点",
      caveats: "注意",
    });
  });
});

describe("hasContent", () => {
  it("is false for no KB row and for an all-empty one", () => {
    expect(hasContent(null)).toBe(false);
    expect(hasContent(EMPTY_KB)).toBe(false);
  });

  it("is true as soon as any field carries something", () => {
    expect(hasContent({ ...EMPTY_KB, pitfalls: ["过热"] })).toBe(true);
    expect(hasContent({ ...EMPTY_KB, problem: "底盘打滑" })).toBe(true);
    expect(hasContent({ ...EMPTY_KB, domain: ["视觉"] })).toBe(true);
  });
});
