import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRedis, Queue, Worker } from "../src/adapters/bullmq/index.js";
import { checkerFor, keys } from "../src/adapters/bullmq/lifecycle.js";

const until = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test("concurrent due-job promotion enqueues an id only once", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("due-race", { connection: redis });
  const worker = new Worker("due-race", async () => true, { connection: redis });
  await worker.pause();
  try {
    const job = await queue.add("work", {}, { delay: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.all([(worker as any).wakeDue(), (worker as any).wakeDue()]);
    const k = keys("kadmos", "due-race");
    assert.equal(await redis.llen(k.wait), 1);
    assert.equal(await redis.zcard(k.delayed), 0);
    assert.equal(await job.getState(), "waiting");
  } finally { await worker.close(); }
});

test("concurrent retry-backoff promotion enqueues an id only once", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("retry-due-race", { connection: redis });
  const worker = new Worker("retry-due-race", async () => true, { connection: redis });
  await worker.pause();
  try {
    const job = await queue.add("work", {}, { attempts: 2, delay: 1 });
    const k = keys("kadmos", "retry-due-race");
    await redis.hset(k.job(job.id), { state: "delayed", attemptsMade: "1", failedReason: "retry", lockEpoch: "1" });
    await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.all([(worker as any).wakeDue(), (worker as any).wakeDue()]);
    assert.equal(await redis.llen(k.wait), 1);
    assert.equal(await redis.zcard(k.delayed), 0);
  } finally { await worker.close(); }
});

test("discard racing processor completion leaves one terminal state and one terminal index", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("terminal-race", { connection: redis });
  let finish!: (value: string) => void;
  const hold = new Promise<string>(resolve => { finish = resolve; });
  const worker = new Worker("terminal-race", async () => hold, { connection: redis });
  try {
    const job = await queue.add("work", {});
    await until(async () => await job.getState() === "active");
    const discarding = job.discard();
    finish("done");
    await Promise.allSettled([discarding]);
    await worker.close();
    const k = keys("kadmos", "terminal-race");
    const state = await job.getState();
    assert.ok(state === "completed" || state === "failed");
    assert.equal((await redis.zcard(k.completed)) + (await redis.zcard(k.failed)), 1);
    const raw = await redis.hgetall(k.job(job.id));
    if (state === "completed") assert.equal(raw.failedReason, "");
    else assert.equal(raw.returnvalue, "");
  } finally { finish("done"); await worker.close(); }
});

test("overlapping custom-ID adds admit exactly one job", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("add-race", { connection: redis });
  const results = await Promise.allSettled([
    queue.add("first", { value: 1 }, { jobId: "unique" }),
    queue.add("second", { value: 2 }, { jobId: "unique" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(await queue.count(), 1);
  assert.ok([1, 2].includes((await queue.getJob("unique"))!.data.value));
});

test("poll recovers a crash between move-to-active and claim", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("claim-crash", { connection: redis });
  const job = await queue.add("work", {});
  const k = keys("kadmos", "claim-crash");
  await redis.rpoplpush(k.wait, k.active);
  let calls = 0;
  const worker = new Worker("claim-crash", async () => { calls++; return "recovered"; }, { connection: redis });
  try {
    await until(async () => await job.getState() === "completed");
    assert.equal(calls, 1);
    assert.equal(await redis.llen(k.active), 0);
  } finally { await worker.close(); }
});

test("expired active lease returns to wait and fences the old token", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("lease-expired", { connection: redis });
  const job = await queue.add("work", {});
  const k = keys("kadmos", "lease-expired");
  await redis.rpoplpush(k.wait, k.active);
  await redis.hset(k.job(job.id), { state: "active", lockToken: "old", lockEpoch: "1", lockAcquiredAt: "1" });
  let calls = 0;
  const worker = new Worker("lease-expired", async () => { calls++; return "new"; }, { connection: redis, lockDuration: 5 });
  try {
    await until(async () => await job.getState() === "completed");
    assert.equal(calls, 1);
    const raw = await redis.hgetall(k.job(job.id));
    assert.equal(raw.lockEpoch, "3");
    assert.equal(raw.returnvalue, '"new"');
  } finally { await worker.close(); }
});

test("an active hash without a lock token is recovered", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("missing-token", { connection: redis });
  const job = await queue.add("work", {});
  const k = keys("kadmos", "missing-token");
  await redis.rpoplpush(k.wait, k.active);
  await redis.hset(k.job(job.id), { state: "active", lockToken: "", lockEpoch: "1", lockAcquiredAt: "" });
  const worker = new Worker("missing-token", async () => "recovered", { connection: redis });
  try {
    await until(async () => await job.getState() === "completed");
    assert.equal((await redis.hgetall(k.job(job.id))).lockEpoch, "3");
    assert.equal(await redis.llen(k.active), 0);
  } finally { await worker.close(); }
});

test("rehydration preserves terminal states and lock epochs", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("rehydrate", { connection: redis });
  const job = await queue.add("work", {});
  const k = keys("kadmos", "rehydrate");
  for (const [state, token] of [["waiting", ""], ["active", "owner"], ["completed", ""], ["failed", ""], ["revoked", ""]] as const) {
    await redis.hset(k.job(job.id), { state, lockToken: token, lockEpoch: "4" });
    const raw = await redis.hgetall(k.job(job.id));
    const checker = checkerFor(raw as any);
    assert.equal(checker.getState(), state.toUpperCase());
    assert.equal(checker.getContext().lock_epoch, 4);
  }
  await redis.hset(k.job(job.id), { state: "delayed", attemptsMade: "1", failedReason: "retry", lockEpoch: "4" });
  const delayed = checkerFor(await redis.hgetall(k.job(job.id)) as any);
  assert.equal(delayed.getState(), "DELAYED_RETRY");
  assert.equal(delayed.getContext().lock_epoch, 4);
  assert.equal(delayed.getContext().retries, 1);
});

test("MemoryRedis LREM zero removes adjacent duplicate ids", async () => {
  const redis = new MemoryRedis();
  await redis.lpush("wait", "same");
  await redis.lpush("wait", "same");
  assert.equal(await redis.lrem("wait", 0, "same"), 2);
  assert.equal(await redis.llen("wait"), 0);
});

test("a long-running local job renews its lease without duplicate execution", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("heartbeat", { connection: redis });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const worker = new Worker("heartbeat", async () => { calls++; await held; return "ok"; }, { connection: redis, concurrency: 2, lockDuration: 20 });
  try {
    const job = await queue.add("work", {});
    await until(async () => await job.getState() === "active");
    const k = keys("kadmos", "heartbeat");
    const initialLease = Number((await redis.hgetall(k.job(job.id))).lockAcquiredAt);
    await new Promise(resolve => setTimeout(resolve, 70));
    const raw = await redis.hgetall(k.job(job.id));
    assert.equal(raw.state, "active");
    assert.ok(Number(raw.lockAcquiredAt) > initialLease);
    assert.equal(calls, 1);
    release();
    await until(async () => await job.getState() === "completed");
    assert.equal(calls, 1);
  } finally { release(); await worker.close(); }
});

test("manual retry promotes an initially delayed job without stepping retry IR", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("initial-delay-retry", { connection: redis });
  const job = await queue.add("work", {}, { delay: 5000, attempts: 2 });
  await job.retry();
  const k = keys("kadmos", "initial-delay-retry");
  assert.equal(await job.getState(), "waiting");
  assert.deepEqual(await redis.lrange(k.wait, 0, -1), [job.id]);
  assert.equal(await redis.zcard(k.delayed), 0);
});

test("failed manual retry restores the delayed index", async () => {
  class FailingRedis extends MemoryRedis {
    override async transitionJob(change: Parameters<MemoryRedis["transitionJob"]>[0]): Promise<boolean> {
      if (change.expectedState === "delayed") throw new Error("injected transition failure");
      return super.transitionJob(change);
    }
  }
  const redis = new FailingRedis();
  const queue = new Queue("retry-restore", { connection: redis });
  const job = await queue.add("work", {}, { delay: 5000, attempts: 2 });
  await assert.rejects(job.retry(), /injected transition failure/);
  const k = keys("kadmos", "retry-restore");
  assert.equal(await job.getState(), "delayed");
  assert.deepEqual(await redis.zrangebyscore(k.delayed, "-inf", "+inf"), [job.id]);
  assert.equal(await redis.llen(k.wait), 0);
});

test("failed due-job promotion restores the delayed index", async () => {
  class FailingRedis extends MemoryRedis {
    override async transitionJob(change: Parameters<MemoryRedis["transitionJob"]>[0]): Promise<boolean> {
      if (change.expectedState === "delayed") throw new Error("injected promotion failure");
      return super.transitionJob(change);
    }
  }
  const redis = new FailingRedis();
  const queue = new Queue("wake-restore", { connection: redis });
  const worker = new Worker("wake-restore", async () => true, { connection: redis });
  await worker.pause();
  try {
    const job = await queue.add("work", {}, { delay: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects((worker as any).wakeDue(), /injected promotion failure/);
    const k = keys("kadmos", "wake-restore");
    assert.equal(await job.getState(), "delayed");
    assert.deepEqual(await redis.zrangebyscore(k.delayed, "-inf", "+inf"), [job.id]);
    assert.equal(await redis.llen(k.wait), 0);
  } finally { await worker.close(); }
});

test("discard during retryable processor failure remains revoked", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("discard-failure", { connection: redis });
  let rejectWork!: (error: Error) => void;
  const held = new Promise<never>((_, reject) => { rejectWork = reject; });
  const worker = new Worker("discard-failure", async () => held, { connection: redis });
  try {
    const job = await queue.add("work", {}, { attempts: 2, backoff: 1000 });
    await until(async () => await job.getState() === "active");
    await job.discard();
    rejectWork(new Error("retryable"));
    await worker.close();
    const k = keys("kadmos", "discard-failure");
    const raw = await redis.hgetall(k.job(job.id));
    assert.equal(raw.state, "revoked");
    assert.equal(raw.failedReason, "discarded");
    assert.equal(checkerFor(raw as any).getState(), "REVOKED");
    assert.equal(await job.getState(), "failed");
    assert.equal(await redis.zcard(k.delayed), 0);
    assert.equal(await redis.zcard(k.failed), 1);
    assert.equal(await redis.llen(k.active), 0);
  } finally { rejectWork(new Error("cleanup")); await worker.close(); }
});

test("failed custom-ID enqueue releases its reservation", async () => {
  class FailingRedis extends MemoryRedis {
    fail = true;
    override async lpush(key: string, value: string): Promise<number> {
      if (this.fail) { this.fail = false; throw new Error("injected enqueue failure"); }
      return super.lpush(key, value);
    }
  }
  const redis = new FailingRedis();
  const queue = new Queue("enqueue-rollback", { connection: redis });
  await assert.rejects(queue.add("work", {}, { jobId: "same" }), /injected enqueue failure/);
  const job = await queue.add("work", {}, { jobId: "same" });
  assert.equal(job.id, "same");
  assert.equal(await queue.count(), 1);
});
