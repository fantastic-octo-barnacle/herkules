import { describe, expect, it } from "vite-plus/test";
import { safeNext } from "../src/session.tsx";

describe("post-login navigation", () => {
  it.each([
    null,
    "",
    "https://outside.example/",
    "//outside.example/",
    "/\\outside.example/",
    "/\\/outside.example/",
    "/\noutside.example/",
    "/\t/outside.example/",
  ])("rejects an unsafe continuation: %s", (value) => expect(safeNext(value)).toBe("/"));
  it.each(["/", "/settings", "/oauth2/continue?state=signed%2Bvalue#next"])(
    "preserves a local continuation: %s",
    (value) => expect(safeNext(value)).toBe(value),
  );
});
