export interface IncomingMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "p2p" | "group";
  readonly content: string;
  readonly rawContentType: string;
  readonly mentionedBot: boolean;
  readonly createTime: number;
}

export interface OutboundEnvelope {
  readonly id: string;
  readonly kind: "article" | "digest" | "reply";
  readonly chatId: string;
  readonly replyToMessageId: string | null;
  readonly msgType: string;
  readonly content: string;
  readonly uuid: string;
  readonly leaseToken: string;
  readonly attemptNo: number;
}

export type SendOutcome =
  | { readonly kind: "sent"; readonly messageId: string }
  | {
      readonly kind: "not_sent" | "ambiguous";
      readonly code: string;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "permanent"; readonly code: string; readonly fatal: boolean };

export interface BotTransport {
  connect(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  send(envelope: OutboundEnvelope, signal: AbortSignal): Promise<SendOutcome>;
  disconnect(): Promise<void>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};
