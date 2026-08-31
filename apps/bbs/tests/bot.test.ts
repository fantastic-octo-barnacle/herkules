import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseCommand } from "../src/bot/command.ts";
import type { IncomingMessage } from "../src/bot/contract.ts";
import {
  classifyFeishuError,
  classifyFeishuResponse,
  redactFeishuSdkLog,
  safeFeishuConnectionError,
} from "../src/bot/feishu.ts";
import { acquireBotProcessLock } from "../src/bot/lock.ts";
import { BotStore } from "../src/bot/store.ts";
import { digestDueAt, hongKongDay } from "../src/bot/time.ts";
import { createDb, migrate, rowsOf } from "../src/db/index.ts";
import type { BbsDb } from "../src/db/index.ts";
import { articleSearch, articles, sources } from "../src/db/schema.ts";
import { buildDocument } from "../src/import/derive.ts";
import { fakeLibrary } from "./helpers.ts";

const APP_ORIGIN = "https://bbs.example.test";
const CHAT_ID = "oc_announcement";
const ACTIVATION = new Date("2026-08-30T00:00:00.000Z");

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "om_1",
    chatId: "oc_chat",
    chatType: "p2p",
    content: "PID 整定",
    rawContentType: "text",
    mentionedBot: false,
    createTime: ACTIVATION.getTime(),
    ...overrides,
  };
}

describe("bot commands and time", () => {
  it("requires a group mention and explicit group command, while DM text searches", () => {
    expect(parseCommand(message({ chatType: "group", content: "搜索 PID" }))).toEqual({
      kind: "ignore",
    });
    expect(
      parseCommand(message({ chatType: "group", mentionedBot: true, content: "搜索 PID" })),
    ).toEqual({ kind: "search", query: "PID" });
    expect(parseCommand(message())).toEqual({ kind: "search", query: "PID 整定" });
    expect(parseCommand(message({ content: "help" }))).toEqual({ kind: "help" });
    expect(parseCommand(message({ content: "x".repeat(201) }))).toEqual({
      kind: "invalid",
      reason: "too_long",
    });
  });

  it("uses Hong Kong calendar days and the following 09:00", () => {
    expect(hongKongDay(new Date("2026-08-30T15:59:59.999Z"))).toBe("2026-08-30");
    expect(hongKongDay(new Date("2026-08-30T16:00:00.000Z"))).toBe("2026-08-31");
    expect(digestDueAt("2026-08-30").toISOString()).toBe("2026-08-31T01:00:00.000Z");
  });

  it("classifies provider rejection separately from an ambiguous network loss", () => {
    expect(classifyFeishuError({ response: { status: 429, data: { code: 99991400 } } })).toEqual({
      kind: "not_sent",
      code: "99991400",
      retryAfterMs: undefined,
    });
    expect(classifyFeishuError(new Error("socket reset"))).toEqual({
      kind: "ambiguous",
      code: "transport_error",
    });
    expect(classifyFeishuError({ response: { status: 403 } })).toEqual({
      kind: "permanent",
      code: "transport_error",
      fatal: true,
    });
    expect(classifyFeishuResponse(230001)).toEqual({
      kind: "permanent",
      code: "230001",
      fatal: false,
    });
  });

  it("drops SDK request details from connection errors", () => {
    const error = safeFeishuConnectionError({
      code: "not_connected",
      cause: { config: { data: '{"app_secret":"do-not-log"}' } },
    });
    expect(error.message).toBe("Feishu connection failed: not_connected");
    expect(error).not.toHaveProperty("cause");
  });

  it("keeps SDK diagnostics while redacting credentials", () => {
    const log = redactFeishuSdkLog(
      {
        code: "ENOTFOUND",
        hostname: "open.feishu.cn",
        config: {
          data: '{"app_id":"cli_test","app_secret":"development-secret"}',
          headers: { authorization: "Bearer tenant-token", cookie: "session=value" },
        },
      },
      "development-secret",
    );
    const text = JSON.stringify(log);
    expect(text).toContain("ENOTFOUND");
    expect(text).toContain("open.feishu.cn");
    expect(text).not.toContain("development-secret");
    expect(text).not.toContain("tenant-token");
    expect(text).not.toContain("session=value");
  });
});

describe("durable bot store", () => {
  let db: BbsDb;
  let store: BotStore;

  beforeEach(async () => {
    db = await createDb("pglite://memory");
    await migrate(db);
    await db.insert(sources).values({
      id: "src",
      kind: "bbs",
      name: "RM 论坛",
      siteUrl: "https://bbs.robomaster.com",
      createdAt: ACTIVATION,
      updatedAt: ACTIVATION,
    });
    store = new BotStore({
      db,
      appOrigin: APP_ORIGIN,
      announcementChatId: CHAT_ID,
      random: () => 0,
    });
  });

  afterEach(() => db.close());

  it("baselines existing rows, assigns three immediate items, then seals one digest", async () => {
    await addArticle(db, 0, new Date("2026-08-29T23:00:00.000Z"));
    expect(await store.activateAndBaseline(ACTIVATION)).toBe(true);
    expect(await store.activateAndBaseline(new Date(ACTIVATION.getTime() + 1_000))).toBe(false);

    for (let index = 1; index <= 4; index++) {
      await addArticle(db, index, new Date(ACTIVATION.getTime() + index * 60_000));
    }
    const assignedAt = new Date("2026-08-30T00:30:00.000Z");
    expect(await store.reconcile(assignedAt)).toMatchObject({ immediate: 3, overflow: 1 });

    const decisions = rowsOf(
      await db.execute(sql`
        SELECT status, immediate_slot FROM bot_article_decisions
        WHERE status IN ('immediate', 'overflow') ORDER BY source_article_id
      `),
    );
    expect(decisions.map((row) => [row.status, row.immediate_slot])).toEqual([
      ["immediate", 1],
      ["immediate", 2],
      ["immediate", 3],
      ["overflow", null],
    ]);

    for (let index = 0; index < 3; index++) {
      const delivery = await store.leaseNext(assignedAt);
      expect(delivery?.kind).toBe("article");
      await store.settle(delivery!, { kind: "sent", messageId: `om_article_${index}` }, assignedAt);
    }
    expect(await store.leaseNext(assignedAt)).toBeNull();

    const digestTime = digestDueAt("2026-08-30");
    expect(await store.reconcile(digestTime)).toMatchObject({ digests: 1 });
    const digest = await store.leaseNext(digestTime);
    expect(digest?.kind).toBe("digest");
    expect(JSON.parse(digest!.content).text).toContain("Article 4");
    expect(JSON.parse(digest!.content).text).not.toContain("Article 3");

    await addArticle(db, 5, new Date(digestTime.getTime() + 60_000));
    expect(await store.reconcile(new Date(digestTime.getTime() + 120_000))).toMatchObject({
      immediate: 1,
      overflow: 0,
    });
  });

  it("turns an expired unfinished attempt ambiguous and keeps its UUID across retry", async () => {
    await store.activateAndBaseline(ACTIVATION);
    await addArticle(db, 1, new Date(ACTIVATION.getTime() + 60_000));
    const at = new Date(ACTIVATION.getTime() + 120_000);
    await store.reconcile(at);
    const first = await store.leaseNext(at);
    expect(first).not.toBeNull();

    const recoveredAt = new Date(at.getTime() + 121_000);
    await store.reconcile(recoveredAt);
    const retry = await store.leaseNext(recoveredAt);
    expect(retry?.uuid).toBe(first?.uuid);
    expect(retry?.attemptNo).toBe(2);

    await store.settle(first!, { kind: "sent", messageId: "om_late_success" }, recoveredAt);
    await store.settle(retry!, { kind: "ambiguous", code: "timeout" }, recoveredAt);
    const delivery = rowsOf(
      await db.execute(sql`SELECT state, feishu_message_id FROM bot_deliveries`),
    )[0];
    expect(delivery).toMatchObject({ state: "sent", feishu_message_id: "om_late_success" });
    const attempts = rowsOf(
      await db.execute(sql`SELECT outcome FROM bot_delivery_attempts ORDER BY attempt_no`),
    );
    expect(attempts.map((row) => row.outcome)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("deduplicates inbound messages and freezes replies from the shared Library search", async () => {
    await store.activateAndBaseline(ACTIVATION);
    expect(
      await store.accept(
        message({ chatType: "group", mentionedBot: false, content: "搜索 PID" }),
        ACTIVATION,
      ),
    ).toBe("ignored");
    expect(await store.accept(message(), ACTIVATION)).toBe("accepted");
    expect(await store.accept(message(), ACTIVATION)).toBe("duplicate");

    const library = fakeLibrary();
    expect(await store.planNextReply(library, ACTIVATION)).toBe(true);
    expect(library.calls).toEqual(["search"]);
    const reply = await store.leaseNext(ACTIVATION);
    expect(reply?.kind).toBe("reply");
    expect(reply?.replyToMessageId).toBe("om_1");
    const text = JSON.parse(reply!.content).text as string;
    expect(text).toContain("PID 整定经验");
    expect(text).toContain(`${APP_ORIGIN}/articles/`);
  });
});

describe("bot restart recovery", () => {
  it("reopens a file-backed database and retries the same frozen delivery UUID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bbs-bot-"));
    const databaseUrl = `pglite://${directory}`;
    let persisted = await createDb(databaseUrl);
    try {
      await migrate(persisted);
      await persisted.insert(sources).values({
        id: "src",
        kind: "bbs",
        name: "RM 论坛",
        siteUrl: "https://bbs.robomaster.com",
        createdAt: ACTIVATION,
        updatedAt: ACTIVATION,
      });
      let persistedStore = new BotStore({
        db: persisted,
        appOrigin: APP_ORIGIN,
        announcementChatId: CHAT_ID,
        random: () => 0,
      });
      await persistedStore.activateAndBaseline(ACTIVATION);
      await addArticle(persisted, 1, new Date(ACTIVATION.getTime() + 60_000));
      const startedAt = new Date(ACTIVATION.getTime() + 120_000);
      await persistedStore.reconcile(startedAt);
      const beforeRestart = await persistedStore.leaseNext(startedAt);
      await persisted.close();

      persisted = await createDb(databaseUrl);
      persistedStore = new BotStore({
        db: persisted,
        appOrigin: APP_ORIGIN,
        announcementChatId: CHAT_ID,
        random: () => 0,
      });
      const recoveredAt = new Date(startedAt.getTime() + 121_000);
      await persistedStore.reconcile(recoveredAt);
      const afterRestart = await persistedStore.leaseNext(recoveredAt);
      expect(afterRestart?.uuid).toBe(beforeRestart?.uuid);
      expect(afterRestart?.attemptNo).toBe(2);
    } finally {
      await persisted.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const REAL_POSTGRES = process.env.BBS_TEST_DATABASE_URL;

describe.skipIf(!REAL_POSTGRES)("bot on real Postgres", () => {
  it("holds a dedicated advisory lock and serializes competing quota assignment", async () => {
    const databaseUrl = REAL_POSTGRES!;
    const firstLock = await acquireBotProcessLock(databaseUrl);
    expect(firstLock).not.toBeNull();
    expect(await acquireBotProcessLock(databaseUrl)).toBeNull();
    await firstLock!.release();
    const reacquired = await acquireBotProcessLock(databaseUrl);
    expect(reacquired).not.toBeNull();
    await reacquired!.release();

    const postgresDb = await createDb(databaseUrl);
    try {
      await migrate(postgresDb);
      await postgresDb.insert(sources).values({
        id: "src",
        kind: "bbs",
        name: "RM 论坛",
        siteUrl: "https://bbs.robomaster.com",
        createdAt: ACTIVATION,
        updatedAt: ACTIVATION,
      });
      const firstStore = new BotStore({
        db: postgresDb,
        appOrigin: APP_ORIGIN,
        announcementChatId: CHAT_ID,
        random: () => 0,
      });
      const secondStore = new BotStore({
        db: postgresDb,
        appOrigin: APP_ORIGIN,
        announcementChatId: CHAT_ID,
        random: () => 0,
      });
      await firstStore.activateAndBaseline(ACTIVATION);
      for (let index = 1; index <= 4; index++) {
        await addArticle(postgresDb, index, new Date(ACTIVATION.getTime() + index * 60_000));
      }
      await Promise.all([
        firstStore.reconcile(new Date(ACTIVATION.getTime() + 300_000)),
        secondStore.reconcile(new Date(ACTIVATION.getTime() + 300_000)),
      ]);
      const decisions = rowsOf(
        await postgresDb.execute(sql`
          SELECT status, count(*)::int AS count FROM bot_article_decisions
          WHERE status IN ('immediate', 'overflow') GROUP BY status ORDER BY status
        `),
      );
      expect(decisions).toEqual([
        { status: "immediate", count: 3 },
        { status: "overflow", count: 1 },
      ]);
    } finally {
      await postgresDb.close();
    }
  });
});

async function addArticle(db: BbsDb, index: number, publishedAt: Date): Promise<void> {
  const id = `01J000000000000000000000${index.toString(16).toUpperCase()}`.padEnd(26, "0");
  const title = `Article ${index}`;
  const body = `PID body ${index}`;
  await db.insert(articles).values({
    id,
    sourceId: "src",
    sourceArticleId: String(index),
    canonicalUrl: `https://bbs.robomaster.com/article/${index}`,
    urlHash: `hash-${index}`,
    title,
    publishedAt,
    discoveredAt: publishedAt,
    fetchedAt: publishedAt,
    introduction: `Excerpt ${index}`,
    bodyText: body,
    contentFormat: "markdown",
    contentRaw: body,
    contentHtml: `<p>${body}</p>`,
    status: "fetched",
    createdAt: publishedAt,
    updatedAt: publishedAt,
  });
  await db.insert(articleSearch).values({
    articleId: id,
    title,
    author: "",
    tags: "",
    introduction: `Excerpt ${index}`,
    bodyText: body,
    document: buildDocument([title, "", "", `Excerpt ${index}`, body]),
  });
}
