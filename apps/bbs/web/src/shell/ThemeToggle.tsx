/** One button, three states (跟随系统 → 浅色 → 深色). Lives in the header. */
import { Button } from "@herkules/ui/components/button";

import { themeLabel } from "./theme.ts";
import { useTheme } from "./useTheme.ts";

export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  return (
    <Button
      variant="outline"
      size="xs"
      className="font-mono text-muted-foreground"
      onClick={cycle}
      aria-label="切换主题"
    >
      {themeLabel(theme)}
    </Button>
  );
}
