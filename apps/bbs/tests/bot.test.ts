import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Card } from "../src/bot/cards.ts";
import { md } from "../src/bot/cards.ts";
import {
  actionReceiptId,
  parseAction,
  parseCommand,
  parseMenuCommand,
} from "../src/bot/command.ts";
import type { SearchAction } from "../src/bot/command.ts";
import type { Inbound, IncomingMessage, OutboundEnvelope } from "../src/bot/contract.ts";
import {
  FeishuTransport,
  classifyFeishuError,
  classifyFeishuResponse,
  parseFeishuMenuEvent,
  redactFeishuSdkLog,
  safeFeishuConnectionError,
} from "../src/bot/feishu.ts";
import { presentArticle, presentSearch, snippetMarkdown } from "../src/bot/present.ts";
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

function inbound(overrides: Partial<IncomingMessage> = {}): Inbound {
  return { kind: "message", message: message(overrides) };
}

function cardOf(envelope: OutboundEnvelope | null | undefined): Card {
  expect(envelope?.msgType).toBe("interactive");
  return JSON.parse(envelope!.content) as Card;
}

/** Every markdown element's text, plus every button's value, flattened for assertions. */
function cardText(card: Card): string {
  return JSON.stringify(card.body.elements);
}

function buttons(card: Card): { text: string; value?: unknown; url?: string }[] {
  const found: { text: string; value?: unknown; url?: string }[] = [];
  const walk = (element: unknown) => {
    if (!element || typeof element !== "object") return;
    const node = element as Record<string, unknown>;
    if (node.tag === "button") {
      const behavior = (node.behaviors as Record<string, unknown>[])[0]!;
      found.push({
        text: (node.text as { content: string }).content,
        value: behavior.value,
        url: behavior.default_url as string | undefined,
      });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk);
    }
  };
  card.body.elements.forEach(walk);
  return found;
}

describe("bot commands and time", () => {
  it("requires a group mention and explicit group command, while DM text searches", () => {
    expect(parseCommand(message({ chatType: "group", content: "搜索 PID" }))).toEqual({
      kind: "ignore",
    });
    expect(
      parseCommand(message({ chatType: "group", mentionedBot: true, content: "搜索 PID" })),
    ).toEqual({ kind: "search", query: "PID", scope: "all" });
    expect(
      parseCommand(message({ chatType: "group", mentionedBot: true, content: "PID 整定" })),
    ).toEqual({ kind: "ignore" });
    expect(parseCommand(message())).toEqual({ kind: "search", query: "PID 整定", scope: "all" });
    expect(parseCommand(message({ content: "help" }))).toEqual({ kind: "help" });
    expect(parseCommand(message({ content: "x".repeat(201) }))).toEqual({
      kind: "invalid",
      reason: "too_long",
    });
  });

  it("parses slash commands, scopes, aliases and unknown names", () => {
    expect(parseCommand(message({ content: "/search 云台 PID" }))).toEqual({
      kind: "search",
      query: "云台 PID",
      scope: "all",
    });
    expect(parseCommand(message({ content: "/title 步兵" }))).toEqual({
      kind: "search",
      query: "步兵",
      scope: "title",
    });
    expect(parseCommand(message({ content: "/kb HPM5361" }))).toEqual({
      kind: "search",
      query: "HPM5361",
      scope: "kb",
    });
    expect(parseCommand(message({ content: "搜索步兵" }))).toEqual({
      kind: "search",
      query: "步兵",
      scope: "all",
    });
    // Only the legacy bare aliases act as commands without a slash.
    for (const content of ["标题 步兵", "latest news", "status update", "t motors", "h"]) {
      expect(parseCommand(message({ content }))).toEqual({
        kind: "search",
        query: content,
        scope: "all",
      });
    }
    expect(parseCommand(message({ content: "帮助" }))).toEqual({ kind: "help" });
    expect(parseCommand(message({ content: "/latest" }))).toEqual({ kind: "latest" });
    expect(parseCommand(message({ content: "/Status" }))).toEqual({ kind: "status" });
    expect(parseCommand(message({ content: "/search" }))).toEqual({
      kind: "invalid",
      reason: "empty",
    });
    expect(parseCommand(message({ content: "/whoami" }))).toEqual({
      kind: "unknown",
      name: "whoami",
    });
    // A latin alias needs whitespace after it, so this DM is a phrase search.
    expect(parseCommand(message({ content: "searching motors" }))).toEqual({
      kind: "search",
      query: "searching motors",
      scope: "all",
    });
    expect(parseMenuCommand("latest")).toEqual({ kind: "latest" });
    expect(parseMenuCommand("search")).toEqual({ kind: "help" });
    expect(parseMenuCommand("nope")).toEqual({ kind: "unknown", name: "nope" });
  });

  it("validates card button values and keys their receipts per render", () => {
    const action: SearchAction = {
      v: 1,
      cmd: "search",
      q: "PID",
      scope: "all",
      trail: ["c1"],
      chatType: "p2p",
      nonce: "abc",
    };
    expect(parseAction(action)).toEqual(action);
    expect(parseAction({ ...action, scope: "body" })).toBeNull();
    expect(parseAction("next")).toBeNull();
    expect(actionReceiptId("om_card", action)).toBe("action:om_card:abc:1");
    expect(
      parseFeishuMenuEvent({
        operator: { operator_id: { open_id: "ou_1" } },
        event_key: "latest",
        timestamp: "1700",
      }),
    ).toEqual({
      operatorOpenId: "ou_1",
      eventKey: "latest",
      timestamp: 1700,
    });
    expect(parseFeishuMenuEvent({ event_key: "latest" })).toBeNull();
    expect(
      parseFeishuMenuEvent({
        operator: { operator_id: { open_id: "oc_chat" } },
        event_key: "latest",
      }),
    ).toBeNull();
    expect(
      parseFeishuMenuEvent({
        operator: { operator_id: { open_id: "ou_1" } },
        event_key: "x".repeat(65),
      }),
    ).toBeNull();
  });

  it("renders search results as a card with bold hits and paging buttons", async () => {
    const hit = (await fakeLibrary().search({ q: "PID", limit: 5 })).items[0]!;
    const page = {
      items: [
        {
          ...hit,
          title: "带 [1] 标记 *和* <b>标签</b> 的标题",
        },
      ],
      nextCursor: "c2" as never,
      terms: ["PID", "整定"],
    };
    const card = cardOf({
      ...presentSearch({
        query: "PID 整定",
        scope: "all",
        trail: ["c1"],
        chatType: "group",
        page,
        appOrigin: APP_ORIGIN,
        nonce: "n1",
      }),
      id: "",
      kind: "reply",
      chatId: "",
      replyToMessageId: null,
      uuid: "",
      leaseToken: "",
      attemptNo: 1,
    });
    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toBe("搜索：PID 整定");
    expect(card.header.subtitle?.content).toBe("全文 · 第 2 页");
    const text = cardText(card);
    // Page 2 numbers from 6, continuing the first page's 1–5.
    expect(text).toContain(
      `**6. [带 ［1］ 标记 ＊和＊ ＜b＞标签＜/b＞ 的标题](${APP_ORIGIN}/articles/${hit.id})**`,
    );
    expect(text).not.toContain("**1. [");
    expect(text).toContain("**PID**");
    expect(text).toContain("**整定**");
    const [previous, next, site] = buttons(card);
    expect(previous?.text).toBe("上一页");
    expect(previous?.value).toMatchObject({ cmd: "search", q: "PID 整定", trail: [], nonce: "n1" });
    expect(next?.text).toBe("下一页");
    expect(next?.value).toMatchObject({ trail: ["c1", "c2"], chatType: "group" });
    expect(site?.url).toBe(`${APP_ORIGIN}/search?q=PID+%E6%95%B4%E5%AE%9A`);

    const empty = cardOf({
      ...presentSearch({
        query: "nothing",
        scope: "kb",
        trail: [],
        chatType: "p2p",
        page: { items: [], nextCursor: null, terms: ["nothing"] },
        appOrigin: APP_ORIGIN,
        nonce: "n2",
      }),
      id: "",
      kind: "reply",
      chatId: "",
      replyToMessageId: null,
      uuid: "",
      leaseToken: "",
      attemptNo: 1,
    });
    expect(empty.header.template).toBe("orange");
    expect(buttons(empty).map((button) => button.text)).toEqual(["在网站中打开"]);
    expect(buttons(empty)[0]?.url).toBe(`${APP_ORIGIN}/search?q=nothing&scope=kb`);

    expect(md("a  [1]\n*b*")).toBe("a ［1］ ＊b＊");
    expect(
      snippetMarkdown(
        [
          { text: "x".repeat(100), hit: false },
          { text: "PID", hit: true },
          { text: "y".repeat(100), hit: false },
        ],
        10,
      ),
    ).toBe(`…${"x".repeat(10)}**PID**${"y".repeat(10)}…`);

    const article = cardOf({
      ...presentArticle({ title: "T", excerpt: "E", articleLink: `${APP_ORIGIN}/articles/x` }),
      id: "",
      kind: "article",
      chatId: "",
      replyToMessageId: null,
      uuid: "",
      leaseToken: "",
      attemptNo: 1,
    });
    expect(article.header.title.content).toBe("RM 文库新文章");
    expect(buttons(article)[0]?.url).toBe(`${APP_ORIGIN}/articles/x`);
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

  it("handles rejected inbound message callbacks", async () => {
    let listener: ((message: NormalizedMessage) => unknown) | undefined;
    const channel = {
      on: (event: string, callback: (message: NormalizedMessage) => unknown) => {
        if (event === "message") listener = callback;
      },
      connect: async () => undefined,
    } as unknown as LarkChannel;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transport = new FeishuTransport({
      appId: "cli_test",
      appSecret: "development-secret",
      channel,
    });
    await transport.connect(async () => {
      throw new Error("database unavailable");
    });

    listener!(message() as NormalizedMessage);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(logged).toHaveBeenCalledWith("[feishu:error]", "message handler failed", {
      name: "Error",
      message: "database unavailable",
    });
    logged.mockRestore();
  });

  it("routes card clicks and menu clicks inbound, patches cards, and addresses users by open id", async () => {
    const calls: { method: string; args: unknown }[] = [];
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const channel = {
      on: (event: string, callback: (event: unknown) => unknown) => {
        handlers[event] = callback;
      },
      dispatcher: {
        register: (handles: Record<string, (event: unknown) => unknown>) =>
          Object.assign(handlers, handles),
      },
      connect: async () => undefined,
      rawClient: {
        im: {
          v1: {
            message: {
              patch: async (args: unknown) => {
                calls.push({ method: "patch", args });
                return { code: 0 };
              },
              create: async (args: unknown) => {
                calls.push({ method: "create", args });
                return { code: 0, data: { message_id: "om_new" } };
              },
              reply: async (args: unknown) => {
                calls.push({ method: "reply", args });
                return { code: 0, data: { message_id: "om_reply" } };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    const received: Inbound[] = [];
    const transport = new FeishuTransport({
      appId: "cli_test",
      appSecret: "development-secret",
      channel,
    });
    await transport.connect(async (inbound) => {
      received.push(inbound);
    });
    handlers.cardAction!({
      messageId: "om_card",
      chatId: "oc_chat",
      operator: { openId: "ou_1" },
      action: { value: { cmd: "search" }, tag: "button" },
    });
    await handlers["application.bot.menu_v6"]!({
      operator: { operator_id: { open_id: "ou_1" } },
      event_key: "latest",
      timestamp: "1700",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received).toEqual([
      {
        kind: "action",
        action: {
          messageId: "om_card",
          chatId: "oc_chat",
          operatorOpenId: "ou_1",
          value: { cmd: "search" },
        },
      },
      { kind: "menu", menu: { operatorOpenId: "ou_1", eventKey: "latest", timestamp: 1700 } },
    ]);

    const envelope: OutboundEnvelope = {
      id: "d1",
      kind: "update",
      chatId: "oc_chat",
      replyToMessageId: "om_card",
      msgType: "interactive",
      content: "{}",
      uuid: "u1",
      leaseToken: "l1",
      attemptNo: 1,
    };
    const signal = new AbortController().signal;
    expect(await transport.send(envelope, signal)).toEqual({ kind: "sent", messageId: "om_card" });
    expect(
      await transport.send(
        { ...envelope, kind: "reply", replyToMessageId: null, chatId: "ou_1" },
        signal,
      ),
    ).toEqual({
      kind: "sent",
      messageId: "om_new",
    });
    expect(calls).toEqual([
      { method: "patch", args: { path: { message_id: "om_card" }, data: { content: "{}" } } },
      {
        method: "create",
        args: {
          params: { receive_id_type: "open_id" },
          data: { receive_id: "ou_1", msg_type: "interactive", content: "{}", uuid: "u1" },
        },
      },
    ]);
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
    expect(cardText(cardOf(digest))).toContain("Article 4");
    expect(cardText(cardOf(digest))).not.toContain("Article 3");

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
        inbound({ chatType: "group", mentionedBot: false, content: "搜索 PID" }),
        ACTIVATION,
      ),
    ).toBe("ignored");
    expect(await store.accept(inbound(), ACTIVATION)).toBe("accepted");
    expect(await store.accept(inbound(), ACTIVATION)).toBe("duplicate");

    const library = fakeLibrary();
    expect(await store.planNextReply(library, ACTIVATION)).toBe(true);
    expect(library.calls).toEqual(["search"]);
    const reply = await store.leaseNext(ACTIVATION);
    expect(reply?.kind).toBe("reply");
    expect(reply?.replyToMessageId).toBe("om_1");
    const card = cardOf(reply);
    expect(card.header.title.content).toBe("搜索：PID 整定");
    expect(cardText(card)).toContain("PID 整定经验");
    expect(cardText(card)).toContain(`${APP_ORIGIN}/articles/`);
  });

  it("turns a paging click into an in-place card update and collapses repeat clicks", async () => {
    await store.activateAndBaseline(ACTIVATION);
    const library = fakeLibrary();
    const value: SearchAction = {
      v: 1,
      cmd: "search",
      q: "PID",
      scope: "title",
      trail: ["c1"],
      chatType: "group",
      nonce: "n1",
    };
    const click: Inbound = {
      kind: "action",
      action: { messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_1", value },
    };
    expect(await store.accept(click, ACTIVATION)).toBe("accepted");
    expect(await store.accept(click, ACTIVATION)).toBe("duplicate");
    expect(
      await store.accept({ ...click, action: { ...click.action, value: "garbage" } }, ACTIVATION),
    ).toBe("ignored");

    expect(await store.planNextReply(library, ACTIVATION)).toBe(true);
    const update = await store.leaseNext(ACTIVATION);
    expect(update?.kind).toBe("update");
    expect(update?.replyToMessageId).toBe("om_card");
    expect(update?.chatId).toBe("oc_chat");
    const card = cardOf(update);
    expect(card.header.subtitle?.content).toBe("仅标题 · 第 2 页");
    const previous = buttons(card).find((button) => button.text === "上一页");
    expect(previous?.value).toMatchObject({
      q: "PID",
      scope: "title",
      trail: [],
      chatType: "group",
    });
    expect((previous!.value as SearchAction).nonce).not.toBe("n1");

    // A cursor the Library no longer accepts falls back to the first page instead of failing.
    const stale: Inbound = {
      kind: "action",
      action: { ...click.action, value: { ...value, trail: ["bad"], nonce: "n2" } },
    };
    expect(await store.accept(stale, ACTIVATION)).toBe("accepted");
    expect(await store.planNextReply(library, ACTIVATION)).toBe(true);
    const fallback = await store.leaseNext(ACTIVATION);
    expect(cardOf(fallback).header.subtitle?.content).toBe("仅标题 · 第 1 页");
  });

  it("answers a bot-menu click in the operator's direct chat", async () => {
    await store.activateAndBaseline(ACTIVATION);
    const library = fakeLibrary();
    const click: Inbound = {
      kind: "menu",
      menu: { operatorOpenId: "ou_1", eventKey: "latest", timestamp: 1700 },
    };
    expect(await store.accept(click, ACTIVATION)).toBe("accepted");
    expect(await store.accept(click, ACTIVATION)).toBe("duplicate");
    expect(await store.planNextReply(library, ACTIVATION)).toBe(true);
    expect(library.calls).toEqual(["articles"]);
    const reply = await store.leaseNext(ACTIVATION);
    expect(reply?.kind).toBe("reply");
    expect(reply?.chatId).toBe("ou_1");
    expect(reply?.replyToMessageId).toBeNull();
    expect(cardOf(reply).header.title.content).toBe("最新文章");
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
