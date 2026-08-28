/**
 * The only stateful half of the theme: React state seeded from storage, applied
 * to `<html>` and written back. `theme.ts` stays pure so the boot script, the
 * hook and the tests all agree on one storage key and one attribute rule.
 */
import { useCallback, useEffect, useState } from "react";

import { applyTheme, nextTheme, readTheme, THEME_KEY, type Theme } from "./theme.ts";

/** Storage can throw outright (blocked site data), not just return null. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useTheme(): { theme: Theme; cycle: () => void } {
  // Lazy initial state: the boot script already applied this value, so the first
  // render agrees with the DOM and nothing flashes.
  const [theme, setTheme] = useState<Theme>(() => readTheme(storage()));

  useEffect(() => {
    applyTheme(document.documentElement, theme);
    try {
      // System is the ABSENCE of a choice — storing "system" would freeze today's
      // default into a reader's browser forever.
      if (theme === "system") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The choice still applies to this page; it just will not survive a reload.
    }
  }, [theme]);

  const cycle = useCallback(() => setTheme(nextTheme), []);
  return { theme, cycle };
}
