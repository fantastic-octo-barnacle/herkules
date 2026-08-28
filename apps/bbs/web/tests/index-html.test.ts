/**
 * The boot script lives in two places by necessity — a string in theme.ts (so the
 * key has one definition and a test can parse it) and inline in index.html (so it
 * runs before the bundle). This test is what keeps them from drifting.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { THEME_BOOT_SCRIPT } from "../src/shell/theme.ts";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/**
 * `vp check` reindents the inline script, so the two copies can never be equal
 * byte for byte. Collapsing runs of whitespace still catches every drift that
 * matters — a changed storage key, a changed attribute, a dropped try/catch —
 * because oxfmt only ever changes whitespace between the tokens.
 */
const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
const flatHtml = squeeze(html);
const flatScript = squeeze(THEME_BOOT_SCRIPT);

describe("index.html", () => {
  it("embeds THEME_BOOT_SCRIPT", () => {
    expect(flatHtml).toContain(flatScript);
  });

  it("keeps the head-marker block, in order, after the boot script", () => {
    const open = flatHtml.indexOf("<!--bbs:head-->");
    const close = flatHtml.indexOf("<!--/bbs:head-->");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    // The server rewrites everything between the markers: the boot script must be outside them.
    expect(flatHtml.indexOf(flatScript)).toBeLessThan(open);
  });
});
