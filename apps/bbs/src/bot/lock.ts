export interface BotProcessLock {
  readonly lost: Promise<never>;
  release(): Promise<void>;
}

const BOT_LOCK_KEY = 0x42425342;

export async function acquireBotProcessLock(databaseUrl: string): Promise<BotProcessLock | null> {
  if (!/^postgres(ql)?:\/\//u.test(databaseUrl)) {
    return { lost: new Promise<never>(() => undefined), release: async () => undefined };
  }

  const { default: postgres } = await import("postgres");
  const pool = postgres(databaseUrl, { max: 1 });
  const session = await pool.reserve();
  const result = await session<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${BOT_LOCK_KEY}) AS acquired
  `;
  if (!result[0]?.acquired) {
    session.release();
    await pool.end();
    return null;
  }

  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_resolve, reject) => {
    rejectLost = reject;
  });
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void session`SELECT 1`
      .catch((error: unknown) => {
        rejectLost(error instanceof Error ? error : new Error("bot lock session lost"));
      })
      .finally(() => {
        checking = false;
      });
  }, 15_000);
  timer.unref();

  return {
    lost,
    release: async () => {
      clearInterval(timer);
      try {
        await session`SELECT pg_advisory_unlock(${BOT_LOCK_KEY})`;
      } catch {
        // A lost lock session has nothing left to unlock.
      } finally {
        session.release();
        await pool.end();
      }
    },
  };
}
