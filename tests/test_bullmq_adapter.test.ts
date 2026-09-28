import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Queue, QueueEvents, Worker, MemoryRedis } from "../src/adapters/bullmq/index.js";

const timeout = async <T>(promise: Promise<T>): Promise<T> => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000)),
]);

test("executes a job and publishes completion", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue<{ value: number }, number>("basic", { connection: redis });
  const events = new QueueEvents("basic", { connection: redis });
  const worker = new Worker<{ value: number }, number>("basic", async job => job.data.value * 2, { connection: redis });
  try {
    const completed = once(events, "completed");
    const job = await queue.add("double", { value: 21 });
    const [event] = await timeout(completed);
    assert.equal(event.jobId, job.id);
    assert.equal(event.returnvalue, 42);
    assert.equal((await queue.getJob(job.id))?.returnvalue, 42);
    assert.equal(await job.getState(), "completed");
  } finally { await worker.close(); await events.close(); await queue.close(); }
});

test("progress is persisted and published", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("progress", { connection: redis });
  const events = new QueueEvents("progress", { connection: redis });
  const worker = new Worker("progress", async job => { await job.updateProgress({ step: 2 }); return true; }, { connection: redis });
  try {
    const progress = once(events, "progress");
    const job = await queue.add("work", {});
    const [event] = await timeout(progress);
    assert.deepEqual(event, { jobId: job.id, data: { step: 2 } });
    assert.deepEqual((await queue.getJob(job.id))?.progress, { step: 2 });
  } finally { await worker.close(); await events.close(); await queue.close(); }
});

test("retries with backoff then completes", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("retry", { connection: redis });
  let calls = 0;
  const worker = new Worker("retry", async () => { if (++calls < 3) throw new Error("transient"); return "ok"; }, { connection: redis });
  try {
    const done = once(worker, "completed");
    const job = await queue.add("work", {}, { attempts: 3, backoff: { type: "fixed", delay: 10 } });
    await timeout(done);
    assert.equal(calls, 3);
    assert.equal((await queue.getJob(job.id))?.attemptsMade, 2);
    assert.equal(await job.getState(), "completed");
  } finally { await worker.close(); await queue.close(); }
});

test("exhausted attempts fail", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("exhaust", { connection: redis });
  const events = new QueueEvents("exhaust", { connection: redis });
  const worker = new Worker("exhaust", async () => { throw new Error("fatal"); }, { connection: redis });
  try {
    const failed = once(events, "failed");
    const job = await queue.add("work", {}, { attempts: 2 });
    const [event] = await timeout(failed);
    assert.equal(event.jobId, job.id);
    assert.equal(event.failedReason, "fatal");
    assert.equal(await job.getState(), "failed");
  } finally { await worker.close(); await events.close(); await queue.close(); }
});

test("concurrency never exceeds limit", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("concurrency", { connection: redis });
  let active = 0; let peak = 0; let completed = 0;
  const worker = new Worker("concurrency", async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 25)); active--; return true; }, { connection: redis, concurrency: 2 });
  try {
    const done = new Promise<void>(resolve => worker.on("completed", () => { if (++completed === 3) resolve(); }));
    await Promise.all([0, 1, 2].map(n => queue.add("work", { n })));
    await timeout(done);
    assert.equal(peak, 2);
  } finally { await worker.close(); await queue.close(); }
});

test("queue and worker pause and resume", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("pause", { connection: redis });
  let calls = 0;
  const worker = new Worker("pause", async () => { calls++; return true; }, { connection: redis });
  try {
    await queue.pause(); await worker.pause();
    const job = await queue.add("work", {});
    await new Promise(r => setTimeout(r, 40));
    assert.equal(calls, 0);
    assert.equal(await queue.isPaused(), true);
    await queue.resume(); await worker.resume();
    while (await job.getState() !== "completed") await new Promise(r => setTimeout(r, 10));
    assert.equal(calls, 1);
  } finally { await worker.close(); await queue.close(); }
});

test("graceful close waits for active job and leaves queued work", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("close", { connection: redis });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker("close", async () => { await held; return true; }, { connection: redis });
  try {
    const first = await queue.add("first", {});
    while (await first.getState() !== "active") await new Promise(r => setTimeout(r, 5));
    const second = await queue.add("second", {});
    const closing = worker.close();
    release(); await timeout(closing);
    assert.equal(await first.getState(), "completed");
    assert.equal(await second.getState(), "waiting");
  } finally { release(); await worker.close(); await queue.close(); }
});

test("Redis settlement failure restores active job for later settlement", async () => {
  class FaultRedis extends MemoryRedis {
    failCompletion = true;
    override async zadd(key: string, score: number, value: string): Promise<number> {
      const result = await super.zadd(key, score, value);
      if (key.endsWith(":completed") && this.failCompletion) { this.failCompletion = false; throw new Error("injected completion failure"); }
      return result;
    }
  }
  const redis = new FaultRedis();
  const queue = new Queue("rollback", { connection: redis });
  const worker = new Worker("rollback", async () => "ok", { connection: redis });
  try {
    const errors: Error[] = [];
    worker.on("error", error => errors.push(error));
    const job = await queue.add("work", {});
    await timeout(new Promise<void>(resolve => worker.on("error", () => resolve())));
    assert.match(errors[0]!.message, /injected completion failure/);
    assert.equal(await job.getState(), "active");
    assert.equal(await redis.llen("kadmos:kadmos:rollback:active"), 1);
    assert.deepEqual(await redis.zrangebyscore("kadmos:kadmos:rollback:completed", "-inf", "+inf"), []);
  } finally { await worker.close(); await queue.close(); }
});

test("discarded jobs remain terminal", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("discard", { connection: redis });
  const job = await queue.add("work", {});
  await job.discard();
  assert.equal(await job.getState(), "failed");
  await assert.rejects(job.retry(), /Only delayed/);
  assert.equal(await queue.count(), 0);
});

test("manual retry wakes a delayed retry without bypassing the gate", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("manual", { connection: redis });
  const worker = new Worker("manual", async () => { throw new Error("retry me"); }, { connection: redis });
  try {
    const job = await queue.add("work", {}, { attempts: 2, backoff: { type: "fixed", delay: 5000 } });
    await timeout(new Promise<void>(resolve => {
      const poll = setInterval(async () => {
        if (await job.getState() === "delayed") { clearInterval(poll); resolve(); }
      }, 5);
    }));
    await worker.pause();
    await job.retry();
    assert.equal(await job.getState(), "waiting");
    assert.equal(await queue.count(), 1);
  } finally { await worker.close(); await queue.close(); }
});
