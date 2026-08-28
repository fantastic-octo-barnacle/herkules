/**
 * Rendering decisions for the AI overview. `maturity.status` and `genre` are
 * free text from the model (round 1 kept them as `string`, not unions), so both
 * functions are total over `string` and fall back rather than switch.
 */
import type { ArticleAiDTO } from "../../../src/api/dto.ts";

/**
 * Pill class for a maturity status. The empty string means "do not show it":
 * an unrecognised status is more likely a model artefact than a fact worth a
 * badge (rm-wenku's rule, kept).
 */
export function maturityClass(status: string): string {
  switch (status) {
    case "上场验证":
      return "pill ok";
    case "测试通过":
      return "pill info";
    case "原型":
    case "未完成":
      return "pill warn";
    case "未知":
      return "pill";
    default:
      return "";
  }
}

export interface SectionLabels {
  /** `null` is reserved for a genre with no package section; today every genre has one. */
  readonly package: string | null;
  readonly appliesWhen: string;
  readonly keyPoints: string;
  readonly caveats: string;
}

const DEFAULT_LABELS: SectionLabels = {
  package: "内容",
  appliesWhen: "适用",
  keyPoints: "要点",
  caveats: "注意",
};

/** Only the labels that differ from the default, per genre. */
const BY_GENRE: Record<string, Partial<SectionLabels>> = {
  "算法/库": { package: "仓库里有什么" },
  "工具/应用": { package: "获取与安装", caveats: "限制" },
  "工程实践/复盘": { appliesWhen: "照搬前提", caveats: "前提" },
  "观点/经验": { appliesWhen: "适合谁读", caveats: "作者的保留" },
  "公告/其他": { appliesWhen: "面向谁" },
};

/** How the overview card titles its sections for this genre; unknown genres get the defaults. */
export function sectionLabels(genre: string): SectionLabels {
  return { ...DEFAULT_LABELS, ...BY_GENRE[genre] };
}

/**
 * Is there anything to put in the 规格 panel? The gate exists because rm-wenku
 * showed an empty panel (and its dock button) for every article with a KB row
 * whose lists all happened to be empty.
 */
export function hasContent(kb: ArticleAiDTO["kb"]): boolean {
  if (!kb) return false;
  return (
    kb.parameters.length > 0 ||
    kb.components.length > 0 ||
    kb.interfaces.length > 0 ||
    kb.toolchain.length > 0 ||
    kb.designDecisions.length > 0 ||
    kb.pitfalls.length > 0 ||
    kb.references.length > 0 ||
    kb.entities.length > 0 ||
    kb.claims.length > 0 ||
    kb.openQuestions.length > 0 ||
    kb.domain.length > 0 ||
    kb.robotTypes.length > 0 ||
    kb.problem !== null ||
    kb.approach !== null ||
    kb.cost !== null
  );
}
