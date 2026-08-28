/** The conversion core: canonical forms agree across type parsers; the digest ignores row order. */
import { describe, expect, it } from "vite-plus/test";

import { TableDigest, canonical, convert, stableStringify } from "../src/import/convert.ts";
import { parseUserMap } from "../src/import/tables.ts";

describe("convert", () => {
  it("maps SQLite values to Postgres parameters", () => {
    expect(convert("t", { name: "a", kind: "ms" }, 1767225600000)).toEqual(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(convert("t", { name: "a", kind: "bool" }, 1)).toBe(true);
    expect(convert("t", { name: "a", kind: "bool" }, 0)).toBe(false);
    expect(convert("t", { name: "a", kind: "int" }, 7n)).toBe(7);
    expect(convert("t", { name: "a", kind: "double" }, "0.5")).toBe(0.5);
    expect(convert("t", { name: "a", kind: "json" }, '{"b":1,"a":[2]}')).toBe('{"b":1,"a":[2]}');
    expect(convert("t", { name: "a", kind: "textarray" }, '["x","y"]')).toEqual(["x", "y"]);
    expect(convert("t", { name: "a", kind: "text" }, null)).toBeNull();
    expect(() => convert("t", { name: "a", kind: "json" }, "{nope")).toThrow(/t\.a: invalid JSON/);
    expect(() => convert("t", { name: "a", kind: "textarray" }, "[1]")).toThrow(/array of strings/);
    expect(() => convert("t", { name: "a", kind: "ms" }, "soon")).toThrow(/t\.a: timestamp/);
  });
});

describe("canonical", () => {
  it("reaches the same string from both sides of the round trip", () => {
    const ms = { name: "a", kind: "ms" } as const;
    expect(canonical(ms, 1767225600123)).toBe(canonical(ms, new Date(1767225600123)));
    expect(canonical(ms, "2026-01-01T00:00:00.123Z")).toBe(canonical(ms, 1767225600123));
    const json = { name: "a", kind: "json" } as const;
    expect(canonical(json, '{"b":1,"a":{"d":2,"c":[3]}}')).toBe(
      canonical(json, { a: { c: [3], d: 2 }, b: 1 }),
    );
    const arr = { name: "a", kind: "textarray" } as const;
    expect(canonical(arr, ["x", "y,z"])).toBe(canonical(arr, '{x,"y,z"}'));
    expect(canonical(arr, [])).toBe(canonical(arr, "{}"));
    const dbl = { name: "a", kind: "double" } as const;
    expect(canonical(dbl, "0.0123")).toBe(canonical(dbl, 0.0123));
    const bool = { name: "a", kind: "bool" } as const;
    expect(canonical(bool, true)).toBe(canonical(bool, 1));
    expect(canonical(bool, false)).toBe(canonical(bool, 0));
    expect(canonical({ name: "a", kind: "text" }, null)).toBe("null");
    // A NULL and the string "null" must not collide.
    expect(canonical({ name: "a", kind: "text" }, "null")).not.toBe("null");
  });
});

describe("stableStringify", () => {
  it("sorts object keys recursively", () => {
    expect(stableStringify({ b: [{ z: 1, y: 2 }], a: null })).toBe(
      '{"a":null,"b":[{"y":2,"z":1}]}',
    );
    expect(stableStringify(undefined)).toBe("null");
  });
});

describe("TableDigest", () => {
  it("is order-independent and content-sensitive", () => {
    const a = new TableDigest();
    a.add(["1", '"x"']);
    a.add(["2", '"y"']);
    const b = new TableDigest();
    b.add(["2", '"y"']);
    b.add(["1", '"x"']);
    expect(a.digest()).toBe(b.digest());
    expect(a.rows).toBe(2);
    const c = new TableDigest();
    c.add(["1", '"x"']);
    c.add(["2", '"z"']);
    expect(c.digest()).not.toBe(a.digest());
  });
});

describe("parseUserMap", () => {
  it("parses repeatable old=sub pairs and rejects malformed ones", () => {
    expect([...parseUserMap(["a=b", " c = d "])]).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(() => parseUserMap(["nope"])).toThrow(/--user-map/);
    expect(() => parseUserMap(["=x"])).toThrow(/--user-map/);
  });
});
