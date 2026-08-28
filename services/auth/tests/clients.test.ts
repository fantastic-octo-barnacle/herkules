import { describe, expect, test } from "vite-plus/test";
import { applyQuirks, registerBeforeHook, REDIRECT_ALLOW } from "../src/clients.ts";

describe("registration quirks", () => {
  test("application_type defaults to native; an explicit value is kept", () => {
    expect(applyQuirks({ redirect_uris: ["http://localhost:1234/cb"] })).toEqual({
      redirect_uris: ["http://localhost:1234/cb"],
      application_type: "native",
    });
    expect(
      applyQuirks({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        application_type: "web",
      }),
    ).toMatchObject({
      application_type: "web",
    });
  });

  test("every redirect_uri must match the allowlist", () => {
    expect(
      applyQuirks({ redirect_uris: ["http://127.0.0.1:9/cb", "https://evil.example/cb"] }),
    ).toEqual({
      error: "invalid_redirect_uri",
      error_description: "redirect_uri not permitted: https://evil.example/cb",
    });
    for (const ok of [
      "http://[::1]:5/cb",
      "https://vscode.dev/redirect?x=1",
      "vscode://ms.ext/cb",
    ]) {
      expect(
        REDIRECT_ALLOW.some((re) => re.test(ok)),
        ok,
      ).toBe(true);
    }
    expect(REDIRECT_ALLOW.some((re) => re.test("http://localhost.evil.example/cb"))).toBe(false);
  });

  test("registerBeforeHook rewrites the body or throws a 400", () => {
    expect(registerBeforeHook({ body: { redirect_uris: ["http://localhost:1/cb"] } })).toEqual({
      context: { body: { redirect_uris: ["http://localhost:1/cb"], application_type: "native" } },
    });
    expect(registerBeforeHook({ body: { client_name: "no uris" } })).toBeUndefined();
    expect(() =>
      registerBeforeHook({ body: { redirect_uris: ["https://evil.example/cb"] } }),
    ).toThrow(expect.objectContaining({ status: "BAD_REQUEST" }) as Error);
  });
});
