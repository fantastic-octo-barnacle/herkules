import { describe, expect, test } from "vite-plus/test";
import { buildRegistry, type ResourceSpec } from "../src/registry.ts";

const origin = "https://herkules.dev";
const issuer = `${origin}/auth`;
const specs: ResourceSpec[] = [
  { name: "directory", kind: "mcp", title: "dir", canonical: true },
  { name: "notes", kind: "api", title: "notes", accessTokenTtlSeconds: 300 },
];

describe("buildRegistry", () => {
  test("derives audience, PRM URL and lookups", () => {
    const r = buildRegistry({ origin, issuer, specs });
    const dir = r.canonical;
    expect(dir).toMatchObject({
      name: "directory",
      pathname: "/mcp/directory",
      audience: "https://herkules.dev/mcp/directory",
      metadataUrl: "https://herkules.dev/.well-known/oauth-protected-resource/mcp/directory",
      metadataPathname: "/.well-known/oauth-protected-resource/mcp/directory",
      accessTokenTtlSeconds: 900,
      allowedScopes: ["offline_access"],
    });
    expect(r.byAudience("https://herkules.dev/api/notes")?.accessTokenTtlSeconds).toBe(300);
    expect(r.byMetadataPathname("/.well-known/oauth-protected-resource/api/notes")?.name).toBe(
      "notes",
    );
    expect(r.hasKnownAudience("https://herkules.dev/mcp/directory")).toBe(true);
    expect(r.hasKnownAudience(["https://x", "https://herkules.dev/api/notes"])).toBe(true);
    expect(r.hasKnownAudience("https://herkules.dev/mcp/directory/")).toBe(false);
    expect(r.hasKnownAudience(undefined)).toBe(false);
    expect([...r.audiences]).toHaveLength(2);
  });

  test("oauthResources and metadataFor", () => {
    const r = buildRegistry({ origin, issuer, specs });
    expect(r.oauthResources()).toEqual([
      {
        identifier: "https://herkules.dev/mcp/directory",
        name: "dir",
        accessTokenTtl: 900,
        allowedScopes: ["offline_access"],
      },
      {
        identifier: "https://herkules.dev/api/notes",
        name: "notes",
        accessTokenTtl: 300,
        allowedScopes: ["offline_access"],
      },
    ]);
    expect(r.metadataFor(r.canonical)).toEqual({
      resource: "https://herkules.dev/mcp/directory",
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: expect.arrayContaining(["ES256"]),
      scopes_supported: ["offline_access"],
      resource_name: "dir",
    });
  });

  test.each([
    [[{ name: "Dir", kind: "mcp", title: "x", canonical: true }], /bad resource name/],
    [[{ name: "a", kind: "mcp", title: "x" }], /exactly one/],
    [
      [
        { name: "a", kind: "mcp", title: "x", canonical: true },
        { name: "b", kind: "mcp", title: "y", canonical: true },
      ],
      /exactly one/,
    ],
    [[{ name: "a", kind: "api", title: "x", canonical: true }], /canonical must be an mcp/],
    [
      [
        { name: "a", kind: "mcp", title: "x", canonical: true },
        { name: "a", kind: "mcp", title: "x" },
      ],
      /duplicate/,
    ],
    [
      [{ name: "a", kind: "mcp", title: "x", canonical: true, accessTokenTtlSeconds: 3600 }],
      /only shorten/,
    ],
  ] as [ResourceSpec[], RegExp][])("boot failure: %j", (bad, message) => {
    expect(() => buildRegistry({ origin, issuer, specs: bad })).toThrow(message);
  });
});
