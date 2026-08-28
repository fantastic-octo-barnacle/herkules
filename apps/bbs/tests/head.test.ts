/** Head injection, pure half: marker parsing, tag rendering, escaping, route detection. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

import type { HeadMeta } from "../src/library/types.ts";
import {
  HEAD_CLOSE,
  HEAD_OPEN,
  escapeAttribute,
  headRouteOf,
  loadHeadTemplate,
  renderHeadTags,
} from "../src/spa/head.ts";
import { APP_ORIGIN } from "./helpers.ts";

const meta: HeadMeta = {
  title: '【RM2026-开源】步兵底盘 <b>&"quoted"</b>',
  description: "  简介：全国产   方案  ".repeat(30),
  path: "/articles/01J0000000000000000000000A",
  type: "article",
  image: "https://cdn.example/1.png?a=1&b=2",
  publishedAt: new Date("2026-03-01T17:30:00.000Z"),
  author: "Kaiser <k@example>",
};

describe("loadHeadTemplate", () => {
  it("splits the fixture at the markers and keeps the plain file verbatim", async () => {
    const html = await readFile(new URL("./fixtures/index.html", import.meta.url), "utf8");
    const t = loadHeadTemplate(html);
    expect(t.plain).toBe(html);
    const rendered = t.render(meta, APP_ORIGIN);
    expect(rendered.startsWith(html.slice(0, html.indexOf(HEAD_OPEN) + HEAD_OPEN.length))).toBe(
      true,
    );
    expect(rendered.endsWith(html.slice(html.indexOf(HEAD_CLOSE)))).toBe(true);
    expect(rendered).not.toContain("<title>RM 文库</title>"); // the default was replaced, not merged
    expect(rendered).toContain("/assets/index-DEADBEEF.js"); // the build's own asset names survive
  });
  it("throws at boot on a missing or misordered marker", () => {
    expect(() => loadHeadTemplate("<html><head></head></html>")).toThrow(HEAD_OPEN);
    expect(() => loadHeadTemplate(`<head>${HEAD_OPEN}</head>`)).toThrow(HEAD_CLOSE);
    expect(() => loadHeadTemplate(`${HEAD_CLOSE}x${HEAD_OPEN}`)).toThrow(/before/);
  });
});

describe("renderHeadTags", () => {
  it("emits title, description, canonical and the og/twitter pairs, all escaped", () => {
    const out = renderHeadTags(meta, APP_ORIGIN);
    expect(out).toContain(
      "<title>【RM2026-开源】步兵底盘 &lt;b&gt;&amp;&quot;quoted&quot;&lt;/b&gt; · RM 文库</title>",
    );
    expect(out).not.toContain("<b>");
    expect(out).toContain(
      `<link rel="canonical" href="${APP_ORIGIN}/articles/01J0000000000000000000000A">`,
    );
    expect(out).toContain(
      `<meta property="og:url" content="${APP_ORIGIN}/articles/01J0000000000000000000000A">`,
    );
    expect(out).toContain('<meta property="og:type" content="article">');
    expect(out).toContain(
      '<meta property="og:image" content="https://cdn.example/1.png?a=1&amp;b=2">',
    );
    expect(out).toContain(
      '<meta property="article:published_time" content="2026-03-01T17:30:00.000Z">',
    );
    expect(out).toContain('<meta property="article:author" content="Kaiser &lt;k@example&gt;">');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image">');
    const description = /name="description" content="([^"]*)"/.exec(out)![1]!;
    expect(description).not.toMatch(/\s{2}/);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.endsWith("…")).toBe(true);
  });
  it("omits image, published_time and author when absent and uses the summary card", () => {
    const out = renderHeadTags(
      { ...meta, image: null, publishedAt: null, author: null, type: "website", description: "x" },
      `${APP_ORIGIN}/`,
    );
    expect(out).not.toContain("og:image");
    expect(out).not.toContain("article:");
    expect(out).toContain('<meta name="twitter:card" content="summary">');
    expect(out).toContain('<meta property="og:type" content="website">');
    expect(out).toContain(`content="${APP_ORIGIN}/articles/`); // no double slash from a trailing-slash origin
  });
});

describe("headRouteOf", () => {
  it("recognises exactly the two routes", () => {
    expect(headRouteOf("/articles/01J0000000000000000000000A")).toEqual({
      kind: "article",
      id: "01J0000000000000000000000A",
    });
    expect(headRouteOf("/articles/01J0000000000000000000000A/")).toEqual({
      kind: "article",
      id: "01J0000000000000000000000A",
    });
    expect(headRouteOf("/kb/HPM%205361")).toEqual({ kind: "entity", id: "HPM 5361" });
    expect(headRouteOf("/kb/%E2%82")).toBeNull(); // malformed percent-encoding
    for (const p of ["/", "/articles", "/articles/a/b", "/kb", "/search", "/api/articles/x"]) {
      expect(headRouteOf(p)).toBeNull();
    }
  });
});

describe("escapeAttribute", () => {
  it("neutralises the five characters", () => {
    expect(escapeAttribute(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });
});
