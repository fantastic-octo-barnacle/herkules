/**
 * Derived values for the knowledge-base pages. Ported from rm-wenku's
 * `kb/model.ts` minus its href builders (TanStack `<Link search>` owns URLs now)
 * and minus `kbTitle` (round 1's DTOs carry `titleParts`, so the client no
 * longer re-parses the bracket convention).
 *
 * The tallies come from the browse CARDS, not from `/api/kb/entities`: the
 * counts must agree with what the page is showing under the current facets.
 */
import type { EntityDetailDTO, KbBrowseDTO } from "../../../src/api/dto.ts";

/** The pitfall feed is a teaser, not an index; more than this scrolls past the cards. */
export const PITFALL_LIMIT = 14;

export interface EntityTally {
  readonly name: string;
  readonly count: number;
}

/**
 * One item from each list before a second from any, so a single verbose
 * article cannot fill the feed. Generic: the caller decides what a "list" is
 * (the KB page passes each card's pitfalls, paired with its card).
 */
export function roundRobin<T>(lists: readonly (readonly T[])[], limit: number): readonly T[] {
  const out: T[] = [];
  for (let round = 0; out.length < limit; round += 1) {
    let added = false;
    for (const list of lists) {
      const item = list[round];
      if (item === undefined) continue;
      out.push(item);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break; // every list is exhausted
  }
  return out;
}

/**
 * Lower-cased letters and digits only — the same fold the server's
 * `entityKey()` applies, so a client tally keys the same way `/kb/:name` does.
 */
export function normalizeEntity(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * How many cards mention each entity, counted once per card and
 * case/punctuation-insensitively (`OpenCV`, `opencv`, `Open-CV` are one).
 * Most mentioned first, ties by name.
 */
export function countEntities(cards: KbBrowseDTO["cards"]): readonly EntityTally[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const card of cards) {
    const seen = new Set<string>();
    for (const name of card.entities) {
      const key = normalizeEntity(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { name, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
}

/**
 * 常见条目 (two or more cards) and 全部条目 (the alphabetical tail). The
 * threshold is rm-wenku's: at one mention a tally says nothing about the corpus.
 */
export function splitEntities(tallies: readonly EntityTally[]): {
  common: readonly EntityTally[];
  rest: readonly EntityTally[];
} {
  return {
    common: tallies.filter((e) => e.count >= 2),
    rest: tallies
      .filter((e) => e.count < 2)
      .toSorted((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
  };
}

export interface EntitySections {
  readonly comparison: readonly {
    articleId: string;
    title: string;
    name: string;
    value: string;
    unit: string | null;
    context: string | null;
  }[];
  readonly otherParameters: readonly {
    articleId: string;
    title: string;
    name: string;
    value: string;
    unit: string | null;
  }[];
  readonly asComponent: readonly {
    articleId: string;
    title: string;
    role: string | null;
    spec: string | null;
  }[];
  readonly decisions: readonly {
    articleId: string;
    title: string;
    decision: string;
    rationale: string | null;
  }[];
  readonly pitfalls: readonly { articleId: string; title: string; pitfall: string }[];
}

/** Does `text` name the entity, under the same fold as the key? */
function mentions(text: string, key: string): boolean {
  return key.length > 0 && normalizeEntity(text).includes(key);
}

/**
 * Everything in the entity's articles that talks about it, flattened into the
 * page's five sections. `key` is the folded key (`EntityCount.key`), not the
 * display name. Parameters split two ways: those naming the entity are the
 * 参数对比 table (the reason the page exists), the rest are context.
 */
export function entitySections(key: string, articles: EntityDetailDTO["articles"]): EntitySections {
  const comparison: EntitySections["comparison"][number][] = [];
  const otherParameters: EntitySections["otherParameters"][number][] = [];
  const asComponent: EntitySections["asComponent"][number][] = [];
  const decisions: EntitySections["decisions"][number][] = [];
  const pitfalls: EntitySections["pitfalls"][number][] = [];

  for (const { articleId, title, kb } of articles) {
    for (const p of kb.parameters) {
      if (mentions(`${p.name} ${p.context ?? ""}`, key)) {
        comparison.push({
          articleId,
          title,
          name: p.name,
          value: p.value,
          unit: p.unit,
          context: p.context,
        });
      } else {
        otherParameters.push({ articleId, title, name: p.name, value: p.value, unit: p.unit });
      }
    }
    for (const c of kb.components) {
      if (mentions(`${c.name} ${c.spec ?? ""} ${c.role ?? ""}`, key)) {
        asComponent.push({ articleId, title, role: c.role, spec: c.spec });
      }
    }
    for (const d of kb.designDecisions) {
      if (mentions(`${d.decision} ${d.alternatives ?? ""} ${d.rationale ?? ""}`, key)) {
        decisions.push({ articleId, title, decision: d.decision, rationale: d.rationale });
      }
    }
    for (const pitfall of kb.pitfalls) {
      if (mentions(pitfall, key)) pitfalls.push({ articleId, title, pitfall });
    }
  }
  return { comparison, otherParameters, asComponent, decisions, pitfalls };
}
