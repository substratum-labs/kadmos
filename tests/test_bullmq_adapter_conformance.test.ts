import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MemoryRedis, Queue, QueueEvents, Worker } from "../src/adapters/bullmq/index.js";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const within = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("conformance event timed out")), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};
const until = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error("conformance state timed out");
    await sleep(5);
  }
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("conformance: basic job lifecycle preserves data, return value, events and state", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue<{ foo: string }, { status: string }>("basic-conformance", { connection: redis });
  const events = new QueueEvents("basic-conformance", { connection: redis });
  const worker = new Worker<{ foo: string }, { status: string }>("basic-conformance", async job => {
    assert.deepEqual(job.data, { foo: "bar" });
    assert.equal(await job.getState(), "active");
    return { status: "ok" };
  }, { connection: redis });
  try {
    await events.ready;
    const local = once(worker, "completed");
    const global = once(events, "completed");
    const job = await queue.add("work", { foo: "bar" });
    assert.equal(job.name, "work");
    const [[completedJob, value], [event]] = await within(Promise.all([local, global]));
    assert.equal(completedJob.id, job.id);
    assert.deepEqual(value, { status: "ok" });
    assert.deepEqual(completedJob.returnvalue, value);
    assert.deepEqual(event, { jobId: job.id, returnvalue: value, prev: "active" });
    assert.deepEqual((await queue.getJob(job.id))?.returnvalue, value);
    assert.equal(await job.getState(), "completed");
  } finally { await worker.close(); await events.close(); await queue.close(); }
});

test("conformance: custom job IDs reject duplicates without replacing the first job", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("dedup-conformance", { connection: redis });
  const first = await queue.add("work", { value: 1 }, { jobId: "customer-42" });
  await assert.rejects(queue.add("work", { value: 2 }, { jobId: "customer-42" }), /already exists/);
  assert.equal(first.id, "customer-42");
  assert.deepEqual((await queue.getJob(first.id))?.data, { value: 1 });
  assert.equal(await queue.count(), 1);
  await queue.close();
});

test("conformance: delayed job becomes waiting before a worker picks it up", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("delay-conformance", { connection: redis });
  const hold = deferred();
  const worker = new Worker("delay-conformance", async job => {
    if (job.name === "blocker") await hold.promise;
    return job.name;
  }, { connection: redis });
  try {
    const blocker = await queue.add("blocker", {});
    await until(async () => await blocker.getState() === "active");
    const delayed = await queue.add("delayed", {}, { delay: 40 });
    assert.equal(await delayed.getState(), "delayed");
    await until(async () => await delayed.getState() === "waiting");
    assert.equal(await queue.count(), 2);
    hold.resolve();
    await until(async () => await delayed.getState() === "completed");
    assert.equal((await queue.getJob(delayed.id))?.returnvalue, "delayed");
  } finally { hold.resolve(); await worker.close(); await queue.close(); }
});

test("conformance: numeric and object progress reach QueueEvents in order", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("progress-conformance", { connection: redis });
  const events = new QueueEvents("progress-conformance", { connection: redis });
  const progress: unknown[] = [];
  events.on("progress", event => progress.push(event));
  const worker = new Worker("progress-conformance", async job => {
    await job.updateProgress(50);
    await job.updateProgress({ step: 2 });
    return true;
  }, { connection: redis });
  try {
    await events.ready;
    const completed = once(events, "completed");
    const job = await queue.add("work", {});
    await within(completed);
    assert.deepEqual(progress, [{ jobId: job.id, data: 50 }, { jobId: job.id, data: { step: 2 } }]);
    assert.deepEqual((await queue.getJob(job.id))?.progress, { step: 2 });
  } finally { await worker.close(); await events.close(); await queue.close(); }
});

test("conformance: concurrency three bounds six active jobs", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("concurrency-conformance", { connection: redis });
  let active = 0, peak = 0, finished = 0;
  const hold = deferred();
  const worker = new Worker("concurrency-conformance", async () => {
    active++;
    peak = Math.max(peak, active);
    await hold.promise;
    active--;
    return true;
  }, { connection: redis, concurrency: 3 });
  try {
    const done = new Promise<void>(resolve => worker.on("completed", () => { if (++finished === 6) resolve(); }));
    const jobs = await Promise.all(Array.from({ length: 6 }, (_, n) => queue.add("work", { n })));
    await until(async () => active === 3);
    assert.equal(peak, 3);
    assert.equal((await Promise.all(jobs.map(job => job.getState()))).filter(state => state === "active").length, 3);
    hold.resolve();
    await within(done);
    assert.ok(peak <= 3);
    assert.deepEqual(await Promise.all(jobs.map(job => job.getState())), Array(6).fill("completed"));
  } finally { hold.resolve(); await worker.close(); await queue.close(); }
});

test("conformance: retry backoff records two failures then completes on attempt three", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("retry-conformance", { connection: redis });
  let calls = 0;
  const worker = new Worker("retry-conformance", async () => {
    if (++calls < 3) throw new Error(`transient ${calls}`);
    return "recovered";
  }, { connection: redis });
  try {
    const job = await queue.add("work", {}, { attempts: 3, backoff: { type: "fixed", delay: 200 } });
    await until(async () => await job.getState() === "delayed");
    assert.equal((await queue.getJob(job.id))?.attemptsMade, 1);
    await until(async () => (await queue.getJob(job.id))?.attemptsMade === 2);
    assert.equal(await job.getState(), "delayed");
    await until(async () => await job.getState() === "completed");
    assert.equal(calls, 3);
    assert.equal((await queue.getJob(job.id))?.attemptsMade, 2);
    assert.equal((await queue.getJob(job.id))?.returnvalue, "recovered");
  } finally { await worker.close(); await queue.close(); }
});

test("conformance: max attempts exhaustion emits failed and stores reason", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("exhaust-conformance", { connection: redis });
  const events = new QueueEvents("exhaust-conformance", { connection: redis });
  let calls = 0;
  const worker = new Worker("exhaust-conformance", async () => { calls++; throw new Error("permanent failure"); }, { connection: redis });
  try {
    await events.ready;
    const local = once(worker, "failed");
    const global = once(events, "failed");
    const job = await queue.add("work", {}, { attempts: 2, backoff: { type: "fixed", delay: 20 } });
    const [[failedJob, error], [event]] = await within(Promise.all([local, global]));
    assert.equal(failedJob.id, job.id);
    assert.match(error.message, /permanent failure/);
    assert.deepEqual(event, { jobId: job.id, failedReason: "permanent failure", prev: "active" });
    assert.equal(await job.getState(), "failed");
    assert.equal((await queue.getJob(job.id))?.failedReason, "permanent failure");
    assert.equal((await queue.getJob(job.id))?.attemptsMade, 2);
    assert.equal(calls, 2);
  } finally { await worker.close(); await events.close(); await queue.close(); }
});

test("conformance: stale worker cannot settle after supervisor eviction", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("fencing-conformance", { connection: redis });
  const hold = deferred();
  let completions = 0;
  const worker = new Worker("fencing-conformance", async () => { await hold.promise; return "stale result"; }, { connection: redis });
  worker.on("completed", () => completions++);
  try {
    const job = await queue.add("work", {});
    await until(async () => await job.getState() === "active");
    await job.discard();
    assert.equal(await job.getState(), "failed");
    hold.resolve();
    await worker.close();
    assert.equal(completions, 0);
    assert.equal((await queue.getJob(job.id))?.returnvalue, undefined);
    assert.equal((await queue.getJob(job.id))?.failedReason, "discarded");
  } finally { hold.resolve(); await worker.close(); await queue.close(); }
});

test("conformance: worker emits drained after all queued work completes", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("drained-conformance", { connection: redis });
  const worker = new Worker("drained-conformance", async () => true, { connection: redis });
  try {
    await worker.pause();
    const drained = once(worker, "drained");
    const job = await queue.add("work", {});
    await worker.resume();
    await within(drained);
    assert.equal(await job.getState(), "completed");
    assert.equal(await queue.count(), 0);
  } finally { await worker.close(); await queue.close(); }
});

test("conformance: two QueueEvents clients independently observe lifecycle", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("multi-client-conformance", { connection: redis });
  const first = new QueueEvents("multi-client-conformance", { connection: redis });
  const second = new QueueEvents("multi-client-conformance", { connection: redis });
  const worker = new Worker("multi-client-conformance", async job => {
    await job.updateProgress(25);
    return "ok";
  }, { connection: redis });
  try {
    await Promise.all([first.ready, second.ready]);
    const progress = [once(first, "progress"), once(second, "progress")];
    const completed = [once(first, "completed"), once(second, "completed")];
    const job = await queue.add("work", {});
    for (const [event] of await within(Promise.all(progress))) assert.deepEqual(event, { jobId: job.id, data: 25 });
    for (const [event] of await within(Promise.all(completed))) assert.deepEqual(event, { jobId: job.id, returnvalue: "ok", prev: "active" });
  } finally { await worker.close(); await first.close(); await second.close(); await queue.close(); }
});

test("conformance: queue and worker pause keep jobs waiting until both resume", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("pause-conformance", { connection: redis });
  let calls = 0;
  const worker = new Worker("pause-conformance", async () => { calls++; return true; }, { connection: redis });
  try {
    await queue.pause();
    await worker.pause();
    const job = await queue.add("work", {});
    await sleep(50);
    assert.equal(await job.getState(), "waiting");
    assert.equal(calls, 0);
    await queue.resume();
    await sleep(50);
    assert.equal(await job.getState(), "waiting");
    await worker.resume();
    await until(async () => await job.getState() === "completed");
    assert.equal(calls, 1);
  } finally { await worker.close(); await queue.close(); }
});

test("conformance: graceful close finishes active job and leaves next job waiting", async () => {
  const redis = new MemoryRedis();
  const queue = new Queue("close-conformance", { connection: redis });
  const hold = deferred();
  const worker = new Worker("close-conformance", async () => { await hold.promise; return "done"; }, { connection: redis });
  try {
    const active = await queue.add("active", {});
    await until(async () => await active.getState() === "active");
    const pending = await queue.add("pending", {});
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await sleep(20);
    assert.equal(closed, false);
    assert.equal(await pending.getState(), "waiting");
    hold.resolve();
    await within(closing);
    assert.equal(await active.getState(), "completed");
    assert.equal(await pending.getState(), "waiting");
  } finally { hold.resolve(); await worker.close(); await queue.close(); }
});
