/**
 * ONE engine in two hosts, copied from services/auth/src/db/index.ts:
 *   postgres://…    -> `postgres` (postgres.js) driver, compose/prod
 *   pglite://memory -> @electric-sql/pglite in-process, tests/dev
 *   pglite:///path  -> PGlite persisted
 *
 * The one addition over auth: PGlite is constructed with the `pg_trgm` contrib
 * module (`@electric-sql/pglite/contrib/pg_trgm`, present in 0.5.8), because
 * `drizzle/0000_*.sql` begins with `CREATE EXTENSION IF NOT EXISTS pg_trgm` and
 * a bare `new PGlite()` fails it (FRAME verification 3).
 *
 * `BbsDb` is the drizzle handle plus `host`, `close` and a `transaction` that
 * hands out the same type. Unlike AuthDb it carries NO named queries: the read
 * side is src/library (which composes multi-table reads and owns cursors and
 * ranking) and the write side is src/import (which owns one transaction).
 * Placeholders are `$n` on both hosts; `?` is not special to either driver.
 */
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "./schema.ts";

export type Drizzle = PgDatabase<PgQueryResultHKT, typeof schema>;

export type BbsDb = Drizzle & {
  readonly host: "postgres" | "pglite";
  close(): Promise<void>;
  transaction<T>(fn: (tx: BbsDb) => Promise<T>): Promise<T>;
};

/** Boundary: DATABASE_URL -> a connected handle. TypeError on an unknown scheme, at boot. */
export async function createDb(databaseUrl: string): Promise<BbsDb> {
  void databaseUrl;
  // TODO pglite://  -> const { PGlite } = await import("@electric-sql/pglite")
  //                    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")
  //                    target === "memory" ? new PGlite({ extensions: { pg_trgm } }) : new PGlite(target, { extensions: { pg_trgm } })
  //                    + drizzle-orm/pglite; close = client.close()
  //      postgres:// | postgresql:// -> postgres(url, { max: 5 }) + drizzle-orm/postgres-js; close = sql.end()
  //      (max 5: the import's batches and the API share one pool; one container in v1)
  //      anything else -> throw new TypeError(`DATABASE_URL: unsupported scheme in ${databaseUrl}`)
  //      Both drivers are dynamically imported so the unused one never loads (auth does the same).
  //      attach(): db.transaction wraps the native one so `tx` is a BbsDb too.
  throw new Error("not implemented");
}

/**
 * Creates the `bbs` database if it is missing, by connecting to the same
 * server's `postgres` maintenance database with the same credentials.
 *
 * Exists because nothing in tools/deploy creates a second database: no
 * `/docker-entrypoint-initdb.d` mount, and an initdb script would not run on the
 * already-initialised `pgdata` volume anyway. The alternative — a documented
 * one-off `docker compose exec postgres createdb -U herkules bbs` — is the ops
 * step that gets forgotten exactly once, on the night of the first deploy.
 *
 * Idempotent by construction: a `CREATE DATABASE` race surfaces as SQLSTATE
 * 42P04 and is treated as success. No-op for `pglite://`. Skipped when
 * `BBS_CREATE_DATABASE=false` (the day the role loses CREATEDB).
 */
export async function ensureDatabase(
  databaseUrl: string,
): Promise<"created" | "exists" | "skipped"> {
  void databaseUrl;
  // TODO if (!/^postgres(ql)?:/.test(databaseUrl)) return "skipped"
  //      url = new URL(databaseUrl); name = decodeURIComponent(url.pathname.slice(1))
  //      if (!name || name === "postgres") return "skipped"
  //      admin = postgres({ ...url, pathname: "/postgres" }.href, { max: 1 })
  //      try { await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`); return "created" }
  //      catch (e) { if (e.code === "42P04") return "exists"; throw e } finally { await admin.end() }
  throw new Error("not implemented");
}

/**
 * Applies apps/bbs/drizzle/*.sql at boot (main.ts) and before an import
 * (import/cli.ts). The migrator journals in `__drizzle_migrations`; v1 runs one
 * container, so no advisory lock is taken (services/auth made the same call).
 * The Dockerfile sets MIGRATIONS_DIR=/app/drizzle.
 */
export async function migrate(
  db: BbsDb,
  migrationsFolder = process.env.MIGRATIONS_DIR ??
    fileURLToPath(new URL("../../drizzle", import.meta.url)),
): Promise<void> {
  void db;
  void migrationsFolder;
  // TODO db.host === "pglite" ? drizzle-orm/pglite/migrator : drizzle-orm/postgres-js/migrator, as auth does
  throw new Error("not implemented");
}

export { schema };
