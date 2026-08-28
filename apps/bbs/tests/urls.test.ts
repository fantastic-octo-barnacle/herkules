/**
 * rm-wenku's wenku-core unit tests ported verbatim: url.rs, links.rs, text.rs,
 * lib.rs (clean_text, reference_target) and hash.rs, run against the TypeScript
 * ports in src/content/{urls,text}.ts. These decide `canonical_url` and link
 * dedupe, so any drift from Rust would silently split the corpus in two.
 */
import { describe, expect, it } from "vite-plus/test";

import { cleanText, clipChars, countChars, sha256Hex, truncateChars } from "../src/content/text.ts";
import {
  classifyLink,
  isImageResource,
  type LinkKind,
  normalizeUrl,
  referenceTarget,
  resolveAndNormalize,
} from "../src/content/urls.ts";

describe("normalizeUrl", () => {
  it("strips the fragment and tracking params", () => {
    expect(normalizeUrl("https://Example.com/a?utm_source=x&id=1&spm=2#frag")).toBe(
      "https://example.com/a?id=1",
    );
  });

  it("drops the query entirely when only tracking remains", () => {
    expect(normalizeUrl("https://example.com/a?utm_medium=y")).toBe("https://example.com/a");
  });

  it("keeps a non-tracking query in order", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe("https://example.com/a?b=2&a=1");
  });

  it("drops `from` and `ref` alongside utm_*", () => {
    expect(normalizeUrl("https://example.com/a?from=app&ref=z&id=7")).toBe(
      "https://example.com/a?id=7",
    );
  });

  it("returns null for input that is not a URL", () => {
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("resolveAndNormalize", () => {
  it("resolves relative references against the base", () => {
    expect(resolveAndNormalize("https://example.com/article/1", "/files/a.pdf?ref=x")).toBe(
      "https://example.com/files/a.pdf",
    );
  });

  it("resolves a non-http scheme rather than rejecting it (the caller filters)", () => {
    expect(resolveAndNormalize("https://example.com", "javascript:void(0)")).not.toBeNull();
  });

  it("returns null when the base cannot be parsed", () => {
    expect(resolveAndNormalize("not a url", "x")).toBeNull();
  });

  it("percent-encodes a multi-byte relative href instead of panicking", () => {
    expect(resolveAndNormalize("https://bbs.example.com/article/1", "百度百科/词条")).toBe(
      "https://bbs.example.com/article/%E7%99%BE%E5%BA%A6%E7%99%BE%E7%A7%91/%E8%AF%8D%E6%9D%A1",
    );
  });
});

describe("classifyLink", () => {
  const kind = (input: string): LinkKind => classifyLink(new URL(input));

  it("classifies by host and extension", () => {
    expect(kind("https://github.com/a/b")).toBe("repository");
    expect(kind("https://www.gitee.com/a/b")).toBe("repository");
    expect(kind("https://www.bilibili.com/video/BV1")).toBe("video");
    expect(kind("https://youtu.be/x")).toBe("video");
    expect(kind("https://pan.baidu.com/s/1")).toBe("cloud_drive");
    expect(kind("https://example.com/a.pdf")).toBe("download");
    expect(kind("https://example.com/dir/archive.tar.gz?x=1")).toBe("download");
    expect(kind("https://docs.example.com/page")).toBe("document");
    expect(kind("https://xxx.feishu.cn/docx/abc")).toBe("document");
    expect(kind("https://example.com/page")).toBe("other");
  });

  it("does not match a host by substring", () => {
    expect(kind("https://notgithub.com/a")).toBe("other");
  });
});

describe("isImageResource", () => {
  it("detects image resources by URL or by the source's file name", () => {
    expect(isImageResource("https://x/y.PNG?size=1", null)).toBe(true);
    expect(isImageResource("https://x/download/123", "diagram.jpg")).toBe(true);
    expect(isImageResource("https://x/y.svg", null)).toBe(false);
    expect(isImageResource("https://x/report.pdf", "")).toBe(false);
  });
});

describe("referenceTarget", () => {
  it("maps the editor's bbs:// marker to the forum article URL", () => {
    expect(referenceTarget("bbs://reference.com/1/undefined/undefined/1939253/1")).toBe(
      "https://bbs.robomaster.com/article/1939253",
    );
  });

  it("returns null unless the post id is all digits", () => {
    expect(referenceTarget("bbs://reference.com/a/b/c/xx/1")).toBeNull();
    expect(referenceTarget("https://bbs.robomaster.com/article/1")).toBeNull();
    expect(referenceTarget("bbs://reference.com/1")).toBeNull();
  });
});

describe("cleanText", () => {
  it("collapses every whitespace run and trims the ends", () => {
    expect(cleanText("  a \n\t b  c ")).toBe("a b c");
    expect(cleanText("   ")).toBe("");
  });
});

describe("character counting", () => {
  /** 15 code points: 4 CJK, an emoji, a Latin word and a full-width numeral. */
  const MIXED = "超级电容🔋 control ①";

  it("counts characters, not bytes or UTF-16 units", () => {
    expect(countChars(MIXED)).toBe(15);
    expect(clipChars(MIXED, 4)).toBe("超级电容");
    expect(clipChars(MIXED, 5)).toBe("超级电容🔋");
    expect(truncateChars(MIXED, 5)).toBe("超级电容🔋…");
  });

  it("returns text that fits unchanged", () => {
    expect(clipChars(MIXED, 100)).toBe(MIXED);
    expect(truncateChars(MIXED, 100)).toBe(MIXED);
    expect(clipChars("", 0)).toBe("");
    expect(truncateChars("ab", 0)).toBe("…");
  });

  it("cuts a multi-byte string at every valid boundary", () => {
    for (let max = 0; max <= countChars(MIXED) + 1; max += 1) {
      const cut = clipChars(MIXED, max);
      expect(MIXED.startsWith(cut)).toBe(true);
      expect(countChars(cut)).toBe(Math.min(max, countChars(MIXED)));
    }
  });
});

describe("sha256Hex", () => {
  it("is stable, lower-case hex and 64 characters", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
