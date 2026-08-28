/** Snippets: raw text out, positions found on the fold, best field/window by coverage. */
import { describe, expect, it } from "vite-plus/test";

import { SNIPPET_ELLIPSIS, snippet } from "../src/db/search/snippet.ts";
import { parseTerms } from "../src/db/search/terms.ts";

const join = (segs: readonly { text: string; hit: boolean }[] | undefined) =>
  segs?.map((s) => (s.hit ? `[${s.text}]` : s.text)).join("");

describe("snippet", () => {
  it("emits the RAW text around a match found on the folded text", () => {
    const segs = snippet(["【RM2026-开源】ＨＰＭ5361 步兵底盘控制板"], parseTerms("hpm5361 步兵"));
    expect(join(segs)).toBe("【RM2026-开源】[ＨＰＭ5361] [步兵]底盘控制板");
    expect(segs?.filter((s) => s.hit).map((s) => s.text)).toEqual(["ＨＰＭ5361", "步兵"]);
  });

  it("returns undefined when no field contains a term", () => {
    expect(snippet(["云台调试", ""], parseTerms("步兵"))).toBeUndefined();
  });

  it("picks the field and window with the most distinct terms, ties to the earlier field", () => {
    const body = `${"前文。".repeat(60)}这里讲 PID 整定，先调 P。${"后文。".repeat(60)}`;
    const title = "整定经验";
    const segs = snippet([body, title], parseTerms("整定 pid"));
    const text = join(segs)!;
    expect(text.startsWith(SNIPPET_ELLIPSIS)).toBe(true);
    expect(text.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
    expect(text).toContain("[PID] [整定]");
    // A single-term field loses to the two-term window even though it comes first.
    const first = snippet([title, body], parseTerms("整定 pid"));
    expect(join(first)).toContain("[PID]");
    // Equal coverage: the earlier field wins.
    expect(join(snippet([title, body], parseTerms("整定")))).toBe("[整定]经验");
  });

  it("merges overlapping hits, collapses whitespace and keeps literal [n] markers as plain text", () => {
    const segs = snippet(["参考 [1] 的做法：步兵底盘\n\n步兵"], parseTerms("步兵 步兵底盘"));
    expect(join(segs)).toBe("参考 [1] 的做法：[步兵底盘] [步兵]");
    expect(segs?.filter((s) => !s.hit).some((s) => s.text.includes("[1]"))).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const emoji = "😀".repeat(80);
    const segs = snippet([`${emoji}目标${emoji}`], parseTerms("目标"));
    const text = segs!.map((s) => s.text).join("");
    for (const ch of text.replaceAll(SNIPPET_ELLIPSIS, ""))
      expect(ch.length === 2 || ch.charCodeAt(0) < 0xd800).toBe(true);
    expect(text).toContain("目标");
  });
});
