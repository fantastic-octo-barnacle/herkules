/**
 * `overview_json` / `kb_json` / `images_json` -> Overview / KbEntry / ImageCaption.
 * Lenient on purpose: the model wrote these under several prompt versions, so
 * every field has a default, non-strings are dropped from string arrays, and an
 * unknown key is ignored. A malformed blob yields the empty shape, never a 500.
 * Pure; the only place the AI JSON layout is known. Key names are the model's
 * camelCase, verified against the snapshot (`keyPoints`, `robotTypes`, …).
 */
import { z } from "zod";

import type { ImageCaption, KbEntry, Overview } from "./types.ts";

/** A string, else dropped from its array. */
const strings = z
  .array(z.unknown())
  .catch([])
  .transform((xs) => xs.filter((x): x is string => typeof x === "string"));
const str = z.string().catch("");
/** `.optional()` first: zod v4 treats an absent key as a type error even for `unknown`. */
const strOrNull = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));
/** An array of objects parsed with `item`; non-objects and unparsable items are dropped. */
const objects = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs.flatMap((x) => {
        const r = item.safeParse(x);
        return r.success ? [r.data as z.output<T>] : [];
      }),
    );

const overviewSchema = z.object({
  genre: str,
  tldr: str,
  summary: str,
  keyPoints: strings,
  appliesWhen: strOrNull,
  package: strings,
  maturity: z.object({ status: str, evidence: strOrNull }).catch({ status: "", evidence: null }),
  caveats: strings,
  readingGuide: strOrNull,
  extras: z
    .object({
      quickStart: strings,
      portingChecklist: strings,
      compat: strings,
      lessons: objects(
        z.object({
          constraint: str,
          decision: str,
          outcome: strOrNull,
          transferable: strOrNull,
        }),
      ),
      thesis: strOrNull,
      arguments: objects(z.object({ claim: str, evidence: strOrNull })),
      actions: strings,
    })
    .catch({
      quickStart: [],
      portingChecklist: [],
      compat: [],
      lessons: [],
      thesis: null,
      arguments: [],
      actions: [],
    }),
  faq: objects(z.object({ question: str, answer: str, source: strOrNull })),
});

const kbSchema = z.object({
  domain: strings,
  robotTypes: strings,
  problem: strOrNull,
  approach: strOrNull,
  components: objects(
    z.object({ name: str, kind: strOrNull, spec: strOrNull, role: strOrNull, source: strOrNull }),
  ),
  parameters: objects(
    z.object({ name: str, value: str, unit: strOrNull, context: strOrNull, source: strOrNull }),
  ),
  interfaces: strings,
  toolchain: strings,
  designDecisions: objects(
    z.object({ decision: str, alternatives: strOrNull, rationale: strOrNull, source: strOrNull }),
  ),
  pitfalls: strings,
  cost: strOrNull,
  references: objects(z.object({ title: str, url: strOrNull, relation: strOrNull })),
  entities: strings,
  claims: objects(z.object({ claim: str, evidence: strOrNull, source: strOrNull })),
  openQuestions: strings,
  searchKeywords: strings,
});

const captionSchema = z.object({
  index: z.number().int().catch(0),
  kind: strOrNull,
  caption: str,
  textInImage: strOrNull,
  facts: strings,
});

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseOverview(json: unknown): Overview | null {
  const v = typeof json === "string" ? tryJson(json) : json;
  if (!isObject(v)) return null;
  const r = overviewSchema.safeParse(v);
  return r.success ? r.data : null;
}

export function parseKbEntry(json: unknown): KbEntry | null {
  const v = typeof json === "string" ? tryJson(json) : json;
  if (!isObject(v)) return null;
  const r = kbSchema.safeParse(v);
  return r.success ? r.data : null;
}

export function parseImageCaptions(json: unknown): readonly ImageCaption[] {
  const v = typeof json === "string" ? tryJson(json) : json;
  if (!Array.isArray(v)) return [];
  return objects(captionSchema).parse(v);
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
