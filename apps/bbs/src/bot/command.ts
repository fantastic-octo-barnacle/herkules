import { z } from "zod";

import type { SearchScope } from "../library/types.ts";
import type { IncomingMessage } from "./contract.ts";

export type BotCommand =
  | { readonly kind: "help" }
  | { readonly kind: "search"; readonly query: string; readonly scope: SearchScope }
  | { readonly kind: "latest" }
  | { readonly kind: "status" }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "invalid"; readonly reason: "empty" | "too_long" }
  | { readonly kind: "ignore" };

export interface CommandSpec {
  readonly name: string;
  /** Accepted after `/` and, for the bare forms, at the start of a message. */
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly summary: string;
  readonly scope?: SearchScope;
  readonly takesQuery: boolean;
}

/** The command table `/help` renders and the bot menu resolves against (`event_key` = name). */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "search",
    aliases: ["s", "搜索"],
    usage: "/search 关键词",
    summary: "全文搜索标题、作者、标签、简介和正文",
    scope: "all",
    takesQuery: true,
  },
  {
    name: "title",
    aliases: ["t", "标题"],
    usage: "/title 关键词",
    summary: "只搜标题",
    scope: "title",
    takesQuery: true,
  },
  {
    name: "kb",
    aliases: ["知识库"],
    usage: "/kb 关键词",
    summary: "搜知识库条目",
    scope: "kb",
    takesQuery: true,
  },
  {
    name: "latest",
    aliases: ["new", "最新"],
    usage: "/latest",
    summary: "最近收录的 5 篇文章",
    takesQuery: false,
  },
  {
    name: "status",
    aliases: ["状态"],
    usage: "/status",
    summary: "文库收录情况",
    takesQuery: false,
  },
  {
    name: "help",
    aliases: ["h", "?", "帮助"],
    usage: "/help",
    summary: "查看全部命令",
    takesQuery: false,
  },
];

export const MAX_QUERY_CHARS = 200;

function findCommand(word: string): CommandSpec | undefined {
  const lower = word.toLowerCase();
  return COMMANDS.find((spec) => spec.name === lower || spec.aliases.includes(lower));
}

function resolve(spec: CommandSpec, rest: string): BotCommand {
  if (!spec.takesQuery) {
    return spec.name === "help" || spec.name === "latest" || spec.name === "status"
      ? { kind: spec.name }
      : { kind: "ignore" };
  }
  const query = rest.trim();
  if (!query) return { kind: "invalid", reason: "empty" };
  if (query.length > MAX_QUERY_CHARS) return { kind: "invalid", reason: "too_long" };
  return { kind: "search", query, scope: spec.scope ?? "all" };
}

/**
 * `/name args` anywhere; the bare aliases (`搜索 x`, `search x`, `help`) stay accepted so
 * existing group habits keep working. Latin bare aliases need whitespace after them so a
 * DM such as "searching motors" is still a search for that phrase.
 */
function splitCommand(
  text: string,
): { readonly spec: CommandSpec | null; readonly name: string; readonly rest: string } | null {
  const slash = /^\/(\S+)\s*([\s\S]*)$/u.exec(text);
  if (slash) {
    const name = slash[1] ?? "";
    return { spec: findCommand(name) ?? null, name, rest: slash[2] ?? "" };
  }
  const bare = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (bare?.[1]) {
    const spec = findCommand(bare[1]);
    if (spec) return { spec, name: bare[1], rest: bare[2] ?? "" };
  }
  const cjk = /^(搜索|标题|知识库)\s*([\s\S]*)$/u.exec(text);
  if (cjk?.[1]) {
    const spec = findCommand(cjk[1]);
    if (spec) return { spec, name: cjk[1], rest: cjk[2] ?? "" };
  }
  return null;
}

export function parseCommand(message: IncomingMessage): BotCommand {
  if (message.chatType === "group" && !message.mentionedBot) return { kind: "ignore" };
  if (message.rawContentType !== "text") return { kind: "ignore" };

  const text = message.content.trim();
  const split = splitCommand(text);
  if (split) {
    if (!split.spec) return { kind: "unknown", name: split.name.slice(0, 40) };
    return resolve(split.spec, split.rest);
  }
  if (message.chatType === "group") return { kind: "ignore" };
  if (!text) return { kind: "invalid", reason: "empty" };
  if (text.length > MAX_QUERY_CHARS) return { kind: "invalid", reason: "too_long" };
  return { kind: "search", query: text, scope: "all" };
}

/** A bot-menu click carries only its `event_key`; commands that need a query show help instead. */
export function parseMenuCommand(eventKey: string): BotCommand {
  const spec = findCommand(eventKey.trim());
  if (!spec) return { kind: "unknown", name: eventKey.trim().slice(0, 40) };
  return spec.takesQuery ? { kind: "help" } : resolve(spec, "");
}

// ── card actions ─────────────────────────────────────────────────────────────

const searchActionSchema = z.object({
  v: z.literal(1),
  cmd: z.literal("search"),
  q: z.string().min(1).max(MAX_QUERY_CHARS),
  scope: z.enum(["all", "title", "kb"]),
  /** Cursors that led to the page to render; the last one is the page's own cursor. */
  trail: z.array(z.string().min(1).max(200)).max(50),
  chatType: z.enum(["p2p", "group"]),
  /** Changes on every render, so re-clicking a stale button is a no-op but paging back and forth works. */
  nonce: z.string().min(1).max(64),
});

export type SearchAction = z.infer<typeof searchActionSchema>;

/** Validates a button `value`; null for anything the bot did not put on a card itself. */
export function parseAction(value: unknown): SearchAction | null {
  const parsed = searchActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Deduplication key: the same button on the same render of the same card collapses. */
export function actionReceiptId(cardMessageId: string, action: SearchAction): string {
  return `action:${cardMessageId}:${action.nonce}:${action.trail.length}`;
}
