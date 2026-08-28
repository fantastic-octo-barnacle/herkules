/** The fold, the term parser and the cursor codec: pure functions with the invariants spelled out. */
import { describe, expect, it } from "vite-plus/test";

import { NORMALIZE_VERSION, normalize } from "../src/db/search/normalize.ts";
import { MAX_TERMS, parseTerms } from "../src/db/search/terms.ts";
import { decodeCursor, encodeCursor } from "../src/library/cursor.ts";
import type { ArticleId } from "../src/library/types.ts";
import { articleId, entityKey } from "../src/library/types.ts";

describe("normalize", () => {
  it("is length-preserving and per-unit on the corpus's characters", () => {
    const cases = [
      "【RM2026-开源】ＨＰＭ5361 步兵底盘（Ｐｒｏ版）：全国产",
      "İstanbul ǅ ß 😀 emoji and 𝔘nicode",
      "　full width space！",
      "",
    ];
    for (const s of cases) {
      const n = normalize(s);
      expect(n.length).toBe(s.length);
      for (let i = 0; i < s.length; i++) expect(normalize(s[i]!)).toBe(n[i]);
    }
  });
  it("folds width and ASCII case, keeps CJK and brackets", () => {
    expect(normalize("【RM2026-开源】ＨＰＭ5361（Ｐｒｏ）：Ａ　b")).toBe(
      "【rm2026-开源】hpm5361(pro):a b",
    );
    expect(normalize("İ")).toBe("İ"); // would become two units
    expect(normalize("😀")).toBe("😀");
    expect(NORMALIZE_VERSION).toBe("1");
  });
});

describe("parseTerms", () => {
  it("splits, folds, escapes, dedupes and caps; no floor", () => {
    const t = parseTerms('  "步兵" 底盘 ＰＩＤ pid 50%_x\\ 步兵 ');
    expect(t.map((x) => x.text)).toEqual(["步兵", "底盘", "pid", "50%_x\\"]);
    expect(t[3]!.pattern).toBe("50\\%\\_x\\\\");
    expect(t[0]!.raw).toBe("步兵");
    expect(parseTerms("   ")).toEqual([]);
    expect(parseTerms("a b c d e f g h i j")).toHaveLength(MAX_TERMS);
    expect(parseTerms("电")).toHaveLength(1);
  });
});

describe("cursor codec", () => {
  const id = "01J0000000000000000000000A" as ArticleId;
  it("round-trips both kinds and rejects the other kind or garbage", () => {
    const feed = {
      kind: "feed",
      at: new Date("2026-01-02T03:04:05.678Z"),
      position: 3,
      id,
    } as const;
    const rank = { kind: "rank", score: 1.5, id } as const;
    expect(decodeCursor(encodeCursor(feed), "feed")).toEqual(feed);
    expect(decodeCursor(encodeCursor(rank), "rank")).toEqual(rank);
    expect(decodeCursor(encodeCursor(feed), "rank")).toBeNull();
    expect(decodeCursor(encodeCursor(rank), "feed")).toBeNull();
    expect(decodeCursor("nope", "feed")).toBeNull();
    expect(decodeCursor(Buffer.from("[1]").toString("base64url"), "feed")).toBeNull();
    expect(
      decodeCursor(Buffer.from('["f","x",1,"' + id + '"]').toString("base64url"), "feed"),
    ).toBeNull();
  });
});

describe("brands", () => {
  it("articleId accepts ULIDs only", () => {
    expect(articleId("01J0000000000000000000000A")).toBe("01J0000000000000000000000A");
    expect(articleId("01j0000000000000000000000a")).toBe("01J0000000000000000000000A");
    expect(articleId("01J000000000000000000000")).toBeNull();
    expect(articleId("01J0000000000000000000000I")).toBeNull();
  });
  it("entityKey keeps letters and digits only, lower-cased", () => {
    expect(entityKey("HPM5361 (Pro)")).toBe("hpm5361pro");
    expect(entityKey("大疆 M3508")).toBe("大疆m3508");
    expect(entityKey("hpm5361pro")).toBe("hpm5361pro");
  });
});
