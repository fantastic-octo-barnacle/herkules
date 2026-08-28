/**
 * Test harness. Two facts decide its whole shape:
 *
 *  1. PGlite 0.5.8 ships `pg_trgm` as a constructor extension; `createDb` passes
 *     it, so this file only points `DATABASE_URL` at `pglite://memory`.
 *  2. `fetchVia` is the repo's whole test architecture: one in-process Hono app's
 *     `fetch` becomes another service's outbound transport. bbs keeps the seam
 *     (`ServiceDeps.fetch`), so a bbs test drives the REAL auth service on
 *     PGlite via `@herkules/auth/testing`, and the fast suites use
 *     `@herkules/oauth-client/testing`'s `createFakeIssuer()` instead.
 *
 * WHAT RUNS WHERE
 *   PGlite, in CI, no Docker — everything: the migration incl. both GIN trigram
 *   indexes and both alignment CHECKs; the full import from a fixture app.db,
 *   twice (no-op) and with a delta; every Library method; search recall, ranking
 *   order and snippet markers; cursor round-trips; the API over `app.request()`
 *   anonymous and signed in; MCP over an in-process SDK client incl. the
 *   wrong-audience 401; head injection against a fixture index.html; the renderer's
 *   adversarial cases.
 *   Real Postgres, opt-in via BBS_TEST_DATABASE_URL (`describe.skipIf`) — only what
 *   PGlite cannot answer: EXPLAIN uses `article_search_document_trgm` and
 *   `articles_feed_idx`; postgres.js type parsers agree with `canonical()`.
 *   Neither — a script, `vp run relevance`: the 20-query golden set against a dump
 *   named by BBS_GOLDEN_DB (the corpus is not checked in; a permanently skipped
 *   test would rot).
 *
 * THE SQLITE FIXTURE: `tests/fixtures/sqlite/000{1..6}.sql` are copies of rm-wenku's
 * migrations, executed with `node:sqlite` to build a real FTS5 database, seeded
 * with ~12 articles of realistic Chinese content: a pinned row, a `skipped` row
 * with a NULL body, full-width punctuation and 【】 (the fold cases), markdown and
 * HTML sources (the renderer cases), an `article_ai` row with domain/robotTypes/
 * genre, two entities, and an `ai_usage` row whose `user_id` matches no user.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";

/** Route a fetch to an in-process Hono app (any origin). Copied from services/mcp-directory. */
export function fetchVia(app: { request: Hono["request"] }): typeof globalThis.fetch {
  return async (input, init) => app.request(input instanceof Request ? input : String(input), init);
}

/** An SDK 2.0 client connected over an in-process fetch with a Bearer token. */
export async function connect(
  url: string,
  token: string | undefined,
  fetch: typeof globalThis.fetch,
) {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch,
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

export interface TestBbs {
  readonly app: Hono;
  /** `fetch(path, init & { cookie? })` against the bbs app. */
  fetch(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  /** Signs a browser in through the issuer and returns the session cookie. */
  signIn(subject?: string): Promise<{ cookie: string; subject: string }>;
  /** A bearer token for `${origin}/mcp/bbs`, or for another audience to test rejection. */
  token(audience?: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Boots: the issuer (`createFakeIssuer()` by default; `{ realIssuer: true }` uses
 * `@herkules/auth/testing` with `bbs` seeded in FIRST_PARTY_CLIENTS), then the
 * bbs service on its own PGlite with `deps.fetch` routed in-process, then imports
 * the fixture `app.db`. One call, because a test that wires five things wires
 * them differently each time.
 */
export function createTestBbs(options?: {
  realIssuer?: boolean;
  importFixture?: boolean;
}): Promise<TestBbs> {
  void options;
  throw new Error("not implemented");
}
