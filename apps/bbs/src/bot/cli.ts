import { sql } from "drizzle-orm";

import { createDb } from "../db/index.ts";
import { selectSearchIndex } from "../db/search/index.ts";
import { createLibrary } from "../library/index.ts";
import { loadBotConfig } from "./config.ts";
import { systemClock } from "./contract.ts";
import { FeishuTransport } from "./feishu.ts";
import { runBot, BotStore } from "./index.ts";
import { acquireBotProcessLock } from "./lock.ts";

interface BotCliDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

function structuredLog(out: (line: string) => void) {
  return (event: string, fields: Record<string, unknown> = {}) =>
    out(JSON.stringify({ scope: "bbs-bot", event, ...fields }));
}

export async function runBotCli(argv: readonly string[], deps: BotCliDeps = {}): Promise<number> {
  if (argv.length) throw new TypeError("usage: bbs bot");
  const config = loadBotConfig(deps.env);
  const out = deps.out ?? console.log;
  const log = structuredLog(out);
  const db = await createDb(config.databaseUrl, { max: 2 });
  let lock: Awaited<ReturnType<typeof acquireBotProcessLock>> = null;
  const shutdown = new AbortController();
  const onSignal = () => shutdown.abort(new Error("shutdown"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await waitForBotSchema(db, shutdown.signal);
    lock = await acquireBotProcessLock(config.databaseUrl);
    if (!lock) {
      log("lock_busy");
      return 3;
    }
    const search = selectSearchIndex(config.searchIndex, async (query) => db.execute(query));
    const library = createLibrary({ db, search });
    const store = new BotStore({
      db,
      appOrigin: config.appOrigin,
      announcementChatId: config.announcementChatId,
      log,
    });
    const transport = new FeishuTransport({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
    });
    const lockLost = lock.lost.catch((error) => {
      shutdown.abort(error);
      throw error;
    });
    await Promise.race([
      runBot({ store, library, transport, signal: shutdown.signal, clock: systemClock, log }),
      lockLost,
    ]);
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await lock?.release();
    await db.close();
  }
}

async function waitForBotSchema(
  db: Awaited<ReturnType<typeof createDb>>,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let delay = 250;
  for (;;) {
    try {
      await db.execute(sql`SELECT 1 FROM bot_state LIMIT 0`);
      return;
    } catch (error) {
      if (signal.aborted || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(5_000, delay * 2);
    }
  }
}
