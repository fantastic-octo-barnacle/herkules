/**
 * The three-state theme, as pure functions. System is the default (the tokens
 * already answer `prefers-color-scheme`); the header toggle is an override for
 * readers who prefer the other one. No DOM, no React, no module state: the hook
 * and the boot script are the only things that touch a real document.
 */

export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "bbs:theme";

/**
 * Anything that is not a stored override — no value, a stale value, a storage
 * that throws (private mode, blocked site data) — is "system". Reading the
 * theme must never be a reason a page fails to render.
 */
export function readTheme(storage: Pick<Storage, "getItem"> | null): Theme {
  if (!storage) return "system";
  try {
    const value = storage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** One button, three states: 跟随系统 → 浅色 → 深色 → 跟随系统. */
export function nextTheme(theme: Theme): Theme {
  switch (theme) {
    case "system":
      return "light";
    case "light":
      return "dark";
    case "dark":
      return "system";
  }
}

export function themeLabel(theme: Theme): string {
  switch (theme) {
    case "system":
      return "跟随系统";
    case "light":
      return "浅色";
    case "dark":
      return "深色";
  }
}

/**
 * Apply a theme to `<html>`. `data-theme` is ABSENT for system (the CSS guards
 * its dark block as `:root:not([data-theme="light"])`, so an empty attribute
 * would not mean the same thing), and `style.colorScheme` is cleared with it so
 * form controls follow the OS again.
 */
export function applyTheme(
  root: { dataset: DOMStringMap; style: { colorScheme: string } },
  theme: Theme,
): void {
  if (theme === "system") {
    delete root.dataset.theme;
    root.style.colorScheme = "";
    return;
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * The pre-paint script `index.html` embeds (outside the head-marker block, which
 * round 1's server rewrites wholesale). It lives here as a string so a test can
 * prove it parses and so the storage key has exactly one definition. It must not
 * reference anything: it runs before the bundle.
 */
export const THEME_BOOT_SCRIPT = `try {
  var t = localStorage.getItem(${JSON.stringify(THEME_KEY)});
  if (t === "light" || t === "dark") { document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t; }
} catch (e) {}`;
