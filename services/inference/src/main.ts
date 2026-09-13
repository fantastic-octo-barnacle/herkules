import { Plans } from "./plans.ts";
import postgres from "postgres";
import { loadConfig } from "./config.ts";
import { NewAPI } from "./new-api.ts";
import { Membership } from "./membership.ts";
import { createGateway } from "./gateway.ts";
const config = await loadConfig();
const admin = new NewAPI(config.NEW_API_URL, config.rootPassword);
await admin.bootstrap(config);
const plans = config.AI_PLANS_ENABLED === "true" ? new Plans(admin) : undefined;
await plans?.bootstrap();
const membership = new Membership(config, admin);
await membership.reconcile();
const sql = postgres(config.AI_METADATA_DATABASE_URL, { max: 2, onnotice: () => {} });
await sql`SELECT user_id FROM herkules_token_identity LIMIT 0`;
const gateway = createGateway({
  config,
  membership,
  plans,
  identifyKey: async (hash) => {
    const rows = await sql<
      { user_id: number }[]
    >`SELECT user_id FROM herkules_token_identity WHERE key_hash = ${hash}`;
    return rows[0]?.user_id;
  },
});
let syncing = false;
const interval = setInterval(async () => {
  if (syncing) return;
  syncing = true;
  try {
    await admin.login();
    await membership.reconcile();
  } catch {
    console.error("AI membership reconciliation failed; gateway closes when freshness expires");
  } finally {
    syncing = false;
  }
}, 30_000);
gateway.internal.listen(config.INTERNAL_PORT, "0.0.0.0");
gateway.public.listen(config.PORT, process.env.LISTEN_HOST ?? "0.0.0.0", () =>
  console.log("AI gateway ready"),
);
async function stop() {
  clearInterval(interval);
  gateway.public.close();
  gateway.internal.close();
  await admin.logout();
  await sql.end({ timeout: 5 });
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
