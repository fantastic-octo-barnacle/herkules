import { describe, expect, test } from "vite-plus/test";
import { jwksUrlFor, resourceMetadataUrlFor, validateResource } from "../src/resource.ts";

describe("validateResource", () => {
  test("canonicalizes: trailing slash stripped, default port dropped, host lower-cased", () => {
    expect(validateResource("https://Herkules.dev:443/mcp/directory/", "mcp")).toBe(
      "https://herkules.dev/mcp/directory",
    );
    expect(validateResource("https://herkules.dev/", "api")).toBe("https://herkules.dev");
  });
  test("mcp: https or loopback http only", () => {
    expect(validateResource("http://localhost:3000/mcp/directory", "mcp")).toBe(
      "http://localhost:3000/mcp/directory",
    );
    expect(validateResource("http://127.0.0.1:3000/mcp/x", "mcp")).toBe(
      "http://127.0.0.1:3000/mcp/x",
    );
    expect(validateResource("http://[::1]:3000/mcp/x", "mcp")).toBe("http://[::1]:3000/mcp/x");
    expect(() => validateResource("http://herkules.dev/mcp/directory", "mcp")).toThrow(TypeError);
    expect(validateResource("http://herkules.dev/api/x", "api")).toBe("http://herkules.dev/api/x");
  });
  test.each([
    "https://user:pw@herkules.dev/mcp/x",
    "https://herkules.dev/mcp/x?y=1",
    "https://herkules.dev/mcp/x?",
    "https://herkules.dev/mcp/x#frag",
    "ftp://herkules.dev/mcp/x",
    "/mcp/x",
    "not a url",
  ])("rejects %s", (bad) => {
    expect(() => validateResource(bad, "api")).toThrow(TypeError);
  });
});

test("resourceMetadataUrlFor inserts the well-known path after the origin", () => {
  expect(resourceMetadataUrlFor("https://herkules.dev/mcp/directory")).toBe(
    "https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory",
  );
  expect(resourceMetadataUrlFor("http://localhost:3000/api/x/")).toBe(
    "http://localhost:3000/.well-known/oauth-protected-resource/api/x",
  );
  expect(resourceMetadataUrlFor("https://herkules.dev")).toBe(
    "https://herkules.dev/.well-known/oauth-protected-resource",
  );
});

test("jwksUrlFor", () => {
  expect(jwksUrlFor("https://herkules.dev/auth")).toBe("https://herkules.dev/auth/jwks");
  expect(jwksUrlFor("http://localhost:3000/auth/")).toBe("http://localhost:3000/auth/jwks");
  expect(() => jwksUrlFor("herkules.dev/auth")).toThrow(TypeError);
});
