/**
 * The URL boundary. `location.search` is untrusted input; these are the only
 * parsers in the SPA, so their defaults ARE the product's defaults.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  accountSearch,
  feedSearch,
  groupOf,
  kbSearch,
  leafOf,
  rankedSearch,
  stripDerived,
} from "../src/url.ts";

describe("groupOf", () => {
  it("takes the segment before the first slash, mirroring article_tags.group_name", () => {
    expect(groupOf("硬件/机器人硬件")).toBe("硬件");
    expect(groupOf("算法/控制")).toBe("算法");
    // split_part(tag, '/', 1) on a tag with two slashes keeps only the first segment.
    expect(groupOf("a/b/c")).toBe("a");
  });

  it("returns a tag without a slash unchanged", () => {
    expect(groupOf("公告")).toBe("公告");
    expect(groupOf("")).toBe("");
  });
});

describe("feedSearch", () => {
  it("defaults scope to all and leaves the rest undefined", () => {
    expect(feedSearch.parse({})).toEqual({
      q: undefined,
      scope: "all",
      tag: undefined,
      group: undefined,
    });
  });

  it("defaults group from tag, in one transform", () => {
    expect(feedSearch.parse({ tag: "硬件/机器人硬件" })).toMatchObject({
      tag: "硬件/机器人硬件",
      group: "硬件",
    });
  });

  it("keeps an explicit group even when it disagrees with the tag", () => {
    expect(feedSearch.parse({ tag: "硬件/机器人硬件", group: "算法" }).group).toBe("算法");
  });

  it("trims q and drops nothing else; a blank q survives as an empty string", () => {
    expect(feedSearch.parse({ q: "  步兵  " }).q).toBe("步兵");
    // Blank is not an error on the feed: it is a filter that matches everything.
    expect(feedSearch.parse({ q: "   " }).q).toBe("");
  });

  it("rejects an over-long q and an unknown scope", () => {
    expect(feedSearch.safeParse({ q: "x".repeat(201) }).success).toBe(false);
    expect(feedSearch.safeParse({ scope: "body" }).success).toBe(false);
    expect(feedSearch.parse({ scope: "kb" }).scope).toBe("kb");
  });
});

describe("rankedSearch", () => {
  it("accepts a missing q — /search's beforeLoad, not the schema, redirects a blank one", () => {
    expect(rankedSearch.parse({}).q).toBeUndefined();
    expect(rankedSearch.parse({ q: "  " }).q).toBe("");
    expect(rankedSearch.parse({ q: "步兵", tag: "算法/控制" })).toMatchObject({
      q: "步兵",
      group: "算法",
      scope: "all",
    });
  });
});

describe("kbSearch and accountSearch", () => {
  it("carry the three facet axes and nothing else", () => {
    expect(kbSearch.parse({ domain: "控制", robot: "步兵", genre: "教程", other: "x" })).toEqual({
      q: undefined,
      domain: "控制",
      robot: "步兵",
      genre: "教程",
    });
    expect(kbSearch.safeParse({ domain: "x".repeat(65) }).success).toBe(false);
  });

  it("passes the issuer's login_error through", () => {
    expect(accountSearch.parse({ login_error: "invalid_state" }).login_error).toBe("invalid_state");
    expect(accountSearch.parse({}).login_error).toBeUndefined();
  });
});

describe("canonical hrefs", () => {
  it("leafOf shows the part after the group", () => {
    expect(leafOf("硬件/机器人硬件")).toBe("机器人硬件");
    expect(leafOf("视觉")).toBe("视觉");
  });

  it("stripDerived drops the default scope and a group that is just groupOf(tag)", () => {
    expect(stripDerived({ scope: "all", tag: "硬件/机器人硬件", group: "硬件" })).toEqual({
      tag: "硬件/机器人硬件",
    });
    expect(stripDerived({ scope: "kb", q: "pid", group: "硬件" })).toEqual({
      scope: "kb",
      q: "pid",
      group: "硬件",
    });
  });
});
