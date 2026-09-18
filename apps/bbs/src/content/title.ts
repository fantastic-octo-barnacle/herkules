/**
 * Order-independent splitting of forum titles into season, team, labels and
 * topic: a port of rm-wenku's `crates/wenku-core/src/title.rs`, keeping its
 * constants, regexes and step order so the two files can be read side by side.
 * Segments are classified by content, never by position, and cut only at
 * segment boundaries; when unsure the title is left whole.
 *
 * Golden-tested: `tests/title.test.ts` replays every title in
 * `tests/fixtures/title-parser/corpus.txt` against the splits pinned in
 * `corpus.expected.jsonl`. Change the rules and that test names the titles
 * that moved.
 *
 * Porting notes: Rust's `regex` has no lookaround, so neither do these
 * patterns — the single lookbehind re-creates Rust's Unicode-aware `\b`, which
 * JS spells ASCII-only. Every regex carries `u`; `\d` and `\s` are spelled
 * `\p{Nd}` / `\p{White_Space}` because Rust's are Unicode-aware; and lengths
 * count code points (`chars`), never `.length`, wherever the Rust counted
 * `chars()`.
 */
import { cleanText, countChars as chars } from "./text.ts";

/** Bumped when a rule change re-splits stored titles; all versions are "0" in this phase. */
export const TITLE_VERSION = "0";

/**
 * The parts of a forum title, for the list eyebrow (season · team), the
 * headline (topic) and muted tags (labels).
 */
export interface TitleParts {
  /** Normalised season such as `RM2026`, `RMUC2026` or `RM2024-25`. */
  readonly season: string | null;
  /** School and/or team name, e.g. `深圳大学 RobotPilots战队`. */
  readonly team: string | null;
  /** Generic bracket tags (`开源`, `技术报告`, …) in title order. */
  readonly labels: readonly string[];
  /** What the article is about; never empty (falls back to the team, then the trimmed title). */
  readonly topic: string;
}

// ---- matching vocabulary (data, not UI copy) -------------------------------

/** Bracket pairs that delimit segments; index `i` of OPEN closes with index `i` of CLOSE. */
const OPEN_BRACKETS = ["【", "[", "「", "〔", "［"];
const CLOSE_BRACKETS = ["】", "]", "」", "〕", "］"];
/** Characters that always end a segment. */
const STRONG_SEPARATORS = [
  "-",
  "—",
  "–",
  "+",
  "｜",
  "|",
  "·",
  "：",
  ":",
  "_",
  ",",
  "，",
  "、",
  "/",
];
/** Dashes that may join two years of a season range (`RM2024-25`). */
const RANGE_DASHES = ["-", "–"];
/** Joiners after a school-only segment that still read as "school name" (`西安交通大学-笃行`). */
const NAME_JOINERS = ["-", "—", "–", "_", "·", "/"];
/** Team-tail words that keep a preceding space inside the segment (`TCR 战队`). */
const TAIL_WORDS = ["战队", "联队", "实验室"];
/** Characters trimmed from the remainder after cutting a team out of a segment. */
const REST_TRIM = [" ", "-", "—", "–", "_", ":", "："];

/** Competition prefixes; longer alternatives first so `RMUC` is not read as `RM` + `UC`. */
const COMPETITIONS = "RMUC|RMUL|RMUA|RMU|RMYC|RM|RC|ROBOCON|ROBOMASTER";
/** Words a school name ends with. */
const SCHOOL_SUFFIXES = "大学|学院|学校|高中|中学|职业技术学院|联队";
/** Words a team name ends with. */
const TEAM_TAILS = "战队|队|联队|实验室|Team";
/** A character that may appear inside a school or team name. */
const NAME_CHAR = "[一-鿿A-Za-z0-9&.'’·]";
/** Rust's `\d` (Unicode) and `\s` (Unicode), which JS spells ASCII-only. */
const DIGIT = "\\p{Nd}";
const SPACE = "\\p{White_Space}";
/** Rust's `\w`, used to re-create its Unicode-aware `\b` with a lookbehind. */
const WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";

/** Generic bracket tags that are neither season, team nor topic. */
export const LABELS: readonly string[] = [
  "开源",
  "分享",
  "求助",
  "求助帖",
  "技术报告",
  "硬件设计",
  "归档",
  "转载",
  "开源分享",
  "开源发布",
  "个人开源",
  "复盘开源",
  "已完结",
  "抢先体验版",
  "实验性",
  "走心帖",
  "教程",
];

/**
 * Maximum characters in a team-name remainder that is folded into the team
 * when it is the last segment (`首都师范大学PIE战队 开源`).
 */
const TRAILING_NAME_CHARS = 6;
/** Maximum CJK characters in a short name merged after a school-only segment. */
const SHORT_NAME_CHARS = 4;
/** Maximum characters in a Latin name merged after a school-only segment. */
const LATIN_NAME_CHARS = 20;

/** `RM 2026` / `RM-2026` / `RM_2026` → `RM2026` (four-digit years only). */
const COMP_YEAR_GAP = new RegExp(
  `(?<![${WORD}])(${COMPETITIONS})[${SPACE}\\-_]+(20${DIGIT}{2})`,
  "giu",
);
/** Whole-segment season. */
const SEASON_FULL = new RegExp(
  `^(?:(?<comp>${COMPETITIONS})${SPACE}?[-_]?${SPACE}?(?<year>20${DIGIT}{2}|${DIGIT}{2})(?:[-–~](?<year2>20${DIGIT}{2}|${DIGIT}{2}))?(?:赛季)?|(?<year3>20${DIGIT}{2}|${DIGIT}{2})${SPACE}?(?:赛季|年))$`,
  "iu",
);
/** Season at the start of a segment, with the remainder in `rest`. */
const SEASON_PREFIX = new RegExp(
  `^(?:(?<comp>${COMPETITIONS})${SPACE}?[-_]?${SPACE}?(?<year>20${DIGIT}{2}|${DIGIT}{2})(?:[-–~](?<year2>20${DIGIT}{2}|${DIGIT}{2}))?(?:赛季)?|(?<year3>20${DIGIT}{2}|${DIGIT}{2})(?:赛季|年))(?<rest>.+)$`,
  "iu",
);
/** The left side of a season range, checked against the text before a dash. */
const RANGE_LEFT = new RegExp(`(?:${COMPETITIONS})${SPACE}?(?<year>20[0-9]{2}|[0-9]{2})$`, "iu");
/** The right side of a season range, checked against the text after a dash. */
const RANGE_RIGHT = /^(?<year>20[0-9]{2}|[0-9]{2})(?:[^A-Za-z0-9]|$)/u;

function teamPattern(): string {
  const campus = "(?:[（(][^）)]{1,12}[）)]|[一-鿿]{1,6}校区)?";
  return `(?:${NAME_CHAR}{1,14}?(?:${SCHOOL_SUFFIXES})${campus}(?:${SPACE}?(?:${NAME_CHAR}| ){1,16}?${SPACE}?(?:${TEAM_TAILS}))?|${NAME_CHAR}{1,14}?战队)`;
}
/** A team anywhere in a segment (used to find one ending the segment). */
const TEAM_ANY = new RegExp(teamPattern(), "gu");
/** A team at the start of a segment. */
const TEAM_PREFIX = new RegExp(`^${teamPattern()}`, "u");
/** A segment that is exactly a team. */
const TEAM_FULL = new RegExp(`^${teamPattern()}$`, "u");
/** A segment that is exactly `name 战队` (any tail), merged after a school-only segment. */
const TEAM_NAME = new RegExp(`^(?:${NAME_CHAR}| ){1,16}?${SPACE}?(?:${TEAM_TAILS})$`, "u");
/** A team that already ends in a tail word (nothing more to merge). */
const ENDS_WITH_TAIL = new RegExp(`(?:${TEAM_TAILS})$`, "u");
/** A team that names a school (bare `…战队` teams are only taken whole). */
const HAS_SCHOOL = new RegExp(`(?:${SCHOOL_SUFFIXES})`, "u");
/** A CJK name with an optional Latin suffix (`笃行`, `星云EGA`); no spaces or punctuation. */
const SHORT_NAME = /^[一-鿿]+[A-Za-z0-9]*$/u;
/** A Latin name such as `UBC`, `RobotPilots` or `Born Of Fire`. */
const LATIN_NAME = /^[A-Za-z0-9&.'’]*[A-Za-z][A-Za-z0-9&.'’]*(?: [A-Za-z0-9&.'’]+)*$/u;

/** What came right before a segment. */
type Joiner =
  /** Start of the title or a bracket edge. */
  | { readonly kind: "boundary" }
  /** A single space. */
  | { readonly kind: "space" }
  /** A strong separator character. */
  | { readonly kind: "separator"; readonly char: string };

interface Segment {
  readonly text: string;
  readonly bracketed: boolean;
  /**
   * The exact text between the previous segment of the same run and this one
   * (separators and spaces); `null` at the start of a run.
   */
  readonly lead: string | null;
}

function joinerOf(segment: Segment): Joiner {
  if (segment.lead === null) return { kind: "boundary" };
  for (const ch of segment.lead) {
    if (!isWhitespace(ch)) return { kind: "separator", char: ch };
  }
  return { kind: "space" };
}

/** A regex match with its code-unit bounds, mirroring Rust's `regex::Match`. */
interface Found {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Split a raw forum title into its parts. */
export function splitTitle(raw: string): TitleParts {
  const normalised = normalise(raw);
  const segments = segment(normalised);
  const last = segments.length === 0 ? 0 : segments.length - 1;

  let season: string | null = null;
  let team: string | null = null;
  const labels: string[] = [];
  // Topic pieces with the index of the segment they came from, so adjacent
  // pieces can keep their original separator.
  const topic: [number, string][] = [];
  // Index of a team segment that has no tail word yet (school only): the next
  // segment may complete it.
  let schoolOnlyAt: number | null = null;

  for (const [i, current] of segments.entries()) {
    let text = current.text;

    if (
      schoolOnlyAt !== null &&
      team !== null &&
      i === schoolOnlyAt + 1 &&
      !ENDS_WITH_TAIL.test(team) &&
      (TEAM_NAME.test(text) || isShortName(text, joinerOf(current)))
    ) {
      team = `${team} ${text}`;
      schoolOnlyAt = null;
      continue;
    }
    schoolOnlyAt = null;

    if (season === null) {
      const full = SEASON_FULL.exec(text);
      if (full !== null) {
        season = seasonText(full);
        continue;
      }
      const prefix = SEASON_PREFIX.exec(text);
      if (prefix !== null) {
        const rest = (prefix.groups?.rest ?? "").trim();
        if (chars(rest) >= 2 && !(current.bracketed && TEAM_FULL.test(rest))) {
          season = seasonText(prefix);
          text = rest;
        }
      }
    }

    if (current.bracketed && LABELS.includes(text)) {
      labels.push(text);
      continue;
    }

    if (team === null) {
      if (TEAM_FULL.test(text)) {
        team = text;
        schoolOnlyAt = i;
        continue;
      }
      const candidates = [teamPrefix(text), teamAtEnd(text)];
      let taken = false;
      for (const found of candidates) {
        if (found === null) continue;
        const candidate = found.text;
        // A bare `…战队` is never cut out of running text.
        if (!current.bracketed && !HAS_SCHOOL.test(candidate)) continue;
        const rest = trimMatches(text.slice(0, found.start) + text.slice(found.end), (ch) =>
          REST_TRIM.includes(ch),
        );
        if (chars(rest) < 2 || rest.startsWith("的") || rest.startsWith("之")) continue;
        if (
          found.start === 0 &&
          i === last &&
          chars(rest) <= TRAILING_NAME_CHARS &&
          topic.length > 0
        ) {
          team = `${candidate} ${rest}`;
        } else {
          team = candidate;
          topic.push([i, rest]);
        }
        taken = true;
        break;
      }
      if (!taken) topic.push([i, text]);
      continue;
    }

    topic.push([i, text]);
  }

  let joined = joinTopic(segments, topic);
  if (joined === "") joined = team ?? raw.trim();
  return { season, team, labels, topic: joined };
}

/**
 * Step 6: join the topic pieces, keeping the original separator between pieces
 * that were adjacent in the title and a space everywhere else.
 */
function joinTopic(segments: readonly Segment[], pieces: readonly [number, string][]): string {
  let out = "";
  let previous: number | null = null;
  for (const [index, text] of pieces) {
    if (previous !== null) {
      const lead = segments[index]?.lead ?? null;
      out += lead !== null && index === previous + 1 ? lead : " ";
    }
    out += text;
    previous = index;
  }
  return trimMatches(out, (ch) => isWhitespace(ch) || STRONG_SEPARATORS.includes(ch));
}

/** Step 1: collapse whitespace and close the gap in `RM 2026`. */
function normalise(raw: string): string {
  return cleanText(raw).replace(COMP_YEAR_GAP, "$1$2");
}

/** Step 2: bracket runs, then separators and CJK-adjacent spaces. */
function segment(title: string): Segment[] {
  const out: Segment[] = [];
  let run = "";
  let closing: string | null = null;
  for (const ch of title) {
    if (closing === null && OPEN_BRACKETS.includes(ch)) {
      if (run.trim() !== "") splitRun(run, false, out);
      run = "";
      closing = CLOSE_BRACKETS[OPEN_BRACKETS.indexOf(ch)] ?? null;
    } else if (closing !== null && ch === closing) {
      splitRun(run, true, out);
      run = "";
      closing = null;
      // A closing bracket without its opener (`RM2026-复旦大学-星云 EGA 战队】…`)
      // still ends the run instead of leaking into the topic.
    } else if (closing === null && CLOSE_BRACKETS.includes(ch)) {
      if (run.trim() !== "") splitRun(run, false, out);
      run = "";
    } else {
      run += ch;
    }
  }
  if (run.trim() !== "") {
    // An unclosed bracket still counts as bracket content.
    splitRun(run, closing !== null, out);
  }
  return out;
}

/**
 * Split one run on strong separators and on CJK-adjacent single spaces,
 * recording the exact text between neighbouring segments.
 */
function splitRun(run: string, bracketed: boolean, out: Segment[]): void {
  const runChars = [...run];
  // `buf` is the segment being built; `gap` is the text since the previous
  // segment of this run, `null` before the first one. Held in one record so
  // that `flush` can rewrite both (and so the compiler re-reads them after it).
  const pending: { buf: string; gap: string | null } = { buf: "", gap: null };

  const flush = (): void => {
    const text = pending.buf.trim();
    if (text === "") {
      if (pending.gap !== null) pending.gap += pending.buf;
    } else {
      out.push({
        text,
        bracketed,
        lead: pending.gap === null ? null : pending.gap + leadingWhitespace(pending.buf),
      });
      pending.gap = trailingWhitespace(pending.buf);
    }
    pending.buf = "";
  };

  for (const [i, ch] of runChars.entries()) {
    if (STRONG_SEPARATORS.includes(ch)) {
      if (RANGE_DASHES.includes(ch) && isSeasonRangeDash(pending.buf, runChars.slice(i + 1))) {
        pending.buf += ch;
        continue;
      }
      flush();
      if (pending.gap !== null) pending.gap += ch;
    } else if (isWhitespace(ch)) {
      const previous = i > 0 ? runChars[i - 1] : undefined;
      const next = runChars[i + 1];
      const previousCjk = previous !== undefined && isCjk(previous);
      const nextCjk = next !== undefined && isCjk(next);
      if (previousCjk || (nextCjk && !tailWordFollows(runChars.slice(i + 1)))) {
        flush();
        if (pending.gap !== null) pending.gap += ch;
      } else {
        pending.buf += ch;
      }
    } else {
      pending.buf += ch;
    }
  }
  flush();
}

/**
 * `RM2024` + `-` + `25…`: the dash joins a season range rather than ending the
 * segment. Only the next calendar year counts (`RM2024-25`, `RM2024-2025`),
 * which keeps `RM2025-27V…` and `RM2025-35HZ…` as topics.
 */
function isSeasonRangeDash(before: string, after: readonly string[]): boolean {
  const left = RANGE_LEFT.exec(before.trimEnd());
  const first = left === null ? null : yearMod100(left.groups?.year ?? "");
  if (first === null) return false;
  const right = RANGE_RIGHT.exec(after.slice(0, 5).join(""));
  const second = right === null ? null : yearMod100(right.groups?.year ?? "");
  return second !== null && second === (first + 1) % 100;
}

/**
 * The last two digits of a two- or four-digit year (`2024` and `24` → 24).
 *
 * Only `isSeasonRangeDash` calls this, and only to test that the two years are
 * consecutive. Iterating the reversed year reads the trailing digits first, so
 * `digits[0]` and `digits[1]` are the ones and tens of the last two digits —
 * despite looking like they take the leading pair of a 4-digit year. The caller
 * compares mod 100, which is exactly consecutiveness for same-century years.
 */
function yearMod100(year: string): number | null {
  const digits: number[] = [];
  for (const ch of [...year].reverse()) {
    const digit = asciiDigit(ch);
    if (digit !== null) digits.push(digit);
  }
  const ones = digits[0];
  const tens = digits[1];
  if (ones === undefined || tens === undefined) return null;
  return tens * 10 + ones;
}

/** Rust's `char::to_digit(10)`: ASCII digits only, whatever `\p{Nd}` matched. */
function asciiDigit(ch: string): number | null {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x30 && code <= 0x39 ? code - 0x30 : null;
}

/** Whether the text starts with a team-tail word (`战队`, `联队`, `实验室`, or `队` on its own). */
function tailWordFollows(rest: readonly string[]): boolean {
  const head = rest.slice(0, 3).join("");
  if (TAIL_WORDS.some((word) => head.startsWith(word))) return true;
  const next = rest[1];
  return rest[0] === "队" && !(next !== undefined && (isAlphanumeric(next) || next === "_"));
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x4e00 && code <= 0x9fff;
}

/** Rust's `char::is_whitespace` (Unicode `White_Space`). */
function isWhitespace(ch: string): boolean {
  return /\p{White_Space}/u.test(ch);
}

/** Rust's `char::is_alphanumeric` (`Alphabetic` or numeric). */
function isAlphanumeric(ch: string): boolean {
  return /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u.test(ch);
}

function leadingWhitespace(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!isWhitespace(ch)) break;
    out += ch;
  }
  return out;
}

function trailingWhitespace(text: string): string {
  let out = "";
  for (const ch of [...text].reverse()) {
    if (!isWhitespace(ch)) break;
    out = ch + out;
  }
  return out;
}

/** Rust's `str::trim_matches` over code points. */
function trimMatches(text: string, drop: (ch: string) => boolean): string {
  const textChars = [...text];
  let start = 0;
  let end = textChars.length;
  while (start < end && drop(textChars[start] ?? "")) start += 1;
  while (end > start && drop(textChars[end - 1] ?? "")) end -= 1;
  return textChars.slice(start, end).join("");
}

/**
 * A short name that completes a school-only segment when joined by `-`, `_`,
 * `·`, `/` or a space: a Latin token (`UBC`, `RobotPilots`), or a name of at
 * most four CJK characters with an optional Latin suffix (`笃行`, `星云EGA`).
 */
function isShortName(text: string, joiner: Joiner): boolean {
  const joined =
    joiner.kind === "space"
      ? true
      : joiner.kind === "separator"
        ? NAME_JOINERS.includes(joiner.char)
        : false;
  if (!joined || SEASON_FULL.test(text) || LABELS.includes(text)) return false;
  if (chars(text) <= LATIN_NAME_CHARS && LATIN_NAME.test(text)) return true;
  const cjk = [...text].filter(isCjk).length;
  return (
    cjk >= 1 &&
    cjk <= SHORT_NAME_CHARS &&
    chars(text) <= SHORT_NAME_CHARS * 2 &&
    SHORT_NAME.test(text)
  );
}

/** The team match at the start of the segment, if any. */
function teamPrefix(text: string): Found | null {
  const found = TEAM_PREFIX.exec(text);
  return found === null
    ? null
    : { start: found.index, end: found.index + found[0].length, text: found[0] };
}

/** The team match that ends exactly at the end of the segment, if any. */
function teamAtEnd(text: string): Found | null {
  TEAM_ANY.lastIndex = 0;
  let found = TEAM_ANY.exec(text);
  while (found !== null) {
    const end = found.index + found[0].length;
    if (found[0].length === 0) TEAM_ANY.lastIndex += 1;
    if (end === text.length) return { start: found.index, end, text: found[0] };
    found = TEAM_ANY.exec(text);
  }
  return null;
}

/** `RM2026`, `RMUC2026`, `RM2024-25` from a season match. */
function seasonText(match: RegExpExecArray): string {
  const groups = match.groups ?? {};
  const named = groups.comp?.toUpperCase() ?? "RM";
  const comp = named === "ROBOMASTER" ? "RM" : named;
  const year = groups.year ?? groups.year3 ?? "";
  let out = comp;
  if (chars(year) === 2) out += "20";
  out += year;
  const year2 = groups.year2;
  if (year2 !== undefined) {
    // Keep the last two digits: `RM2021-2023` → `RM2021-23`.
    out += `-${[...year2].slice(Math.max(0, chars(year2) - 2)).join("")}`;
  }
  return out;
}
