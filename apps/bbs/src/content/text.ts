/**
 * wenku-core text.rs + hash.rs + lib.rs::clean_text. Character-counted (code
 * points), never byte- or UTF-16-sliced: rm-wenku compared `chars().count()`
 * against min_body_chars, and a CJK body is ~3x shorter in code points than
 * `.length` suggests.
 */
import { createHash } from "node:crypto";

/** Collapse every whitespace run to one space; trim both ends. */
export function cleanText(input: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of input) {
    if (/\s/u.test(ch)) {
      pendingSpace = out.length > 0;
    } else {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      out += ch;
    }
  }
  return out;
}

/** First `max` code points, unchanged when it already fits. */
export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** `clipChars` with `…` appended whenever something was cut. Used for last_error / poll_runs.error (500). */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** Code-point count. */
export function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Lower-case hex SHA-256. content_hash (of body_text) AND url_hash (of canonical_url) — rm-wenku used one function for both. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
