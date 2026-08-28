/**
 * `overview_json` / `kb_json` / `images_json` -> Overview / KbEntry / ImageCaption.
 * Lenient on purpose: the model wrote these under several prompt versions, so
 * every field has a default, non-strings are dropped from string arrays, and an
 * unknown key is ignored. A malformed blob yields the empty shape, never a 500.
 * Pure; the only place the AI JSON layout is known.
 */
import type { ImageCaption, KbEntry, Overview } from "./types.ts";

export function parseOverview(json: unknown): Overview | null {
  void json;
  // TODO zod schema with `.catch(default)` per field; null when `json` is not an object
  throw new Error("not implemented");
}

export function parseKbEntry(json: unknown): KbEntry | null {
  void json;
  throw new Error("not implemented");
}

export function parseImageCaptions(json: unknown): readonly ImageCaption[] {
  void json;
  throw new Error("not implemented");
}
