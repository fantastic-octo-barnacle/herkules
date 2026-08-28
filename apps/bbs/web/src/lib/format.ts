import type { ArticleDTO } from "../../../src/api/dto.ts";

/**
 * Presentation of domain scalars. Every date the SPA shows is Asia/Shanghai:
 * the corpus is a Chinese forum, and a reader in another zone comparing a
 * date against the source post must see the source's day, not their own.
 */

const ZONE = "Asia/Shanghai";

/** `sv-SE` is the locale whose short numeric date already IS `YYYY-MM-DD`. */
const DAY = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: ZONE,
});

/** Shown wherever a date is missing, so a meta line keeps its column count. */
export const NO_DATE = "—";

/** `2026-08-20` in Asia/Shanghai. `null` (and an unparseable string) render as `—`. */
export function formatDate(iso: string | null): string {
  if (!iso) return NO_DATE;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return NO_DATE;
  return DAY.format(ms);
}

/**
 * `820 字` / `3.5k 字` / `1.2万字`, and the same scale for 链接 / 图.
 * Zero renders as the empty string: the meta line drops the whole segment
 * rather than printing `0 图` (rm-wenku's `charsText` rule, generalised).
 */
export function formatCount(n: number, unit: "字" | "链接" | "图"): string {
  if (!n) return "";
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万${unit}`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k ${unit}`;
  return `${n} ${unit}`;
}

/**
 * The resource list's badge for a link. Exhaustive over `LinkKind` — the wire
 * keeps the literal union, so a new kind is a compile error here, not an
 * untranslated string in the UI.
 */
export function linkKindText(kind: ArticleDTO["links"][number]["kind"]): string {
  switch (kind) {
    case "repository":
      return "仓库";
    case "document":
      return "文档";
    case "download":
      return "下载";
    case "video":
      return "视频";
    case "cloud_drive":
      return "网盘";
    case "other":
      return "链接";
    default: {
      const never: never = kind;
      return never;
    }
  }
}
