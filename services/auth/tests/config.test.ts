/** `loadConfig`'s boot-time refusal of configurations that fail silently at request time. */
import { describe, expect, test } from "vite-plus/test";

import { loadConfig } from "../src/config.ts";

/** The minimum a parse needs; individual tests override one key. */
const base = {
  PUBLIC_ORIGIN: "https://herkules.dev",
  AUTH_SECRET: "t".repeat(32),
  DATABASE_URL: "pglite://memory",
  GITHUB_CLIENT_ID: "c",
  GITHUB_CLIENT_SECRET: "s",
  GITHUB_ORG: "org",
};

describe("loadConfig", () => {
  test("derives the issuer and strips the origin", () => {
    const config = loadConfig(base);
    expect(config.issuer).toBe("https://herkules.dev/auth");
    expect(config.isProduction).toBe(false);
  });

  test("derives `isProduction` from NODE_ENV", () => {
    expect(loadConfig({ ...base, NODE_ENV: "production" }).isProduction).toBe(true);
  });

  test("refuses an http PUBLIC_ORIGIN in production", () => {
    // `useSecureCookies` follows isProduction, so the cookie would never come
    // back and sign-in would loop with no explanation. Boot is where the
    // variable name is still visible.
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", PUBLIC_ORIGIN: "http://herkules.dev" }),
    ).toThrow(/PUBLIC_ORIGIN must be https in production/);
    // The same origin is fine outside production, where the dev stack uses http.
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: "http://localhost:3000" }).isProduction).toBe(
      false,
    );
  });

  test("still refuses half-configured optional clients", () => {
    expect(() => loadConfig({ ...base, BBS_ORIGIN: "https://bbs.herkules.dev" })).toThrow(
      /BBS_ORIGIN and BBS_CLIENT_SECRET must be set together/,
    );
    // An empty secret is "not set", so this is the together check, not a length error.
    expect(() => loadConfig({ ...base, CLOUDFLARE_TEAM_NAME: "team" })).toThrow(
      /CLOUDFLARE_TEAM_NAME and CLOUDFLARE_CLIENT_SECRET must be set together/,
    );
  });
});
