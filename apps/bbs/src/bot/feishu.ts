import {
  Domain,
  LoggerLevel,
  createLarkChannel,
  type LarkChannel,
  type Logger,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";

import type { BotTransport, IncomingMessage, OutboundEnvelope, SendOutcome } from "./contract.ts";

interface FeishuTransportOptions {
  readonly appId: string;
  readonly appSecret: string;
}

const SENSITIVE_LOG_KEY = /authorization|cookie|secret|token/iu;

function redactString(value: string, appSecret: string): string {
  const withoutSecret = appSecret ? value.replaceAll(appSecret, "[REDACTED]") : value;
  return withoutSecret
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"}]+/giu, "$1[REDACTED]")
    .replace(
      /("(?:access_token|app_secret|authorization|cookie|tenant_access_token)"\s*:\s*")[^"]*/giu,
      "$1[REDACTED]",
    );
}

function redactSdkLog(
  value: unknown,
  appSecret: string,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (typeof value === "string") return redactString(value, appSecret);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "bigint") return String(value);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[Circular]";
  if (depth >= 6) return `[${value.constructor?.name ?? "Object"}]`;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSdkLog(item, appSecret, seen, depth + 1));
  }
  const result: Record<string, unknown> =
    value instanceof Error
      ? {
          name: redactString(value.name, appSecret),
          message: redactString(value.message, appSecret),
        }
      : {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    result[key] = SENSITIVE_LOG_KEY.test(key)
      ? "[REDACTED]"
      : redactSdkLog(item, appSecret, seen, depth + 1);
  }
  return result;
}

function createSdkLogger(appSecret: string): Logger {
  const args = (values: readonly unknown[]) =>
    values.map((value) => redactSdkLog(value, appSecret));
  return {
    error: (...values) => console.error("[feishu:error]", ...args(values)),
    warn: (...values) => console.warn("[feishu:warn]", ...args(values)),
    info: (...values) => console.info("[feishu:info]", ...args(values)),
    debug: (...values) => console.debug("[feishu:debug]", ...args(values)),
    trace: (...values) => console.trace("[feishu:trace]", ...args(values)),
  };
}

function incoming(message: NormalizedMessage): IncomingMessage {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    content: message.content,
    rawContentType: message.rawContentType,
    mentionedBot: message.mentionedBot,
    createTime: message.createTime,
  };
}

function errorDetails(error: unknown): {
  code: string;
  status: number | null;
  retryAfterMs?: number;
  hasResponse: boolean;
} {
  const value = error as {
    code?: unknown;
    response?: {
      status?: unknown;
      headers?: Record<string, unknown>;
      data?: { code?: unknown; msg?: unknown };
    };
  };
  const providerCode = value?.response?.data?.code ?? value?.code;
  const status = Number(value?.response?.status);
  const retry = value?.response?.headers?.["retry-after"];
  const retrySeconds = retry === undefined ? Number.NaN : Number(retry);
  const code =
    typeof providerCode === "string" || typeof providerCode === "number"
      ? String(providerCode)
      : "transport_error";
  return {
    code,
    status: Number.isFinite(status) ? status : null,
    retryAfterMs: Number.isFinite(retrySeconds) ? retrySeconds * 1_000 : undefined,
    hasResponse: value?.response !== undefined,
  };
}

function classifyError(error: unknown): SendOutcome {
  const details = errorDetails(error);
  if (details.status === 401 || details.status === 403) {
    return { kind: "permanent", code: details.code, fatal: true };
  }
  if (details.status === 429 || details.code === "99991400") {
    return { kind: "not_sent", code: details.code, retryAfterMs: details.retryAfterMs };
  }
  if (details.status === 400 || details.status === 404) {
    return { kind: "permanent", code: details.code, fatal: false };
  }
  if (details.hasResponse) return { kind: "not_sent", code: details.code };
  return { kind: "ambiguous", code: details.code };
}

function classifyResponse(code: number): SendOutcome {
  if (code === 99991400 || code === 99991401) {
    return { kind: "not_sent", code: String(code) };
  }
  if (code === 230001 || code === 230002 || code === 230017 || code === 230020) {
    return { kind: "permanent", code: String(code), fatal: false };
  }
  return { kind: "not_sent", code: String(code) };
}

function connectionError(error: unknown): Error {
  const value = error as { code?: unknown };
  const code =
    typeof value?.code === "string" || typeof value?.code === "number"
      ? String(value.code)
      : "transport_error";
  return new Error(`Feishu connection failed: ${code}`);
}

export class FeishuTransport implements BotTransport {
  readonly #channel: LarkChannel;

  constructor(options: FeishuTransportOptions) {
    this.#channel = createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: Domain.Feishu,
      transport: "websocket",
      // The stock error logger prints Axios request bodies, including appSecret.
      loggerLevel: LoggerLevel.info,
      logger: createSdkLogger(options.appSecret),
      source: "herkules-bbs",
      handshakeTimeoutMs: 15_000,
      policy: { requireMention: true, dmMode: "open", respondToMentionAll: false },
      outbound: { retry: { maxAttempts: 1 } },
    });
  }

  async connect(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#channel.on("message", (message) => onMessage(incoming(message)));
    try {
      await this.#channel.connect();
    } catch (error) {
      // Do not let the SDK's nested Axios request, which contains appSecret, reach
      // the process-level error logger.
      throw connectionError(error);
    }
  }

  async send(envelope: OutboundEnvelope, signal: AbortSignal): Promise<SendOutcome> {
    if (signal.aborted) return { kind: "ambiguous", code: "shutdown" };
    try {
      const response = envelope.replyToMessageId
        ? await this.#channel.rawClient.im.v1.message.reply({
            path: { message_id: envelope.replyToMessageId },
            data: {
              msg_type: envelope.msgType,
              content: envelope.content,
              uuid: envelope.uuid,
            },
          })
        : await this.#channel.rawClient.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: envelope.chatId,
              msg_type: envelope.msgType,
              content: envelope.content,
              uuid: envelope.uuid,
            },
          });
      if (response.code && response.code !== 0) {
        return classifyResponse(response.code);
      }
      const messageId = response.data?.message_id;
      return messageId
        ? { kind: "sent", messageId }
        : { kind: "ambiguous", code: "missing_message_id" };
    } catch (error) {
      return classifyError(error);
    }
  }

  disconnect(): Promise<void> {
    return this.#channel.disconnect();
  }
}

export {
  classifyError as classifyFeishuError,
  classifyResponse as classifyFeishuResponse,
  connectionError as safeFeishuConnectionError,
  redactSdkLog as redactFeishuSdkLog,
};
