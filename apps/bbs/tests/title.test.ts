/**
 * Golden test for the title parser: every title in
 * `fixtures/title-parser/corpus.txt` must split the way
 * `corpus.expected.jsonl` says it does (the same pair of files rm-wenku pins
 * its Rust parser against). A rule change that moves any split fails here with
 * the corpus line number and both splits; review them, then re-generate the
 * fixtures on the rm-wenku side — never edit them to match the port.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { LABELS, splitTitle, type TitleParts } from "../src/content/title.ts";

interface Golden {
  season: string | null;
  team: string | null;
  labels: string[];
  topic: string;
}

function fixture(name: string): string[] {
  const path = fileURLToPath(new URL(`./fixtures/title-parser/${name}`, import.meta.url));
  return readFileSync(path, "utf8").split("\n");
}

/** The parts in the golden file's key order, so two rows compare as literals. */
function parts(split: TitleParts | Golden): Golden {
  return {
    season: split.season,
    team: split.team,
    labels: [...split.labels],
    topic: split.topic,
  };
}

const corpus = fixture("corpus.txt")
  .map((title, index) => ({ line: index + 1, title }))
  .filter((row) => row.title.trim() !== "");
const expected = fixture("corpus.expected.jsonl")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Golden & { title: string });

describe("splitTitle", () => {
  it("splits every corpus title the way the golden file pins it", () => {
    expect(corpus.length).toBe(810);
    expect(expected.length).toBe(corpus.length);

    const mismatches: {
      line: number;
      title: string;
      expected: Golden;
      actual: Golden;
    }[] = [];
    for (const [index, row] of corpus.entries()) {
      const want = expected[index];
      if (want === undefined) throw new Error(`no golden row for corpus line ${row.line}`);
      const actual = parts(splitTitle(row.title));
      const wanted = parts(want);
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        mismatches.push({ line: row.line, title: row.title, expected: wanted, actual });
      }
    }

    // The slice puts the first offending titles (with line numbers) in the
    // failure output; the count then reports how many moved in total.
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it("never throws and always names a topic", () => {
    const degenerate = ["【", "】", "[", "🤖".repeat(2500), "-—–+｜|·：:_,，、/"];
    for (const raw of degenerate) {
      const split = splitTitle(raw);
      // Code points, not UTF-16 units: the emoji title is half as long in
      // `.length` terms as it looks, and every threshold here counts as Rust did.
      expect([...split.topic].length).toBeGreaterThan(0);
      expect(split.labels).toEqual([]);
    }
    expect([...splitTitle("🤖".repeat(2500)).topic].length).toBe(2500);

    // A blank title has nothing to fall back to: the topic is the trimmed raw
    // title, i.e. empty — the one case where it is (rm-wenku pins the same).
    for (const blank of ["", "   ", " \n\t"]) {
      const split = splitTitle(blank);
      expect(split).toEqual({ season: null, team: null, labels: [], topic: "" });
    }
  });

  it("lists the 17 generic bracket tags", () => {
    expect(LABELS).toHaveLength(17);
    expect(new Set(LABELS).size).toBe(17);
  });
});
