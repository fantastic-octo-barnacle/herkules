import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import type { BbsDb } from "../db/index.ts";
import { rowsOf } from "../db/index.ts";
import type { Library } from "../library/index.ts";
import { actionReceiptId, parseAction, parseCommand, parseMenuCommand } from "./command.ts";
import type { SearchAction } from "./command.ts";
import type { Inbound, IncomingMessage, OutboundEnvelope, SendOutcome } from "./contract.ts";
import { presentArticle, presentDigest } from "./present.ts";
import type { FrozenPayload } from "./present.ts";
import { respond, respondSearch } from "./respond.ts";
import { digestDueAt, hongKongDay } from "./time.ts";

const LEASE_MS = 2 * 60 * 1_000;

interface StoreOptions {
  readonly db: BbsDb;
  readonly appOrigin: string;
  readonly announcementChatId: string;
  readonly random?: () => number;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface ReconcileReport {
  readonly baseline: boolean;
  readonly immediate: number;
  readonly overflow: number;
  readonly ineligible: number;
  readonly digests: number;
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function instant(value: Date): string {
  return value.toISOString();
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  throw new TypeError("expected a scalar database value");
}

function asDay(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function articleExcerpt(introduction: unknown, bodyText: unknown): string | null {
  const intro = asNullableText(introduction)?.trim();
  if (intro) return intro;
  const body = asNullableText(bodyText)?.replace(/\s+/gu, " ").trim();
  return body ? body.slice(0, 200) : null;
}

function deliveryValues(
  kind: OutboundEnvelope["kind"],
  logicalKey: string,
  chatId: string,
  replyToMessageId: string | null,
  payload: FrozenPayload,
  scheduledAt: Date,
  at: Date,
) {
  return {
    id: randomUUID(),
    kind,
    logicalKey,
    chatId,
    replyToMessageId,
    msgType: payload.msgType,
    content: payload.content,
    payloadHash: payload.hash,
    uuid: randomUUID(),
    scheduledAt,
    at,
  };
}

const RECEIPT_CARD_ACTION = "card_action";
const RECEIPT_BOT_MENU = "bot_menu";

interface Receipt {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "p2p" | "group";
  readonly rawContentType: string;
  readonly content: string;
  readonly createTime: number;
}

/**
 * Every inbound kind becomes one row keyed for deduplication: Feishu message ids for messages,
 * card + render nonce + page for button clicks, operator + key + timestamp for menu clicks.
 */
function inboundReceipt(inbound: Inbound, at: Date): Receipt | null {
  switch (inbound.kind) {
    case "message": {
      const message = inbound.message;
      if (parseCommand(message).kind === "ignore") return null;
      return {
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        rawContentType: message.rawContentType,
        content: message.content.slice(0, 1_000),
        createTime: message.createTime,
      };
    }
    case "action": {
      const action: SearchAction | null = parseAction(inbound.action.value);
      if (!action) return null;
      return {
        messageId: actionReceiptId(inbound.action.messageId, action),
        chatId: inbound.action.chatId,
        chatType: action.chatType,
        rawContentType: RECEIPT_CARD_ACTION,
        content: JSON.stringify({ cardMessageId: inbound.action.messageId, value: action }),
        createTime: at.getTime(),
      };
    }
    case "menu":
      return {
        messageId: `menu:${inbound.menu.operatorOpenId}:${inbound.menu.eventKey}:${inbound.menu.timestamp}`,
        chatId: inbound.menu.operatorOpenId,
        chatType: "p2p",
        rawContentType: RECEIPT_BOT_MENU,
        content: inbound.menu.eventKey.slice(0, 200),
        createTime: inbound.menu.timestamp,
      };
  }
}

export class BotStore {
  readonly #db: BbsDb;
  readonly #appOrigin: string;
  readonly #announcementChatId: string;
  readonly #random: () => number;
  readonly #log: NonNullable<StoreOptions["log"]>;

  constructor(options: StoreOptions) {
    this.#db = options.db;
    this.#appOrigin = options.appOrigin;
    this.#announcementChatId = options.announcementChatId;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? (() => undefined);
  }

  async activateAndBaseline(at: Date): Promise<boolean> {
    const atIso = instant(at);
    return this.#db.transaction(async (tx) => {
      const state = rowsOf(
        await tx.execute(sql`SELECT * FROM bot_state WHERE id = 1 FOR UPDATE`),
      )[0];
      if (state) {
        if (String(state.announcement_chat_id) !== this.#announcementChatId) {
          throw new Error(
            "FEISHU_ANNOUNCEMENT_CHAT_ID does not match the chat fixed at bot activation",
          );
        }
        return false;
      }

      await tx.execute(sql`
        INSERT INTO bot_state (id, activated_at, announcement_chat_id, last_reconciled_at)
        VALUES (1, ${atIso}, ${this.#announcementChatId}, ${atIso})
      `);
      await tx.execute(sql`
        INSERT INTO bot_article_decisions
          (source_id, source_article_id, status, decided_at)
        SELECT source_id, source_article_id, 'baseline', ${atIso}
        FROM articles
      `);
      this.#log("activated", { at: at.toISOString() });
      return true;
    });
  }

  async reconcile(at: Date): Promise<ReconcileReport> {
    const atIso = instant(at);
    return this.#db.transaction(async (tx) => {
      await this.#expireLeases(tx, at);
      const digests = await this.#sealDueDays(tx, at);
      const state = rowsOf(
        await tx.execute(sql`SELECT activated_at FROM bot_state WHERE id = 1 FOR UPDATE`),
      )[0];
      if (!state) throw new Error("bot must activate before reconciliation");
      const activatedAt = asDate(state.activated_at);
      const activatedAtIso = instant(activatedAt);
      const day = hongKongDay(at);

      await tx.execute(sql`
        INSERT INTO bot_days (assignment_day, created_at)
        VALUES (${day}, ${atIso})
        ON CONFLICT (assignment_day) DO NOTHING
      `);
      await tx.execute(
        sql`SELECT assignment_day FROM bot_days WHERE assignment_day = ${day} FOR UPDATE`,
      );

      const ineligible = rowsOf(
        await tx.execute(sql`
          WITH inserted AS (
            INSERT INTO bot_article_decisions
              (source_id, source_article_id, status, decided_at)
            SELECT a.source_id, a.source_article_id,
              CASE WHEN a.published_at IS NULL
                THEN 'ineligible_null_publication'
                ELSE 'ineligible_pre_activation'
              END,
              ${atIso}
            FROM articles a
            LEFT JOIN bot_article_decisions d
              ON d.source_id = a.source_id AND d.source_article_id = a.source_article_id
            WHERE d.source_id IS NULL
              AND (a.published_at IS NULL OR a.published_at <= ${activatedAtIso})
            ON CONFLICT DO NOTHING
            RETURNING 1
          ) SELECT count(*)::int AS count FROM inserted
        `),
      );

      const occupied = new Set(
        rowsOf(
          await tx.execute(sql`
            SELECT immediate_slot FROM bot_article_decisions
            WHERE assignment_day = ${day} AND immediate_slot IS NOT NULL
          `),
        ).map((row) => Number(row.immediate_slot)),
      );
      const eligible = rowsOf(
        await tx.execute(sql`
          SELECT a.id, a.source_id, a.source_article_id, a.title, a.introduction,
                 a.body_text, a.published_at
          FROM articles a
          JOIN article_search s ON s.article_id = a.id
          LEFT JOIN bot_article_decisions d
            ON d.source_id = a.source_id AND d.source_article_id = a.source_article_id
          WHERE d.source_id IS NULL
            AND a.published_at > ${activatedAtIso}
            AND a.status = 'fetched'
          ORDER BY a.published_at, a.source_id, a.source_article_id
        `),
      );

      let immediate = 0;
      let overflow = 0;
      for (const row of eligible) {
        const slot = [1, 2, 3].find((candidate) => !occupied.has(candidate)) ?? null;
        if (slot) occupied.add(slot);
        const status = slot ? "immediate" : "overflow";
        const sourceId = String(row.source_id);
        const sourceArticleId = String(row.source_article_id);
        const articleId = String(row.id);
        const title = String(row.title);
        const excerpt = articleExcerpt(row.introduction, row.body_text);
        const publishedAt = asDate(row.published_at);
        const articleLink = `${this.#appOrigin}/articles/${articleId}`;

        await tx.execute(sql`
          INSERT INTO bot_article_decisions
            (source_id, source_article_id, status, decided_at, assignment_day,
             immediate_slot, article_id, title, excerpt, published_at, article_link)
          VALUES (${sourceId}, ${sourceArticleId}, ${status}, ${atIso}, ${day},
                  ${slot}, ${articleId}, ${title}, ${excerpt}, ${instant(publishedAt)}, ${articleLink})
        `);

        if (slot) {
          const payload = presentArticle({ title, excerpt, articleLink });
          const delivery = deliveryValues(
            "article",
            `article:${sourceId}:${sourceArticleId}`,
            this.#announcementChatId,
            null,
            payload,
            at,
            at,
          );
          await this.#insertDelivery(tx, delivery);
          await tx.execute(sql`
            UPDATE bot_article_decisions SET delivery_id = ${delivery.id}
            WHERE source_id = ${sourceId} AND source_article_id = ${sourceArticleId}
          `);
          immediate += 1;
        } else {
          overflow += 1;
        }
      }

      await tx.execute(sql`UPDATE bot_state SET last_reconciled_at = ${atIso} WHERE id = 1`);
      const report = {
        baseline: false,
        immediate,
        overflow,
        ineligible: Number(ineligible[0]?.count ?? 0),
        digests,
      };
      if (immediate || overflow || report.ineligible || digests) this.#log("reconciled", report);
      return report;
    });
  }

  async accept(inbound: Inbound, at: Date): Promise<"accepted" | "duplicate" | "ignored"> {
    const receipt = inboundReceipt(inbound, at);
    if (!receipt) return "ignored";
    const inserted = rowsOf(
      await this.#db.execute(sql`
        INSERT INTO bot_inbound_receipts
          (message_id, chat_id, chat_type, raw_content_type, content,
           created_at_feishu, admitted_at, state)
        VALUES (${receipt.messageId}, ${receipt.chatId}, ${receipt.chatType},
                ${receipt.rawContentType}, ${receipt.content},
                ${instant(new Date(receipt.createTime))}, ${instant(at)}, 'pending')
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      `),
    );
    return inserted.length ? "accepted" : "duplicate";
  }

  async planNextReply(library: Library, at: Date): Promise<boolean> {
    const atIso = instant(at);
    const leaseToken = randomUUID();
    const leased = await this.#db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE bot_inbound_receipts
        SET state = 'pending', lease_token = NULL, leased_until = NULL
        WHERE state = 'leased' AND leased_until <= ${atIso}
      `);
      const row = rowsOf(
        await tx.execute(sql`
          SELECT * FROM bot_inbound_receipts
          WHERE state = 'pending'
          ORDER BY admitted_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `),
      )[0];
      if (!row) return null;
      await tx.execute(sql`
        UPDATE bot_inbound_receipts
        SET state = 'leased', lease_token = ${leaseToken}, leased_until = ${instant(new Date(at.getTime() + LEASE_MS))}
        WHERE message_id = ${String(row.message_id)}
      `);
      return row;
    });
    if (!leased) return false;

    const message: IncomingMessage = {
      messageId: String(leased.message_id),
      chatId: String(leased.chat_id),
      chatType: String(leased.chat_type) as "p2p" | "group",
      content: String(leased.content),
      rawContentType: String(leased.raw_content_type),
      mentionedBot: true,
      createTime: asDate(leased.created_at_feishu).getTime(),
    };

    try {
      const deps = {
        library,
        appOrigin: this.#appOrigin,
        chatType: message.chatType,
        nonce: () => randomUUID().slice(0, 8),
      };
      let payload: FrozenPayload;
      let kind: OutboundEnvelope["kind"] = "reply";
      let replyToMessageId: string | null = message.messageId;
      if (message.rawContentType === RECEIPT_CARD_ACTION) {
        const stored = JSON.parse(message.content) as { cardMessageId: string; value: unknown };
        const action = parseAction(stored.value);
        if (!action) throw new Error("stored card action is not valid");
        payload = await respondSearch(action, deps);
        kind = "update";
        replyToMessageId = stored.cardMessageId;
      } else if (message.rawContentType === RECEIPT_BOT_MENU) {
        payload = await respond(parseMenuCommand(message.content), deps);
        replyToMessageId = null;
      } else {
        payload = await respond(parseCommand(message), deps);
      }
      const delivery = deliveryValues(
        kind,
        `reply:${message.messageId}`,
        message.chatId,
        replyToMessageId,
        payload,
        at,
        at,
      );
      await this.#db.transaction(async (tx) => {
        await this.#insertDelivery(tx, delivery);
        await tx.execute(sql`
          UPDATE bot_inbound_receipts
          SET state = 'planned', reply_delivery_id = ${delivery.id},
              lease_token = NULL, leased_until = NULL, last_error = NULL
          WHERE message_id = ${message.messageId}
            AND state = 'leased' AND lease_token = ${leaseToken}
        `);
      });
      return true;
    } catch (error) {
      await this.#db.execute(sql`
        UPDATE bot_inbound_receipts
        SET state = 'pending', lease_token = NULL, leased_until = NULL,
            last_error = ${error instanceof Error ? error.message.slice(0, 500) : "reply planning failed"}
        WHERE message_id = ${message.messageId} AND lease_token = ${leaseToken}
      `);
      throw error;
    }
  }

  async leaseNext(at: Date): Promise<OutboundEnvelope | null> {
    const atIso = instant(at);
    return this.#db.transaction(async (tx) => {
      await this.#expireLeases(tx, at);
      const row = rowsOf(
        await tx.execute(sql`
          SELECT * FROM bot_deliveries
          WHERE state = 'pending' AND scheduled_at <= ${atIso} AND next_attempt_at <= ${atIso}
          ORDER BY scheduled_at,
                   CASE kind WHEN 'digest' THEN 0 WHEN 'reply' THEN 1 WHEN 'update' THEN 1 ELSE 2 END,
                   created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `),
      )[0];
      if (!row) return null;
      const id = String(row.id);
      const attemptNo = Number(row.attempt_count) + 1;
      const leaseToken = randomUUID();
      await tx.execute(sql`
        UPDATE bot_deliveries
        SET state = 'leased', lease_token = ${leaseToken},
            leased_until = ${instant(new Date(at.getTime() + LEASE_MS))},
            attempt_count = ${attemptNo}, updated_at = ${atIso}
        WHERE id = ${id}
      `);
      await tx.execute(sql`
        INSERT INTO bot_delivery_attempts
          (id, delivery_id, lease_token, attempt_no, started_at)
        VALUES (${randomUUID()}, ${id}, ${leaseToken}, ${attemptNo}, ${atIso})
      `);
      return {
        id,
        kind: String(row.kind) as OutboundEnvelope["kind"],
        chatId: String(row.chat_id),
        replyToMessageId: asNullableText(row.reply_to_message_id),
        msgType: String(row.msg_type),
        content: String(row.content),
        uuid: String(row.uuid),
        leaseToken,
        attemptNo,
      };
    });
  }

  async settle(envelope: OutboundEnvelope, outcome: SendOutcome, at: Date): Promise<boolean> {
    const atIso = instant(at);
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE bot_delivery_attempts
        SET finished_at = ${atIso}, outcome = ${outcome.kind},
            code = ${outcome.kind === "sent" ? null : outcome.code}
        WHERE delivery_id = ${envelope.id} AND lease_token = ${envelope.leaseToken}
          AND finished_at IS NULL
      `);
      if (outcome.kind === "sent") {
        await tx.execute(sql`
          UPDATE bot_deliveries
          SET state = 'sent', feishu_message_id = ${outcome.messageId},
              lease_token = NULL, leased_until = NULL, last_error = NULL, updated_at = ${atIso}
          WHERE id = ${envelope.id} AND state <> 'sent'
        `);
        return false;
      }

      const current = rowsOf(
        await tx.execute(sql`
          SELECT state, lease_token FROM bot_deliveries WHERE id = ${envelope.id} FOR UPDATE
        `),
      )[0];
      if (!current || current.state === "sent" || current.lease_token !== envelope.leaseToken) {
        return false;
      }
      if (outcome.kind === "permanent") {
        await tx.execute(sql`
          UPDATE bot_deliveries SET state = 'permanent', lease_token = NULL,
            leased_until = NULL, last_error = ${outcome.code}, updated_at = ${atIso}
          WHERE id = ${envelope.id} AND lease_token = ${envelope.leaseToken}
        `);
        return outcome.fatal;
      }

      const retryAt = new Date(
        at.getTime() + (outcome.retryAfterMs ?? this.#backoff(envelope.attemptNo)),
      );
      await tx.execute(sql`
        UPDATE bot_deliveries SET state = 'pending', lease_token = NULL,
          leased_until = NULL, next_attempt_at = ${instant(retryAt)}, last_error = ${outcome.code}, updated_at = ${atIso}
        WHERE id = ${envelope.id} AND lease_token = ${envelope.leaseToken}
      `);
      return false;
    });
  }

  async #insertDelivery(tx: BbsDb, value: ReturnType<typeof deliveryValues>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO bot_deliveries
        (id, kind, logical_key, chat_id, reply_to_message_id, msg_type, content,
         payload_hash, uuid, scheduled_at, state, next_attempt_at, created_at, updated_at)
      VALUES (${value.id}, ${value.kind}, ${value.logicalKey}, ${value.chatId},
              ${value.replyToMessageId}, ${value.msgType}, ${value.content},
              ${value.payloadHash}, ${value.uuid}, ${instant(value.scheduledAt)}, 'pending',
              ${instant(value.scheduledAt)}, ${instant(value.at)}, ${instant(value.at)})
    `);
  }

  async #expireLeases(tx: BbsDb, at: Date): Promise<void> {
    const atIso = instant(at);
    await tx.execute(sql`
      UPDATE bot_delivery_attempts a
      SET finished_at = ${atIso}, outcome = 'ambiguous', code = 'lease_expired'
      FROM bot_deliveries d
      WHERE a.delivery_id = d.id AND a.lease_token = d.lease_token
        AND a.finished_at IS NULL AND d.state = 'leased' AND d.leased_until <= ${atIso}
    `);
    await tx.execute(sql`
      UPDATE bot_deliveries
      SET state = 'pending', lease_token = NULL, leased_until = NULL,
          next_attempt_at = ${atIso}, last_error = 'lease_expired', updated_at = ${atIso}
      WHERE state = 'leased' AND leased_until <= ${atIso}
    `);
  }

  async #sealDueDays(tx: BbsDb, at: Date): Promise<number> {
    const atIso = instant(at);
    const dueDays = rowsOf(
      await tx.execute(sql`
        SELECT assignment_day FROM bot_days
        WHERE sealed_at IS NULL AND assignment_day < ${hongKongDay(at)}
        ORDER BY assignment_day
        FOR UPDATE
      `),
    ).filter((row) => digestDueAt(asDay(row.assignment_day)).getTime() <= at.getTime());

    let created = 0;
    for (const [dueIndex, row] of dueDays.entries()) {
      const day = asDay(row.assignment_day);
      const members = rowsOf(
        await tx.execute(sql`
          SELECT d.source_id, d.source_article_id, d.status, d.title, d.excerpt,
                 d.article_link, d.delivery_id
          FROM bot_article_decisions d
          LEFT JOIN bot_deliveries delivery ON delivery.id = d.delivery_id
          WHERE d.assignment_day = ${day}
            AND (
              d.status = 'overflow'
              OR (
                d.status = 'immediate' AND delivery.state = 'pending'
                AND NOT EXISTS (
                  SELECT 1 FROM bot_delivery_attempts a
                  WHERE a.delivery_id = delivery.id
                    AND (a.outcome IS NULL OR a.outcome <> 'not_sent')
                )
              )
            )
          ORDER BY d.published_at, d.source_id, d.source_article_id
        `),
      );

      let digestDeliveryId: string | null = null;
      if (members.length) {
        const payload = presentDigest(
          day,
          members.map((member) => ({
            title: String(member.title),
            excerpt: asNullableText(member.excerpt),
            articleLink: String(member.article_link),
          })),
        );
        const dueAt = digestDueAt(day);
        const scheduledAt = new Date(Math.max(dueAt.getTime(), at.getTime() + dueIndex * 60_000));
        const delivery = deliveryValues(
          "digest",
          `digest:${day}`,
          this.#announcementChatId,
          null,
          payload,
          scheduledAt,
          at,
        );
        await this.#insertDelivery(tx, delivery);
        digestDeliveryId = delivery.id;
        for (const [index, member] of members.entries()) {
          await tx.execute(sql`
            UPDATE bot_article_decisions
            SET digest_delivery_id = ${delivery.id}, digest_ordinal = ${index + 1}
            WHERE source_id = ${String(member.source_id)}
              AND source_article_id = ${String(member.source_article_id)}
          `);
          if (member.delivery_id) {
            await tx.execute(sql`
              UPDATE bot_deliveries SET state = 'cancelled', updated_at = ${atIso}
              WHERE id = ${asNullableText(member.delivery_id)} AND state = 'pending'
            `);
          }
        }
        created += 1;
      }

      await tx.execute(sql`
        UPDATE bot_days SET sealed_at = ${atIso}, digest_delivery_id = ${digestDeliveryId}
        WHERE assignment_day = ${day} AND sealed_at IS NULL
      `);
    }
    return created;
  }

  #backoff(attemptNo: number): number {
    const base = Math.min(60 * 60 * 1_000, 5_000 * 2 ** Math.max(0, attemptNo - 1));
    return Math.round(base * (1 + this.#random() * 0.2));
  }
}
