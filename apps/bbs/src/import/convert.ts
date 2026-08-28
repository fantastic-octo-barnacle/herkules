/**
 * SQLite value -> Postgres parameter -> canonical digest. Pure, no driver, no
 * schema knowledge. herkules-old's measured conversion core
 * (`migrate-sqlite.ts:473-565`) carried over close to verbatim — the one
 * artefact of that attempt proven against the real 49 MB snapshot (whole corpus
 * in 2.3 s, dry-run checksums equal to live-run checksums).
 *
 * The digest is ORDER-INDEPENDENT by construction: each row is hashed, the row
 * hashes are sorted, the sorted list is hashed. So "did every byte arrive?" is
 * answerable without caring what order `SELECT * FROM t` returns.
 *
 * `canonical()` normalises BOTH sides to the same shape, and the two sides come
 * through different type parsers. The driver risk herkules-old never faced is
 * that this repo runs postgres.js and PGlite, not `pg`:
 *   double precision may arrive as a string -> Number(v); jsonb reorders keys ->
 *   stableStringify; text[] parsing differs -> compared as a stable JSON array;
 *   timestamptz(3) -> Date -> toISOString(), exact to the millisecond.
 * One round-trip test per host is the only way to know (tests/import.test.ts).
 */
import { createHash } from "node:crypto";

export type Kind = "text" | "int" | "bool" | "ms" | "double" | "json" | "textarray";

export interface Column {
  readonly name: string; // identical in SQLite and Postgres
  readonly kind: Kind;
}

/** SQLite value -> bind parameter. Throws a TypeError naming table.column on malformed JSON or timestamps. */
export function convert(table: string, column: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const where = `${table}.${column.name}`;
  switch (column.kind) {
    case "text":
      return typeof value === "string" ? value : String(value as number | bigint);
    case "int":
    case "double":
      return Number(value);
    case "bool":
      return Number(value) !== 0;
    case "ms": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new TypeError(
          `${where}: timestamp ${String(value as number | bigint)} is not a number`,
        );
      }
      return new Date(n);
    }
    case "json":
      return JSON.stringify(parseJson(where, value));
    case "textarray": {
      const parsed = parseJson(where, value);
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
        throw new TypeError(`${where}: expected a JSON array of strings`);
      }
      return parsed as string[];
    }
  }
}

function parseJson(where: string, value: unknown): unknown {
  if (typeof value !== "string") throw new TypeError(`${where}: JSON column holds ${typeof value}`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${where}: invalid JSON (${(error as Error).message})`);
  }
}

/** Either side's value -> the string that goes into the row hash. */
export function canonical(column: Column, value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (column.kind) {
    case "text":
      return JSON.stringify(typeof value === "string" ? value : String(value as number | bigint));
    case "int":
    case "double":
      return String(Number(value));
    case "bool":
      return String(value === true || value === 1 || value === "t" || value === "true");
    case "ms":
      return (value instanceof Date ? value : new Date(value as string | number)).toISOString();
    case "json":
      return stableStringify(typeof value === "string" ? (JSON.parse(value) as unknown) : value);
    case "textarray":
      return stableStringify(typeof value === "string" ? parseTextArray(value) : value);
  }
}

/** postgres.js/PGlite return `text[]` as arrays; a raw `{a,b}` literal is parsed just in case. */
function parseTextArray(literal: string): unknown {
  if (literal.startsWith("[")) return JSON.parse(literal) as unknown;
  if (!literal.startsWith("{") || !literal.endsWith("}")) return literal;
  const body = literal.slice(1, -1);
  if (body === "") return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === "\\") cur += body[++i] ?? "";
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** JSON with object keys sorted, recursively. jsonb does not preserve key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Accumulates sha256 per row; `digest()` sorts the hex hashes and hashes the concatenation. */
export class TableDigest {
  private readonly digests: string[] = [];

  /** `values` are already canonical strings, in column order. */
  add(values: readonly string[]): void {
    this.digests.push(createHash("sha256").update(JSON.stringify(values)).digest("hex"));
  }

  get rows(): number {
    return this.digests.length;
  }

  digest(): string {
    const sorted = [...this.digests].sort();
    const hash = createHash("sha256");
    for (const d of sorted) hash.update(d);
    return hash.digest("hex");
  }
}
