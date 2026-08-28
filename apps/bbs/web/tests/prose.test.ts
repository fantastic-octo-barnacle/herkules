/** The reader's regex passes over round 1's sanitised HTML. */
import { describe, expect, it } from "vite-plus/test";

import type { ArticleDTO } from "../../src/api/dto.ts";
import {
  extractLeadHeading,
  prepareProse,
  withHeadingIds,
  withImageAlts,
  withLocalLinks,
} from "../src/reader/prose.ts";

const links = [
  {
    url: "https://bbs.robomaster.com/article/1939253",
    kind: "other",
    label: null,
    articleId: "01LOCAL",
    position: 0,
  },
  { url: "https://github.com/a/b", kind: "repository", label: null, articleId: null, position: 1 },
] as unknown as ArticleDTO["links"];

describe("withLocalLinks", () => {
  it("rewrites only the href and keeps rel/target", () => {
    const html =
      '<p><a href="https://bbs.robomaster.com/article/1939253" target="_blank" rel="noopener noreferrer nofollow">[1] 自瞄</a> ' +
      '<a href="https://github.com/a/b" target="_blank" rel="noopener noreferrer nofollow">repo</a></p>';
    expect(withLocalLinks(html, links)).toBe(
      '<p><a href="/articles/01LOCAL" target="_blank" rel="noopener noreferrer nofollow">[1] 自瞄</a> ' +
        '<a href="https://github.com/a/b" target="_blank" rel="noopener noreferrer nofollow">repo</a></p>',
    );
  });

  it("tolerates a trailing slash and leaves html untouched when nothing resolves", () => {
    const html = '<a href="https://bbs.robomaster.com/article/1939253/">x</a>';
    expect(withLocalLinks(html, links)).toBe('<a href="/articles/01LOCAL">x</a>');
    expect(withLocalLinks(html, [])).toBe(html);
  });
});

describe("withImageAlts", () => {
  const images = [
    { url: "https://cdn/a.png", alt: "成本表", position: 0 },
    { url: "https://cdn/b.png", alt: "AI 说明", position: 1 },
    { url: "https://cdn/c.png", alt: '一个 "引号" & <角>', position: 2 },
  ] as unknown as ArticleDTO["images"];

  it("fills an empty alt and keeps an existing one", () => {
    const out = withImageAlts(
      '<img src="https://cdn/a.png" alt=""><img src="https://cdn/b.png" alt="手写">',
      images,
    );
    expect(out).toContain('<img src="https://cdn/a.png" alt="成本表" title="成本表">');
    expect(out).toContain('<img src="https://cdn/b.png" alt="手写">');
  });

  it("escapes the value it inserts", () => {
    const out = withImageAlts('<img src="https://cdn/c.png" alt="">', images);
    expect(out).toBe(
      '<img src="https://cdn/c.png" alt="一个 &quot;引号&quot; &amp; &lt;角&gt;" title="一个 &quot;引号&quot; &amp; &lt;角&gt;">',
    );
  });

  it("is a no-op without images", () => {
    const html = '<img src="https://cdn/a.png" alt="">';
    expect(withImageAlts(html, [])).toBe(html);
  });
});

describe("headings", () => {
  it("extracts the lead heading and numbers the rest", () => {
    const lead = extractLeadHeading("<h1>真标题</h1><h2>一</h2><h3>二</h3>");
    expect(lead.deck).toBe("真标题");
    const { html, headings } = withHeadingIds(lead.html);
    expect(headings).toEqual([
      { id: "sec-1", level: 2, text: "一" },
      { id: "sec-2", level: 3, text: "二" },
    ]);
    expect(html).toBe('<h2 id="sec-1">一</h2><h3 id="sec-2">二</h3>');
  });

  it("keeps filtered inline styles and skips empty headings", () => {
    const lead = extractLeadHeading(
      '<h1 style="text-align: center">真标题</h1><h2 style="text-align: center">一</h2><h2></h2>',
    );
    const { html, headings } = withHeadingIds(lead.html);
    expect(headings).toEqual([{ id: "sec-1", level: 2, text: "一" }]);
    expect(html).toBe('<h2 id="sec-1" style="text-align: center">一</h2><h2></h2>');
  });

  it("hoists only an OPENING h1, and not a blank one", () => {
    expect(extractLeadHeading("<h1>Real <em>title</em></h1><p>body</p>")).toEqual({
      html: "<p>body</p>",
      deck: "Real title",
    });
    expect(extractLeadHeading("<p>body</p><h1>later</h1>")).toEqual({
      html: "<p>body</p><h1>later</h1>",
      deck: null,
    });
    expect(extractLeadHeading("<h1> </h1><p>x</p>")).toEqual({
      html: "<h1> </h1><p>x</p>",
      deck: null,
    });
  });
});

describe("prepareProse", () => {
  it("runs every pass over contentHtml", () => {
    const prose = prepareProse({
      contentHtml:
        '<h1>真标题</h1><p><a href="https://bbs.robomaster.com/article/1939253" rel="nofollow">x</a></p><h2>一</h2><img src="https://cdn/a.png" alt="">',
      bodyText: "ignored",
      images: [
        { url: "https://cdn/a.png", alt: "图注", position: 0 },
      ] as unknown as ArticleDTO["images"],
      links,
    });
    expect(prose.deck).toBe("真标题");
    expect(prose.headings).toEqual([{ id: "sec-1", level: 2, text: "一" }]);
    expect(prose.html).toContain('<a href="/articles/01LOCAL" rel="nofollow">');
    expect(prose.html).toContain('alt="图注"');
  });

  it("falls back to escaped paragraphs from bodyText", () => {
    const prose = prepareProse({
      contentHtml: null,
      bodyText: "第一段 <script>alert(1)</script>\n\n第二段\n换行",
      images: [],
      links: [],
    });
    expect(prose.html).toBe(
      "<p>第一段 &lt;script&gt;alert(1)&lt;/script&gt;</p><p>第二段<br>换行</p>",
    );
    expect(prose.headings).toEqual([]);
    expect(prose.deck).toBeNull();
  });

  it("is empty when there is no body at all", () => {
    expect(prepareProse({ contentHtml: null, bodyText: null, images: [], links: [] })).toEqual({
      html: "",
      headings: [],
      deck: null,
    });
  });
});
