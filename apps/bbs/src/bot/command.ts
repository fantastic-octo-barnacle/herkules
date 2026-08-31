import type { IncomingMessage } from "./contract.ts";

export type BotCommand =
  | { readonly kind: "help" }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "invalid"; readonly reason: "empty" | "too_long" }
  | { readonly kind: "ignore" };

const SEARCH_PREFIX = /^(?:搜索|search)\s*/iu;

export function parseCommand(message: IncomingMessage): BotCommand {
  if (message.chatType === "group" && !message.mentionedBot) return { kind: "ignore" };
  if (message.rawContentType !== "text") return { kind: "ignore" };

  const text = message.content.trim();
  if (/^help$/iu.test(text)) return { kind: "help" };

  const prefixed = SEARCH_PREFIX.test(text);
  if (message.chatType === "group" && !prefixed) return { kind: "ignore" };
  const query = (prefixed ? text.replace(SEARCH_PREFIX, "") : text).trim();
  if (!query) return { kind: "invalid", reason: "empty" };
  if (query.length > 200) return { kind: "invalid", reason: "too_long" };
  return { kind: "search", query };
}
