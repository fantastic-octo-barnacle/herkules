export class AdmissionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
interface Waiter {
  user: string;
  model: string;
  signal: AbortSignal;
  resolve: (lease: Lease) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
export interface Worker {
  id: string;
  model: string;
  url: string;
  key: string;
  capacity?: number;
  perUser?: number;
  resourceGroup?: string;
  accessId?: string;
  accessSecret?: string;
}
export interface Lease {
  worker: Worker;
  release(): void;
}

/** In-process queue; worker-side admission is the authority across gateway restarts. */
export class Scheduler {
  private readonly busy = new Map<string, number>();
  private readonly activeUsers = new Map<string, number>();
  private readonly waiting: Waiter[] = [];
  readonly workers: readonly Worker[];
  readonly waitMs: number;
  constructor(workers: readonly Worker[], waitMs = 90_000) {
    this.workers = workers;
    this.waitMs = waitMs;
  }
  get status() {
    return {
      active: [...this.busy.values()].reduce((sum, n) => sum + n, 0),
      queued: this.waiting.length,
    };
  }
  async acquire(user: string, model: string, signal: AbortSignal): Promise<Lease> {
    if (signal.aborted) throw new AdmissionError("cancelled", 499);
    if (!this.workers.some((w) => w.model === model))
      throw new AdmissionError("model_not_found", 404);
    if (this.waiting.length >= 16 || this.waiting.filter((w) => w.user === user).length >= 2) {
      throw new AdmissionError("queue_full", 429);
    }
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiter.cleanup();
        reject(error);
        this.pump();
      };
      const abort = () => remove(new AdmissionError("cancelled", 499));
      const timer = setTimeout(() => remove(new AdmissionError("queue_timeout", 429)), this.waitMs);
      const waiter: Waiter = {
        user,
        model,
        signal,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }
  private pump() {
    for (let i = 0; i < this.waiting.length;) {
      const next = this.waiting[i]!;
      const worker = this.workers.find((w) => {
        if (w.model !== next.model || (this.busy.get(w.id) ?? 0) >= (w.capacity ?? 1)) return false;
        if ((this.activeUsers.get(next.user) ?? 0) >= (w.perUser ?? 1)) return false;
        const group = w.resourceGroup ?? w.id;
        if (
          this.workers.some(
            (other) =>
              (other.resourceGroup ?? other.id) === group &&
              other.model !== w.model &&
              this.busy.has(other.id),
          )
        )
          return false;
        // Drain a shared GPU when an older request needs a different model.
        return !this.waiting
          .slice(0, i)
          .some(
            (older) =>
              older.model !== w.model &&
              this.workers.some(
                (other) =>
                  other.model === older.model && (other.resourceGroup ?? other.id) === group,
              ),
          );
      });
      if (!worker) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      next.cleanup();
      this.busy.set(worker.id, (this.busy.get(worker.id) ?? 0) + 1);
      this.activeUsers.set(next.user, (this.activeUsers.get(next.user) ?? 0) + 1);
      let released = false;
      next.resolve({
        worker,
        release: () => {
          if (released) return;
          released = true;
          const remaining = this.busy.get(worker.id)! - 1;
          if (remaining) this.busy.set(worker.id, remaining);
          else this.busy.delete(worker.id);
          const userRemaining = this.activeUsers.get(next.user)! - 1;
          if (userRemaining) this.activeUsers.set(next.user, userRemaining);
          else this.activeUsers.delete(next.user);
          this.pump();
        },
      });
    }
  }
}
