/**
 * Composition root. The only file that knows every module. Boot order is
 * the dependency order; nothing here has logic.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchClientMetadataResource as nodeFetchClientMetadataResource } from "@better-auth/cimd/node";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";

import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createAvatars } from "./avatars.ts";
import { createBearer } from "./bearer.ts";
import { ensureFirstPartyClients, pruneIdleClients } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { createDb, migrate } from "./db/index.ts";
import { createMerges } from "./db/merges.ts";
import { createGate } from "./gate.ts";
import { createFeishu } from "./feishu.ts";
import { createGithubApi } from "./github.ts";
import { buildRegistry, RESOURCE_SPECS, type ResourceSpec } from "./registry.ts";
import type { Users } from "./users.ts";
import { createUsers } from "./users.ts";
import { ensureSigningKeys } from "./signing.ts";

export interface ServiceDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** GitHub transport seam (github.ts). */
  readonly fetch?: typeof globalThis.fetch;
  /** CIMD document transport seam. Production uses the resolve-once, address-pinning Node guard. */
  readonly fetchClientMetadataResource?: ClientMetadataResourceFetch;
  readonly now?: () => Date;
  /** Registry override for tests. Production uses RESOURCE_SPECS. */
  readonly resources?: readonly ResourceSpec[];
}

const DAY_MS = 86_400_000;

/** Builds the whole service without listening. testing.ts calls this with a fake fetch and clock. */
export async function createService(deps: ServiceDeps = {}) {
  const config = loadConfig(deps.env);
  const now = deps.now ?? (() => new Date());
  const db = await createDb(config.DATABASE_URL);
  await migrate(db);
  const registry = buildRegistry({
    origin: config.PUBLIC_ORIGIN,
    issuer: config.issuer,
    specs: deps.resources ?? RESOURCE_SPECS,
  });
  const github = createGithubApi({ fetch: deps.fetch });
  const audit = createAudit(db, now);
  const merges = createMerges(db, audit, now);
  const gate = createGate({ config, db, github, audit, now });

  // onLogin needs users; users needs auth: break the cycle with a late-bound closure.
  let users: Users;
  const feishu = createFeishu({
    config,
    db,
    audit,
    now,
    fetch: deps.fetch,
    accessToken: async (userId): Promise<string> => {
      const accountId = await db.accounts.feishuAccountId(userId);
      if (!accountId) throw new Error("Feishu account missing");
      return (await auth.api.getAccessToken({ body: { accountId, userId } })).accessToken;
    },
  });
  const auth = createAuth({
    merges,
    config,
    db,
    registry,
    gate,
    audit,
    github,
    feishu,
    now,
    onLogin: (id) => users.onLogin(id),
    fetchClientMetadataResource:
      deps.fetchClientMetadataResource ?? nodeFetchClientMetadataResource,
  });
  const avatars = createAvatars({
    dir: config.AVATAR_DIR,
    issuer: config.issuer,
    github,
    sourceUrlOf: (id) => db.users.imageOf(id),
  });
  users = createUsers({
    db,
    audit,
    auth,
    avatarUrlFor: (id) => avatars.urlFor(id),
    refreshAvatar: async (id) => avatars.refresh(id, await db.users.imageOf(id)),
    adminGithubLogins: config.ADMIN_GITHUB_LOGINS,
    now,
  });
  await users.reconcileEnvAdmins(); // seed, never demote
  const bearer = createBearer(auth, registry, config.issuer, db);
  await ensureFirstPartyClients(db, config, now);
  await ensureSigningKeys(auth, config.issuer);

  const prune = () =>
    pruneIdleClients(
      db,
      audit,
      { kind: "system", job: "dcr-prune" },
      new Date(now().getTime() - config.DCR_PRUNE_AFTER * 1000),
    );
  await prune();

  const healthy = async () => {
    await db.execute(sql`select 1`);
    return (await auth.api.getJwks()).keys.length > 0;
  };
  const app = createApp({ config, auth, registry, users, bearer, avatars, healthy, merges });
  return { app, auth, db, config, registry, users, audit, bearer, prune, close: () => db.close() };
}

export async function main(): Promise<void> {
  const service = await createService();
  setInterval(
    () => void service.prune().catch((err) => console.error("dcr-prune failed", err)),
    DAY_MS,
  ).unref();
  const server = serve({ fetch: service.app.fetch, port: service.config.PORT }, (info) => {
    console.log(`herkules auth listening on :${info.port} as ${service.config.issuer}`);
  });
  // Docker stops the container with SIGTERM: stop accepting, then hand the
  // Postgres pool back before the runtime kills the process.
  const shutdown = () => {
    server.close();
    void service.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
