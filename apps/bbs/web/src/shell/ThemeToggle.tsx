/** One button, three states (跟随系统 → 浅色 → 深色). Lives in the header. */
import { themeLabel } from "./theme.ts";
import { useTheme } from "./useTheme.ts";

export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  return (
    <button type="button" className="shell-theme" onClick={cycle} aria-label="切换主题">
      {themeLabel(theme)}
    </button>
  );
}
