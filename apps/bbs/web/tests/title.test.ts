/** Title parts come parsed from the server; only the excerpt still needs cleaning. */
import { describe, expect, it } from "vite-plus/test";

import { cleanExcerpt } from "../src/lib/title.ts";

describe("cleanExcerpt", () => {
  it("drops the leading 简介 label in both punctuations", () => {
    expect(cleanExcerpt("简介 本文档为飞镖系统开源。")).toBe("本文档为飞镖系统开源。");
    expect(cleanExcerpt("简介：正文")).toBe("正文");
    expect(cleanExcerpt("简介:正文")).toBe("正文");
  });

  it("leaves other text alone and returns null for nothing", () => {
    expect(cleanExcerpt("介绍一下底盘")).toBe("介绍一下底盘");
    expect(cleanExcerpt("  ")).toBeNull();
    expect(cleanExcerpt(null)).toBeNull();
  });
});
