/** The theme module is pure: these tests pass fake storage and a fake root element. */
import { Script } from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  THEME_BOOT_SCRIPT,
  THEME_KEY,
  applyTheme,
  nextTheme,
  readTheme,
  themeLabel,
} from "../src/shell/theme.ts";

const storageOf = (value: string | null) => ({ getItem: () => value });

describe("readTheme", () => {
  it("reads the two overrides", () => {
    expect(readTheme(storageOf("light"))).toBe("light");
    expect(readTheme(storageOf("dark"))).toBe("dark");
  });

  it("is system for anything else", () => {
    expect(readTheme(storageOf(null))).toBe("system");
    expect(readTheme(storageOf("solarized"))).toBe("system");
    expect(readTheme(null)).toBe("system");
  });

  it("survives a storage that throws", () => {
    expect(
      readTheme({
        getItem() {
          throw new Error("SecurityError");
        },
      }),
    ).toBe("system");
  });
});

describe("nextTheme", () => {
  it("cycles system -> light -> dark -> system", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
    expect(themeLabel("system")).toBe("跟随系统");
    expect(themeLabel("light")).toBe("浅色");
    expect(themeLabel("dark")).toBe("深色");
  });
});

describe("applyTheme", () => {
  const root = () => ({
    dataset: {} as Record<string, string | undefined>,
    style: { colorScheme: "x" },
  });

  it("sets data-theme and colorScheme for an override", () => {
    const el = root();
    applyTheme(el, "dark");
    expect(el.dataset.theme).toBe("dark");
    expect(el.style.colorScheme).toBe("dark");
  });

  it("REMOVES the attribute for system (an empty one would match [data-theme])", () => {
    const el = root();
    applyTheme(el, "light");
    applyTheme(el, "system");
    expect("theme" in el.dataset).toBe(false);
    expect(el.style.colorScheme).toBe("");
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  it("parses as a script and names the storage key once", () => {
    // The string index.html inlines must be parseable JavaScript. `new Script`
    // compiles without running (and without tripping the no-implied-eval rule
    // that `new Function` would).
    expect(() => new Script(THEME_BOOT_SCRIPT)).not.toThrow();
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_KEY));
    expect(THEME_BOOT_SCRIPT.split("\n").length).toBeLessThanOrEqual(4);
  });
});
