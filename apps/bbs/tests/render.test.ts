/**
 * The renderer is a security boundary: these are rm-wenku's render.rs/style.rs
 * tests ported, plus the adversarial cases the file header promises.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  ALLOWED,
  filterStyle,
  isEmbedUrl,
  renderArticleHtml,
  rewriteEmbeds,
  rewriteReferences,
  sanitize,
  stripTitleHeading,
} from "../src/content/render.ts";

const BASE = "https://bbs.robomaster.com/article/1";
const html = (raw: string, title = "Title", links: { url: string; label: string | null }[] = []) =>
  renderArticleHtml({ format: "html", raw, baseUrl: BASE, title, links });

describe("adversarial input", () => {
  it("drops scripts, event handlers, javascript: URLs and editor noise", () => {
    const out = html(
      `<h1>Title</h1><p style="line-height:1.5" data-w-e-type="x" contenteditable="false">Hi <code>x</code></p>
      <script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://github.com/a/b" target="">repo</a>
      <img src="/static/a.png" alt="a" onerror="x()">`,
    );
    expect(out.startsWith("<p>Hi <code>x</code></p>")).toBe(true);
    expect(out).not.toMatch(/script|javascript:|onerror|data-w-e-type|contenteditable|style=/);
    expect(out).toContain(
      '<a href="https://github.com/a/b" target="_blank" rel="noopener noreferrer nofollow">repo</a>',
    );
    expect(out).toContain('src="https://bbs.robomaster.com/static/a.png"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('referrerpolicy="no-referrer"');
  });

  it("refuses data: images, vbscript:, srcdoc iframes, foreign iframes, style tags, object/embed and SVG", () => {
    const out = html(
      `<img src="data:image/png;base64,AAAA"><a href="vbscript:x">v</a><a href="DATA:text/html,x">d</a>
      <iframe srcdoc="<script>1</script>" src="https://evil.example/x"></iframe>
      <style>body{display:none}</style><object data="x"></object><embed src="x"><svg onload="x()"><script>1</script></svg>
      <form action="/x"><input type="text" name="a"><button>go</button></form><base href="https://evil/">`,
    );
    expect(out).not.toMatch(
      /data:|vbscript|srcdoc|display:none|<object|<embed|<svg|onload|<form|<button|<base|<style|<script/i,
    );
    expect(out).toContain(
      '<a href="https://evil.example/x" target="_blank" rel="noopener noreferrer nofollow">https://evil.example/x</a>',
    );
    // The text input lost its type and became a disabled control; the field name is gone.
    expect(out).toMatch(/<input disabled \/>/);
  });

  it("filters style to the allowlist and never lets a url() or expression through", () => {
    const out = html(
      `<p style="text-align: center; background: url(http://x/y.png); color: expression(alert(1)); position: fixed; top: 0">x</p>
       <p style="color: rgb(0, 0, 0); user-select: none">y</p>`,
    );
    expect(out).toContain('<p style="text-align: center">x</p>');
    expect(out).toContain("<p>y</p>");
    expect(out).not.toMatch(/url\(|expression|position|user-select/);
  });

  it("only allows what ALLOWED says", () => {
    expect(ALLOWED.tags).toContain("video");
    expect(ALLOWED.tags).not.toContain("script");
    expect(ALLOWED.tags).not.toContain("svg");
    expect(ALLOWED.attributes.a).toEqual(["href", "hreflang", "target", "rel"]);
    expect(ALLOWED.embedHosts).toEqual([
      "player.bilibili.com",
      "www.youtube.com",
      "www.youtube-nocookie.com",
    ]);
    expect(ALLOWED.schemes).not.toContain("data");
    expect(ALLOWED.schemes).not.toContain("javascript");
  });
});

describe("what a forum post legitimately uses", () => {
  it("keeps tables and unrelated headings", () => {
    const out = html(
      '<h1>Other</h1><h2>Spec</h2><table><tbody><tr><td colspan="2">a</td></tr></tbody></table>',
    );
    expect(out.startsWith("<h1>Other</h1>")).toBe(true);
    expect(out).toContain('<td colspan="2">a</td>');
  });

  it("links reference markers to their articles", () => {
    const raw = `<h2>参考文献</h2><p><span style="color: transparent;"> </span><span id="referenceDom-1" style="display: inline-block;" data-w-e-type="reference" data-w-e-is-inline="" data-link="bbs://reference.com/1/undefined/undefined/1939253/1" data-order="1">[1]</span></p><p><span data-w-e-type="reference" data-link="bbs://reference.com/1/x/y/54091/2"></span></p>`;
    const links = [
      {
        url: "https://bbs.robomaster.com/article/1939253?source=1",
        label: "【RM2026-自瞄算法框架开源】深圳大学 <A&B>",
      },
    ];
    const out = renderArticleHtml({ format: "html", raw, baseUrl: BASE, title: "x", links });
    expect(out).toContain(
      '<a href="https://bbs.robomaster.com/article/1939253" target="_blank" rel="noopener noreferrer nofollow">[1] 【RM2026-自瞄算法框架开源】深圳大学 &lt;A&amp;B&gt;</a>',
    );
    expect(out).toContain(
      '<a href="https://bbs.robomaster.com/article/54091" target="_blank" rel="noopener noreferrer nofollow">[2]</a>',
    );
    expect(out).not.toContain("data-link");
    // A marker without a numeric post id degrades to its text.
    expect(
      rewriteReferences(
        '<span data-w-e-type="reference" data-link="bbs://reference.com/abc/x">[9]</span>',
        [],
      ),
    ).toBe("[9]");
  });

  it("keeps formulas, videos, embeds, todo boxes, code classes and author styles", () => {
    const raw = `<h1 style="text-align: center;">Title</h1><p style="text-align: center; color: rgb(0, 0, 0);"><img src="https://cdn/a.png" style="width: 30%; user-select: none;" width="auto"></p>
<p><span style="display: inline-block; color: rgba(0,0,0,0.85);" data-w-e-type="mathLatex" data-content="10^{-9}"><span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mn>10</mn><mrow><mo>−</mo><mn>9</mn></mrow></msup></mrow><annotation encoding="application/x-tex">10^{-9}</annotation></semantics></math></span></span></p>
<video poster="" controls="true" width="800" height="auto" data-file-md5="x"><source src="https://oss/x.mp4" type="video/mp4"/></video>
<iframe class="iframe_video" src="https://player.bilibili.com/player.html?bvid=BV1&amp;p=1" width="auto" height="auto"></iframe>
<iframe src="https://evil.example/x"></iframe>
<div data-w-e-type="todo"><input type="checkbox" disabled >做完</div>
<pre><code class="language-cpp foo">int x;</code></pre><table><tbody><tr><td style="background-color: rgb(255, 251, 143); border-width: 1px;">hi</td></tr></tbody></table>`;
    const out = html(raw);
    expect(out.startsWith('<p style="text-align: center">')).toBe(true);
    expect(out).toContain('<img src="https://cdn/a.png" style="width: 30%"');
    expect(out).not.toContain('width="auto"');
    expect(out).toContain(
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mn>10</mn>',
    );
    expect(out).toContain('<annotation encoding="application/x-tex">10^{-9}</annotation>');
    const video = out.slice(out.indexOf("<video"), out.indexOf("</video>"));
    for (const attr of ['width="800"', "controls", 'preload="metadata"', "playsinline"])
      expect(video).toContain(attr);
    expect(out).not.toContain("poster=");
    expect(video).toContain('<source src="https://oss/x.mp4" type="video/mp4"');
    const frame = out.slice(out.indexOf("<iframe"), out.indexOf("</iframe>"));
    for (const attr of [
      'src="https://player.bilibili.com/player.html?bvid=BV1&amp;p=1"',
      "allowfullscreen",
      'loading="lazy"',
    ]) {
      expect(frame).toContain(attr);
    }
    expect(out).toContain(
      '<p><a href="https://evil.example/x" target="_blank" rel="noopener noreferrer nofollow">https://evil.example/x</a></p>',
    );
    expect(out).not.toContain('<iframe src="https://evil');
    expect(out).toMatch(/<input type="checkbox" disabled \/>做完/);
    expect(out).toContain('<code class="language-cpp">int x;</code>');
    expect(out).toContain(
      '<td style="background-color: rgb(255, 251, 143); color: #1c2433">hi</td>',
    );
    expect(out).not.toMatch(/data-w-e-type|user-select/);
  });

  it("renders markdown with tables, task lists and resolved links, and strips the duplicate title", () => {
    const out = renderArticleHtml({
      format: "markdown",
      raw: "# Doc\n\nSome *text* with [a link](https://example.com/x) and [rel](../other).\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n",
      baseUrl: BASE,
      title: "Doc",
      links: [],
    });
    expect(out.startsWith("<p>Some <em>text</em>")).toBe(true);
    expect(out).toContain("<table>");
    expect(out).toContain("<td>1</td>");
    expect(out).toContain('href="https://example.com/x" target="_blank"');
    expect(out).toContain('href="https://bbs.robomaster.com/other"');
    expect(out).toMatch(/<li><input type="checkbox" checked disabled \/>done<\/li>/);
    expect(out).toMatch(/<li><input type="checkbox" disabled \/>todo<\/li>/);
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("helpers", () => {
  it("stripTitleHeading matches on collapsed, case-folded text and only a leading h1", () => {
    expect(stripTitleHeading("<h1>  Hello   <b>World</b> </h1><p>x</p>", "hello world")).toBe(
      "<p>x</p>",
    );
    expect(stripTitleHeading('<h1 style="a">Hello</h1><p>x</p>', "Hello")).toBe("<p>x</p>");
    expect(stripTitleHeading("<h1>Other</h1><p>x</p>", "Hello")).toBe("<h1>Other</h1><p>x</p>");
    expect(stripTitleHeading("<h10>Hello</h10>", "Hello")).toBe("<h10>Hello</h10>");
    expect(stripTitleHeading("<p>y</p><h1>Hello</h1>", "Hello")).toBe("<p>y</p><h1>Hello</h1>");
  });

  it("isEmbedUrl / rewriteEmbeds", () => {
    expect(isEmbedUrl("https://player.bilibili.com/player.html?bvid=1")).toBe(true);
    expect(isEmbedUrl("http://player.bilibili.com/player.html")).toBe(false);
    expect(isEmbedUrl("https://player.bilibili.com.evil/x")).toBe(false);
    expect(isEmbedUrl("nope")).toBe(false);
    expect(rewriteEmbeds("<p>no frames</p>")).toBe("<p>no frames</p>");
    expect(rewriteEmbeds("<IFRAME></IFRAME>")).toBe("");
    expect(rewriteEmbeds('<iframe src="https://a/b"></iframe>')).toBe(
      '<p><a href="https://a/b">https://a/b</a></p>',
    );
  });

  it("sanitize resolves relative URLs only when the base parses", () => {
    expect(sanitize('<a href="/x">a</a>', "not a url")).toContain('href="/x"');
    expect(sanitize('<a href="#frag">a</a>', BASE)).toContain(`href="${BASE}#frag"`);
    expect(sanitize('<a href="//cdn/x.png">a</a>', BASE)).toContain('href="https://cdn/x.png"');
  });

  it("filterStyle: drops editor defaults, keeps author intent, adds readable text on coloured backgrounds", () => {
    expect(
      filterStyle(
        "p",
        "line-height: 1.5; text-align: center; color: rgb(0, 0, 0); text-indent: 2em;",
      ),
    ).toBe("text-align: center; text-indent: 2em");
    expect(
      filterStyle("span", "color: rgba(0,0,0,0.85); cursor: pointer; user-select: none;"),
    ).toBeNull();
    expect(filterStyle("span", "color: rgb(225, 60, 57); font-family: 微软雅黑;")).toBe(
      "color: rgb(225, 60, 57)",
    );
    expect(
      filterStyle(
        "td",
        "border-width: 1px; border-style: solid; border-color: rgb(241, 241, 241); background-color: rgb(255, 255, 255);",
      ),
    ).toBeNull();
    expect(filterStyle("td", "background-color: rgb(255, 251, 143)")).toBe(
      "background-color: rgb(255, 251, 143); color: #1c2433",
    );
    expect(filterStyle("td", "background-color: #1a3d8f")).toBe(
      "background-color: #1a3d8f; color: #f2f4f7",
    );
    expect(filterStyle("td", "background-color: #1a3d8f; color: gold")).toBe(
      "background-color: #1a3d8f; color: gold",
    );
    expect(filterStyle("td", "background-color: color(srgb 0.94 0.94 0.94 / 0.08)")).toBeNull();
    expect(filterStyle("img", "width: 30%; height: 310.67px")).toBe("width: 30%");
    expect(filterStyle("table", "width: 100%; height: 0px")).toBe("width: 100%");
    expect(filterStyle("p", "width: 30%")).toBeNull();
    expect(filterStyle("p", "font-size: 24px")).toBe("font-size: 24px");
    expect(filterStyle("p", "font-size: 1.5em")).toBe("font-size: 1.5em");
    expect(filterStyle("p", "font-size: 6px")).toBeNull();
    expect(filterStyle("p", "background-color: red; background: url(http://x/y.png)")).toBe(
      "background-color: red; color: #f2f4f7",
    );
    expect(filterStyle("p", "color: expression(alert(1))")).toBeNull();
    expect(filterStyle("p", "font-weight: 700 !important; font-style: italic")).toBe(
      "font-weight: 700; font-style: italic",
    );
    expect(filterStyle("iframe", "height: 400px")).toBe("height: 400px");
    expect(filterStyle("p", "color: #ff000010")).toBeNull();
  });
});
