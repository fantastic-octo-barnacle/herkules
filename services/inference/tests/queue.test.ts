import { expect, test } from "vite-plus/test";
import { Scheduler } from "../src/queue.ts";
const workers = ["a", "b"].map((id) => ({
  id,
  model: "qwen",
  url: "http://localhost",
  key: "test",
}));
test("one active request per user, with independent users sharing workers", async () => {
  const q = new Scheduler(workers);
  const signal = new AbortController().signal;
  const a = await q.acquire("alice", "qwen", signal);
  let second = false;
  const pending = q.acquire("alice", "qwen", signal).then((l) => {
    second = true;
    return l;
  });
  const b = await q.acquire("bob", "qwen", signal);
  expect(a.worker.id).not.toBe(b.worker.id);
  expect(second).toBe(false);
  b.release();
  expect(second).toBe(false);
  a.release();
  (await pending).release();
  expect(q.status).toEqual({ active: 0, queued: 0 });
});
test("queue limits, cancellation and timeout release waiting capacity", async () => {
  const q = new Scheduler(workers.slice(0, 1), 20);
  const c = new AbortController();
  const a = await q.acquire("alice", "qwen", c.signal);
  const waiting = q.acquire("alice", "qwen", c.signal);
  const rejection = expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  const timed = q.acquire("alice", "qwen", new AbortController().signal);
  const timeout = expect(timed).rejects.toMatchObject({ code: "queue_timeout" });
  await expect(q.acquire("alice", "qwen", c.signal)).rejects.toMatchObject({ status: 429 });
  c.abort();
  await rejection;
  await timeout;
  a.release();
  a.release();
  expect(q.status).toEqual({ active: 0, queued: 0 });
});
