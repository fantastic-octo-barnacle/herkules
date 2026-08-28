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
 * One round-trip test per host is the only way to know (tests/helpers.ts).
 */
export type Kind = "text" | "int" | "bool" | "ms" | "double" | "json" | "textarray";

export interface Column {
  readonly name: string; // identical in SQLite and Postgres
  readonly kind: Kind;
}

/** SQLite value -> bind parameter. Throws a typed error naming table.column on malformed JSON. */
export function convert(table: string, column: Column, value: unknown): unknown {
  void table;
  void column;
  void value;
  // TODO ms -> Number.isFinite(n) ? new Date(n) : null; bool -> value == null ? null : Boolean(value)
  //      int|double -> Number(value); json -> JSON.stringify(JSON.parse(String(value)))
  //      textarray -> JSON.parse, reject unless every element is a string; text -> value
  throw new Error("not implemented");
}

/** Either side's value -> the string that goes into the row hash. */
export function canonical(column: Column, value: unknown): string {
  void column;
  void value;
  throw new Error("not implemented");
}

/** JSON with object keys sorted, recursively. jsonb does not preserve key order. */
export function stableStringify(value: unknown): string {
  void value;
  throw new Error("not implemented");
}

/** Accumulates sha256 per row; `digest()` sorts the hex hashes and hashes the concatenation. */
export class TableDigest {
  add(values: readonly unknown[]): void {
    void values;
    throw new Error("not implemented");
  }
  get rows(): number {
    throw new Error("not implemented");
  }
  digest(): string {
    throw new Error("not implemented");
  }
}
