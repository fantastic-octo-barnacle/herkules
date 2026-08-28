/** Snippet trimming: the cap is a budget for the prose around the hits, never for the hits. */
import { describe, expect, it } from "vite-plus/test";

import type { Segment } from "../src/search/snippet.ts";
import { trimSegments } from "../src/search/snippet.ts";

const text = (segments: readonly Segment[]) => segments.map((s) => s.text).join("");
const hits = (segments: readonly Segment[]) => segments.filter((s) => s.hit).map((s) => s.text);

describe("trimSegments", () => {
  it("collapses whitespace and trims the outer edges", () => {
    expect(
      trimSegments([
        { text: "  多行\n\n  文本 ", hit: false },
        { text: "自瞄", hit: true },
        { text: " 结尾  ", hit: false },
      ]),
    ).toEqual([
      { text: "多行 文本 ", hit: false },
      { text: "自瞄", hit: true },
      { text: " 结尾", hit: false },
    ]);
  });

  it("returns short input unchanged", () => {
    const segments: Segment[] = [
      { text: "前", hit: false },
      { text: "自瞄", hit: true },
    ];
    expect(trimSegments(segments, 160)).toEqual(segments);
    expect(trimSegments([], 160)).toEqual([]);
  });

  it("keeps every hit intact while capping the rest", () => {
    const segments: Segment[] = [
      { text: "a".repeat(200), hit: false },
      { text: "自瞄", hit: true },
      { text: "b".repeat(200), hit: false },
      { text: "底盘", hit: true },
      { text: "c".repeat(200), hit: false },
    ];
    const out = trimSegments(segments, 60);
    expect(hits(out)).toEqual(["自瞄", "底盘"]);
    expect(text(out).length).toBeLessThan(100);
  });

  it("marks each cut with an ellipsis on the side it cut", () => {
    const out = trimSegments(
      [
        { text: "x".repeat(50), hit: false },
        { text: "自瞄", hit: true },
        { text: "y".repeat(50), hit: false },
      ],
      20,
    );
    expect(out[0]?.text.startsWith("…")).toBe(true); // the lead keeps its tail
    expect(out[2]?.text.endsWith("…")).toBe(true); // the tail keeps its head
    expect(out[1]).toEqual({ text: "自瞄", hit: true });
  });

  it("keeps both sides of a gap between two hits", () => {
    const out = trimSegments(
      [
        { text: "自瞄", hit: true },
        { text: "z".repeat(100), hit: false },
        { text: "底盘", hit: true },
      ],
      24,
    );
    const gap = out[1]?.text ?? "";
    expect(gap.startsWith("z")).toBe(true);
    expect(gap.endsWith("z")).toBe(true);
    expect(gap).toContain("…");
  });

  it("never drops a hit even when the hits alone exceed the cap", () => {
    const out = trimSegments(
      [
        { text: "自瞄系统".repeat(20), hit: true },
        { text: "。".repeat(100), hit: false },
        { text: "底盘", hit: true },
      ],
      20,
    );
    expect(hits(out)).toEqual(["自瞄系统".repeat(20), "底盘"]);
  });
});
