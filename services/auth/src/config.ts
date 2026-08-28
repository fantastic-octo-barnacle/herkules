/**
 * Boundary: process.env -> Config. The only file that reads the environment.
 * Everything downstream receives a validated `Config`; nothing else parses
 * strings. Per boundary-discipline: fail at boot, never at request time.
 * Resources are NOT configured here — see registry.ts.
 */
import { z } from "zod";

const DAY = 86_400;

export const configSchema = z.object({
  /** Public origin of the single-origin deployment, e.g. https://herkules.dev or http://localhost:3000. */
  PUBLIC_ORIGIN: z.string().url(),
  /** Better Auth secret: cookie signing, oauth_query HMAC, private JWK encryption. */
  AUTH_SECRET: z.string().min(32),
  /** postgres://... in compose; `pglite://memory` or `pglite:///path` in tests/dev. */
  DATABASE_URL: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  /** The controlled org whose active members are admitted. */
  GITHUB_ORG: z.string().min(1),
  /**
   * SEED admins by GitHub login. Promotes at boot and at first login; never
   * demotes — the `user.role` column owns the role after that (users.ts).
   */
  ADMIN_GITHUB_LOGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Volume path for cached avatars. */
  AVATAR_DIR: z.string().default("/data/avatars"),
  PORT: z.coerce.number().int().positive().default(3001),
  /** Caddy's address(es) for X-Forwarded-For trust; empty in tests. */
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  /** Seconds a grant may reuse the last gate verdict before re-asking GitHub. */
  GATE_RECHECK_TTL: z.coerce.number().int().positive().default(600),
  /** Seconds a prior allow may be kept when GitHub is unreachable at grant time; beyond it the grant is rejected. */
  GATE_STALE_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(1 * DAY),
  /** Unused DCR clients older than this are pruned. */
  DCR_PRUNE_AFTER: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * DAY),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * apps/bbs's public origin, e.g. https://bbs.herkules.dev (dev: http://localhost:3003).
   * Set: the confidential first-party `bbs` client is seeded with `${BBS_ORIGIN}/callback`.
   * Unset (or empty): not seeded. Both BBS_* variables or neither.
   */
  BBS_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** The `bbs` client's secret (>= 32 chars), stored hashed; the same value goes in apps/bbs's env. */
  BBS_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
});

function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

export type Config = z.infer<typeof configSchema> & {
  /** `${PUBLIC_ORIGIN}/auth` — the `iss`, the Better Auth baseURL, the JWKS origin. Derived, never configured. */
  readonly issuer: string;
  readonly isProduction: boolean;
};

/**
 * @throws ZodError with every missing/invalid variable listed at once.
 * Derived fields are computed here so there is exactly one place that knows `/auth`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);
  const origin = new URL(parsed.PUBLIC_ORIGIN).origin;
  if ((parsed.BBS_ORIGIN === undefined) !== (parsed.BBS_CLIENT_SECRET === undefined)) {
    throw new TypeError("BBS_ORIGIN and BBS_CLIENT_SECRET must be set together or not at all");
  }
  return Object.freeze({
    ...parsed,
    PUBLIC_ORIGIN: origin,
    BBS_ORIGIN: parsed.BBS_ORIGIN === undefined ? undefined : new URL(parsed.BBS_ORIGIN).origin,
    issuer: `${origin}/auth`,
    isProduction: parsed.NODE_ENV === "production",
  });
}
