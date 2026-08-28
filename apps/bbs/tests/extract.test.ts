/**
 * rm-wenku's extract/{mod,html,markdown}.rs unit tests ported, plus the
 * invariants the ported version owns that Rust's did not spell out (extras go
 * through the same add rules; positions stay dense across rejects) and the two
 * RoboMaster fixtures asserted literally.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  EXTRACT_VERSION,
  extract,
  type ExtractExtras,
  type Extracted,
} from "../src/content/extract.ts";
import { isImageResource } from "../src/content/urls.ts";

const BASE = "https://bbs.example.com/article/1";
const html = (raw: string, extras?: ExtractExtras): Extracted => extract("html", raw, BASE, extras);
const md = (raw: string, extras?: ExtractExtras): Extracted =>
  extract("markdown", raw, BASE, extras);

describe("html", () => {
  it("joins blocks with a blank line and collects links and images", () => {
    const out = html(
      `<h2>框架设计</h2><p>插件通过 Context 通信并按配置动态加载。</p>` +
        `<pre><code>add_plugin(camera)</code></pre>` +
        `<p><a href="https://github.com/example/frame">源码</a></p>` +
        `<img src="https://cdn.example.com/diagram.png" alt="架构图">`,
    );
    expect(out.bodyText).toBe(
      "框架设计\n\n插件通过 Context 通信并按配置动态加载。\n\nadd_plugin(camera)\n\n源码",
    );
    expect(out.links).toEqual([
      {
        url: "https://github.com/example/frame",
        kind: "repository",
        label: "源码",
        position: 0,
      },
    ]);
    expect(out.images).toEqual([
      { url: "https://cdn.example.com/diagram.png", alt: "架构图", position: 0 },
    ]);
  });

  it("drops blocks of one code point and blocks equal to the one before", () => {
    expect(html("<p>x</p><p>hello</p><p>hello</p><p>hello</p>").bodyText).toBe("hello");
    // Only the *immediate* predecessor counts, so a repeated heading later stays.
    expect(html("<p>a1</p><p>b1</p><p>a1</p>").bodyText).toBe("a1\n\nb1\n\na1");
  });

  it("does not duplicate nested blocks", () => {
    const out = html(
      "<ul><li>Item 1<ul><li>Sub</li></ul></li><li><p>Item 2</p></li></ul>" +
        "<blockquote><p>a quote</p><p>b quote</p></blockquote>",
    );
    expect(out.bodyText).toBe("Item 1\n\nSub\n\nItem 2\n\na quote\n\nb quote");
  });

  it("ignores script, style and noscript content", () => {
    const out = html(
      "<p>visible</p><script>var x = 1;</script><style>p{}</style><noscript>no js</noscript>",
    );
    expect(out.bodyText).toBe("visible");
    expect(out.bodyText).not.toMatch(/var x|no js|p\{\}/);
  });

  it("makes one block per table row and keeps line breaks inside pre", () => {
    const out = html(
      "<table><tr><th>名称</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>" +
        "<pre>line 1\n  line 2  \n</pre>",
    );
    expect(out.bodyText).toBe("名称 值\n\na 1\n\nline 1\n  line 2");
  });

  it("turns br into a line break inside its block", () => {
    expect(html("<p>first<br>second</p>").bodyText).toBe("first second");
  });

  it("emits the editor's LaTeX once and notes videos", () => {
    const out = html(
      `<p>延迟 <span style="display: inline-block;" data-w-e-type="mathLatex" data-content="10^{-9}\\,\\mathrm{s}">` +
        `<span class="katex"><math><semantics><mrow><msup><mn>10</mn><mrow><mo>−</mo><mn>9</mn></mrow></msup></mrow>` +
        `<annotation encoding="application/x-tex">10^{-9}\\,\\mathrm{s}</annotation></semantics></math></span></span> 以内</p>` +
        `<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>` +
        `<video controls="true" data-file-name="蓝色大符.mp4"><source src="https://oss/a.mp4"></video>` +
        `<iframe src="https://player.bilibili.com/player.html?bvid=BV1"></iframe>`,
    );
    expect(out.bodyText).toBe(
      "延迟 $10^{-9}\\,\\mathrm{s}$ 以内\n\n$x^2$\n\n（视频：蓝色大符.mp4）\n\n（视频：https://player.bilibili.com/player.html?bvid=BV1）",
    );
  });

  it("maps the editor's reference markers to forum article URLs", () => {
    const out = html(
      `<h2>参考文献</h2><p><span data-w-e-type="reference" data-link="bbs://reference.com/a/b/c/123/1">[1]</span></p>`,
    );
    expect(out.links).toEqual([
      { url: "https://bbs.robomaster.com/article/123", kind: "other", label: null, position: 0 },
    ]);
  });

  it("normalises relative and tracking URLs", () => {
    const out = html(
      `<a href="/files/r.pdf?utm_source=x">报告</a><img src="//cdn.example.com/i.png">`,
    );
    expect(out.links[0]?.url).toBe("https://bbs.example.com/files/r.pdf");
    expect(out.links[0]?.kind).toBe("download");
    expect(out.images[0]).toEqual({ url: "https://cdn.example.com/i.png", alt: null, position: 0 });
  });

  it("falls back to title when alt is blank", () => {
    const out = html(
      `<img src="https://c.example.com/a.png" alt="  " title="标题"><img src="https://c.example.com/b.png" alt="">`,
    );
    expect(out.images).toEqual([
      { url: "https://c.example.com/a.png", alt: "标题", position: 0 },
      { url: "https://c.example.com/b.png", alt: null, position: 1 },
    ]);
  });

  it("classifies each link kind and keeps positions dense", () => {
    const out = html(
      `<a href="https://github.com/a/b">repo</a>` +
        `<a href="#skipped">anchor</a>` +
        `<a href="https://www.bilibili.com/video/BV1">bili</a>` +
        `<a href="https://pan.baidu.com/s/1">pan</a>` +
        `<a href="https://docs.example.com/page">docs</a>` +
        `<a href="https://example.com/plain">plain</a>`,
    );
    expect(out.links.map((link) => [link.kind, link.position])).toEqual([
      ["repository", 0],
      ["video", 1],
      ["cloud_drive", 2],
      ["document", 3],
      ["other", 4],
    ]);
  });
});

describe("markdown", () => {
  it("strips syntax and keeps one block per heading, paragraph, item and fence", () => {
    const out = md(
      "## 架构\n\n使用插件系统。\n\n- 第一点\n- 第二点\n\n```rust\nfn main() {}\n```\n",
    );
    expect(out.bodyText).toBe("架构\n\n使用插件系统。\n\n第一点\n\n第二点\n\nfn main() {}");
    expect(out.links).toEqual([]);
  });

  it("keeps a fenced block preformatted", () => {
    expect(md("```rust\nfn main() {\n    let x = 1;\n}\n```\n").bodyText).toBe(
      "fn main() {\n    let x = 1;\n}",
    );
  });

  it("collects links and images without polluting the text", () => {
    const out = md(
      "看 [仓库](https://gitee.com/a/b) 和 ![功率曲线](https://cdn.example.com/power.png)。",
    );
    expect(out.bodyText).toBe("看 仓库 和 。");
    expect(out.bodyText).not.toContain("功率曲线");
    expect(out.links).toEqual([
      { url: "https://gitee.com/a/b", kind: "repository", label: "仓库", position: 0 },
    ]);
    expect(out.images).toEqual([
      { url: "https://cdn.example.com/power.png", alt: "功率曲线", position: 0 },
    ]);
  });

  it("makes one block per table row and drops task markers", () => {
    expect(md("| a | b |\n|---|---|\n| 1 | 2 |\n").bodyText).toBe("a b\n\n1 2");
    expect(md("- [x] 已校准\n- [ ] 自瞄联调\n").bodyText).toBe("已校准\n\n自瞄联调");
  });

  it("splices embedded HTML blocks and inline tags through the HTML walk", () => {
    const out = md(
      '正文\n\n<p>内嵌 <a href="/files/x.zip">下载</a></p>\n<img src="https://cdn.example.com/b.jpg" alt="b">\n',
    );
    expect(out.bodyText).toBe("正文\n\n内嵌 下载");
    expect(out.links).toEqual([
      { url: "https://bbs.example.com/files/x.zip", kind: "download", label: "下载", position: 0 },
    ]);
    expect(out.images).toEqual([{ url: "https://cdn.example.com/b.jpg", alt: "b", position: 0 }]);
    // Inline HTML is spliced space-padded; `<a>` and its text are separate
    // tokens, so an inline anchor gets no label — as in rm-wenku.
    const inline = md('正文 <b>粗</b> 和 <a href="https://github.com/x/y">仓库</a> 结束\n');
    expect(inline.bodyText).toBe("正文 粗 和 仓库 结束");
    expect(inline.links[0]).toEqual({
      url: "https://github.com/x/y",
      kind: "repository",
      label: null,
      position: 0,
    });
  });

  it("turns a soft break into a space and a hard break into a newline", () => {
    expect(md("soft\nbreak\n").bodyText).toBe("soft break");
    expect(md("hard  \nbreak\n").bodyText).toBe("hard break");
  });
});

describe("extras", () => {
  it("dedupes an attachment that repeats an in-content link", () => {
    const out = html(`<p><a href="https://cdn.example.com/report.pdf">下载</a></p>`, {
      links: [{ url: "https://cdn.example.com/report.pdf", label: "技术报告.pdf" }],
      images: [],
    });
    expect(out.links).toEqual([
      {
        url: "https://cdn.example.com/report.pdf",
        kind: "download",
        label: "下载",
        position: 0,
      },
    ]);
  });

  it("adopts a later label only when the first row had none", () => {
    const out = html(`<p><a href="https://example.com/p"></a></p>`, {
      links: [{ url: "https://example.com/p", label: "参考项目" }],
      images: [],
    });
    expect(out.links[0]?.label).toBe("参考项目");
  });

  it("keeps positions dense when some extras are rejected", () => {
    const out = html(`<p><a href="https://a.example.com/1">a</a></p>`, {
      links: [
        { url: "javascript:void(0)", label: "bad" },
        { url: BASE, label: "self" },
        { url: "https://b.example.com/2", label: "b" },
      ],
      images: [],
    });
    expect(out.links.map((link) => [link.url, link.position])).toEqual([
      ["https://a.example.com/1", 0],
      ["https://b.example.com/2", 1],
    ]);
  });

  it("lands an extra image whose name says JPG in images", () => {
    const src = "https://cdn.example.com/files/123";
    expect(isImageResource(src, "photo.JPG")).toBe(true);
    const out = html("<p>正文内容</p>", {
      links: [],
      images: [{ url: src, alt: "photo.JPG" }],
    });
    expect(out.images).toEqual([{ url: src, alt: "photo.JPG", position: 0 }]);
  });
});

describe("rejects", () => {
  it("drops anchors, javascript:, data: URIs, svg and self-references", () => {
    const out = html(
      `<a href="#anchor">a</a>` +
        `<a href="javascript:alert(1)">b</a>` +
        `<a href="JavaScript:void(0)">c</a>` +
        `<a href="https://bbs.example.com/article/1">self</a>` +
        `<a href="   ">blank</a>` +
        `<img src="data:image/png;base64,AAAA">` +
        `<img src="https://cdn.example.com/logo.svg?x=1">` +
        `<img src="https://cdn.example.com/logo.SVG">`,
    );
    expect(out.links).toEqual([]);
    expect(out.images).toEqual([]);
  });

  it("drops relative links when the base URL cannot be parsed", () => {
    const out = extract("html", `<p><a href="/x">下载附件</a></p><img src="/z.png">`, "not a url");
    expect(out.links).toEqual([]);
    expect(out.images).toEqual([]);
    // The text still comes through; only the unresolvable targets are dropped.
    expect(out.bodyText).toBe("下载附件");
  });

  it("survives a multi-byte href that a byte-sliced scheme check would split", () => {
    const out = html(`<a href="百度百科/词条">百科</a>`);
    expect(out.links).toHaveLength(1);
    expect(out.links[0]?.label).toBe("百科");
  });
});

// ── the RoboMaster fixtures ──────────────────────────────────────────────────

interface FixtureResource {
  readonly src?: string | null;
  readonly name?: string | null;
}
interface FixtureReference {
  readonly url?: string | null;
  readonly title?: string | null;
}
interface FixturePost {
  readonly htmlContent: string | null;
  readonly markdownContent: string | null;
  readonly attachments: readonly FixtureResource[] | null;
  readonly fileItems: readonly FixtureResource[] | null;
  readonly references: readonly FixtureReference[] | null;
}

const FIXTURE_BASE = "https://bbs.robomaster.com/article/1939253?source=1";

function loadPost(file: string): FixturePost {
  const raw = readFileSync(new URL(`./fixtures/robomaster/${file}`, import.meta.url), "utf8");
  return (JSON.parse(raw) as { data: FixturePost }).data;
}

/** What wenku-source's `map_detail` hands the extractor after the body. */
function fixtureExtras(post: FixturePost): ExtractExtras {
  const links: { url: string; label: string | null }[] = [];
  const images: { url: string; alt: string | null }[] = [];
  for (const resource of [...(post.attachments ?? []), ...(post.fileItems ?? [])]) {
    const src = resource.src?.trim() ?? "";
    if (src === "") continue;
    const name = resource.name?.trim() ?? "";
    const label = name === "" ? null : name;
    if (isImageResource(src, label)) images.push({ url: src, alt: label });
    else links.push({ url: src, label });
  }
  for (const reference of post.references ?? []) {
    if (reference.url) links.push({ url: reference.url, label: reference.title ?? null });
  }
  return { links, images };
}

describe("robomaster fixtures", () => {
  it("extracts post_html.json", () => {
    const post = loadPost("post_html.json");
    const out = extract("html", post.htmlContent ?? "", FIXTURE_BASE, fixtureExtras(post));
    expect(out.bodyText).toBe(
      "框架设计\n\n插件通过 Context 通信并按配置动态加载。\n\nadd_plugin(camera)\n\n源码",
    );
    expect(out.links).toEqual([
      {
        url: "https://github.com/example/frame",
        kind: "repository",
        label: "源码",
        position: 0,
      },
      // attachments[0]; fileItems[0] repeats the URL with a different name and
      // is deduped, the first label winning.
      {
        url: "https://cdn.example.com/report.pdf",
        kind: "download",
        label: "技术报告.pdf",
        position: 1,
      },
      {
        url: "https://bbs.robomaster.com/article/123",
        kind: "other",
        label: "参考项目",
        position: 2,
      },
    ]);
    expect(out.images).toEqual([
      { url: "https://cdn.example.com/diagram.png", alt: "架构图", position: 0 },
      // fileItems[1]: the extension-less URL is an image because the name is `.JPG`.
      { url: "https://cdn.example.com/files/123", alt: "photo.JPG", position: 1 },
    ]);
  });

  it("extracts post_markdown.json", () => {
    const post = loadPost("post_markdown.json");
    const out = extract("markdown", post.markdownContent ?? "", FIXTURE_BASE, fixtureExtras(post));
    expect(out.bodyText).toBe("架构\n\n使用插件系统。\n\n仓库");
    expect(out.links).toEqual([
      { url: "https://gitee.com/a/b", kind: "repository", label: "仓库", position: 0 },
    ]);
    expect(out.images).toEqual([
      { url: "https://cdn.example.com/power.png", alt: "功率曲线", position: 0 },
    ]);
  });
});

describe("EXTRACT_VERSION", () => {
  it("is the parser version stamped on imported rows", () => {
    expect(EXTRACT_VERSION).toBe("0");
  });
});
