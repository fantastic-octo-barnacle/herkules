import { describe, expect, test } from "vite-plus/test";
import { createSealer, SEAL_VERSION } from "../src/seal.ts";

const SECRET = "x".repeat(32);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

describe("createSealer", () => {
  test("round-trips both purposes; every seal is unique", async () => {
    const sealer = createSealer(SECRET, "bbs");
    const a = await sealer.seal("session", bytes("hello"));
    const b = await sealer.seal("session", bytes("hello"));
    expect(a.startsWith(`${SEAL_VERSION}.`)).toBe(true);
    expect(a).not.toBe(b);
    expect(text(await sealer.open("session", a))).toBe("hello");
    expect(text(await sealer.open("session", b))).toBe("hello");
    const l = await sealer.seal("login", bytes("{}"));
    expect(text(await sealer.open("login", l))).toBe("{}");
  });

  test("wrong purpose does not open", async () => {
    const sealer = createSealer(SECRET, "bbs");
    const sealed = await sealer.seal("login", bytes("attempts"));
    expect(await sealer.open("session", sealed)).toBeUndefined();
  });

  test("wrong secret or wrong salt does not open", async () => {
    const sealed = await createSealer(SECRET, "bbs").seal("session", bytes("t"));
    expect(await createSealer("y".repeat(32), "bbs").open("session", sealed)).toBeUndefined();
    expect(await createSealer(SECRET, "other-app").open("session", sealed)).toBeUndefined();
  });

  test("a flipped byte, an unknown version and garbage all read as undefined", async () => {
    const sealer = createSealer(SECRET, "bbs");
    const sealed = await sealer.seal("session", bytes("tokens"));
    const body = sealed.slice(SEAL_VERSION.length + 1);
    const i = 20;
    const flipped = body.slice(0, i) + (body[i] === "A" ? "B" : "A") + body.slice(i + 1);
    expect(await sealer.open("session", `${SEAL_VERSION}.${flipped}`)).toBeUndefined();
    expect(await sealer.open("session", `v2.${body}`)).toBeUndefined();
    expect(await sealer.open("session", body)).toBeUndefined();
    expect(await sealer.open("session", "")).toBeUndefined();
    expect(await sealer.open("session", `${SEAL_VERSION}.AAAA`)).toBeUndefined();
  });

  test("refuses a short secret or an empty salt at construction", () => {
    expect(() => createSealer("short", "bbs")).toThrow(TypeError);
    expect(() => createSealer(SECRET, "")).toThrow(TypeError);
  });
});
