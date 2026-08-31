import type { Library } from "../library/index.ts";
import type { BotTransport, Clock } from "./contract.ts";
import { systemClock } from "./contract.ts";
import { BotStore } from "./store.ts";

interface BotRuntimeOptions {
  readonly store: BotStore;
  readonly library: Library;
  readonly transport: BotTransport;
  readonly signal: AbortSignal;
  readonly clock?: Clock;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

export async function runBot(options: BotRuntimeOptions): Promise<void> {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => undefined);
  let lastReconciled = 0;

  let connected = false;
  try {
    await options.transport.connect(async (message) => {
      const result = await options.store.accept(message, clock.now());
      if (result !== "ignored") log("inbound", { messageId: message.messageId, result });
    });
    connected = true;
    const baseline = await options.store.activateAndBaseline(clock.now());
    log("ready", { baseline });

    while (!options.signal.aborted) {
      const now = clock.now();
      if (now.getTime() - lastReconciled >= 30_000) {
        await options.store.reconcile(now);
        lastReconciled = now.getTime();
      }
      await options.store.planNextReply(options.library, now);
      const delivery = await options.store.leaseNext(now);
      if (delivery) {
        log("send_started", {
          deliveryId: delivery.id,
          kind: delivery.kind,
          attempt: delivery.attemptNo,
        });
        const outcome = await options.transport.send(delivery, options.signal);
        const fatal = await options.store.settle(delivery, outcome, clock.now());
        log("send_finished", { deliveryId: delivery.id, outcome: outcome.kind });
        if (fatal) throw new Error(`fatal Feishu delivery failure: ${outcome.kind}`);
        continue;
      }
      await clock.sleep(500, options.signal);
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    if (connected) await options.transport.disconnect();
  }
}

export { BotStore } from "./store.ts";
