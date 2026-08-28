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

export type BbsDb = Omit<Drizzle, "transaction"> & {
  readonly host: "postgres" | "pglite";
  close(): Promise<void>;
  transaction<T>(fn: (tx: BbsDb) => Promise<T>): Promise<T>;
};

const EXPECTED_MIGRATION_NOTICE_CODES = new Set(["42P06", "42P07", "42710"]);

function attach(d: Drizzle, host: BbsDb["host"], close: () => Promise<void>): BbsDb {
  const nativeTransaction = d.transaction.bind(d);
  const db = d as unknown as BbsDb;
  Object.assign(db, {
    host,
    close,
    transaction: <T>(fn: (tx: BbsDb) => Promise<T>) =>
      nativeTransaction((tx) => fn(attach(tx as unknown as Drizzle, host, close))),
  });
  return db;
}

/** Boundary: DATABASE_URL -> a connected handle. TypeError on an unknown scheme, at boot. */
export async function createDb(databaseUrl: string): Promise<BbsDb> {
  if (databaseUrl.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = databaseUrl.slice("pglite://".length);
    const client =
      target === "memory" || target === ""
        ? new PGlite({ extensions: { pg_trgm } })
        : new PGlite(target, { extensions: { pg_trgm } });
    return attach(drizzle(client, { schema }) as unknown as Drizzle, "pglite", () =>
      client.close(),
    );
  }
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // max 5: the import's batches and the API share one pool; one container in v1.
    const client = postgres(databaseUrl, {
      max: 5,
      onnotice: (notice) => {
        if (!EXPECTED_MIGRATION_NOTICE_CODES.has(notice.code)) console.log(notice);
      },
    });
    return attach(drizzle(client, { schema }) as unknown as Drizzle, "postgres", () =>
      client.end(),
    );
  }
  throw new TypeError(`DATABASE_URL: unsupported scheme in ${databaseUrl}`);
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
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) return "skipped";
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || name === "postgres") return "skipped";
  const { default: postgres } = await import("postgres");
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.href, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    return "created";
  } catch (err) {
    if (isPgError(err) && err.code === "42P04") return "exists";
    throw err;
  } finally {
    await admin.end();
  }
}

function isPgError(err: unknown): err is { code: string } {
  return (
    typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
  );
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
  if (db.host === "pglite") {
    const { migrate: run } = await import("drizzle-orm/pglite/migrator");
    await run(db as never, { migrationsFolder });
  } else {
    const { migrate: run } = await import("drizzle-orm/postgres-js/migrator");
    await run(db as never, { migrationsFolder });
  }
}

/**
 * `db.execute(sql)` returns an array (postgres.js `RowList`) on one host and
 * `{ rows }` (PGlite `Results`) on the other. Every raw-SQL reader goes through
 * this so the difference exists in exactly one place. Prefer the query builder
 * (`db.select(...)`), which is uniform.
 */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export { schema };
