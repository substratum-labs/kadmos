import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { Job as BullJob } from "bullmq";
import { WorldChecker } from "../examples/job-queue-benchmark/spec/world_checker.js";
import { MemoryRedis, Queue, Worker } from "../src/adapters/bullmq/index.js";
import { keys, settle } from "../src/adapters/bullmq/lifecycle.js";

const request = (transitionId: string, proposedDirective: NonNullable<Parameters<WorldChecker["step"]>[0]["proposedDirective"]>, eventPayload: Record<string, string> = {}) =>
  ({ transitionId, proposedDirective, eventPayload });

function bullJob(backend: { retryFinishedJob(job: BullJob, state: string): Promise<void> }): BullJob {
  const queue = { backend, toKey: (key: string) => key, qualifiedName: "bull:flaws" };
  return new BullJob(queue as never, "work", {}, {}, "job-1");
}

test("crash consistency: lost BullMQ retry acknowledgement splits job memory from backend; Kadmos compensates partial Redis writes", async () => {
  let persistentState = "failed";
  const bull = bullJob({ async retryFinishedJob() {
    persistentState = "waiting"; // Backend committed; the network acknowledgement is lost.
    throw new Error("lost Redis acknowledgement");
  } });
  bull.failedReason = "original failure";
  bull.finishedOn = 123;
  await assert.rejects(bull.retry("failed"), /lost Redis acknowledgement/);
  assert.equal(persistentState, "waiting");
  assert.equal(bull.failedReason, "original failure");
  assert.equal(bull.finishedOn, 123);

  const redis = new MemoryRedis();
  const k = keys("kadmos", "crash-flaw");
  const gate = new WorldChecker();
  gate.reset({ job_id: "job-1" });
  assert.equal(gate.step(request("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token: "owner" })).allowed, true);
  const before = gate.getContext();
  await redis.hset(k.job("job-1"), { state: "active", lockToken: "owner", returnvalue: "" });
  await redis.lpush(k.active, "job-1");
  const persistedBefore = await redis.hgetall(k.job("job-1"));
  await assert.rejects(settle(gate, "REPORT_SUCCESS", "PERSIST_RESULT", { token: "owner", result_digest: "result" }, async () => {
    await redis.hset(k.job("job-1"), { state: "completed", returnvalue: "result", lockToken: "" });
    await redis.lrem(k.active, 1, "job-1");
    throw new Error("injected Redis write failure");
  }, async () => {
    await redis.lrem(k.active, 0, "job-1");
    await redis.lpush(k.active, "job-1");
    await redis.hset(k.job("job-1"), persistedBefore);
  }), /injected Redis write failure/);
  assert.equal(gate.getState(), "ACTIVE");
  assert.deepEqual(gate.getContext(), before);
  assert.deepEqual(await redis.hgetall(k.job("job-1")), persistedBefore);
  assert.equal(await redis.llen(k.active), 1);
  assert.equal(await redis.zcard(k.completed), 0);

  // A failed worker settlement remains recoverable even if the worker dies here.
  await redis.hset(k.job("job-1"), { ...persistedBefore, id: "job-1", name: "work", data: "{}", opts: "{}", attemptsMade: "0", progress: "0", failedReason: "", lockEpoch: "1", lockAcquiredAt: "1" });
  const queue = new Queue("crash-flaw", { connection: redis });
  const worker = new Worker("crash-flaw", async () => "recovered", { connection: redis, lockDuration: 5 });
  try {
    const deadline = Date.now() + 3000;
    let state = await (await queue.getJob("job-1"))!.getState();
    while (state !== "completed") {
      if (Date.now() > deadline) throw new Error("stale lease was not recovered");
      await new Promise(resolve => setTimeout(resolve, 5));
      state = await (await queue.getJob("job-1"))!.getState();
    }
    assert.equal((await queue.getJob("job-1"))?.returnvalue, "recovered");
    assert.equal(await redis.llen(k.active), 0);
  } finally { await worker.close(); }
});

test("terminal resurrection: BullMQ retry requeues finished jobs; Kadmos rejects every terminal replay", async () => {
  for (const terminal of ["failed", "completed"] as const) {
    let persistentState: string = terminal;
    const bull = bullJob({ async retryFinishedJob(_job, state) {
      assert.equal(state, terminal);
      persistentState = "waiting";
    } });
    bull.failedReason = "audit reason";
    bull.finishedOn = 123;
    await bull.retry(terminal);
    assert.equal(persistentState, "waiting");
    assert.equal(bull.failedReason, null);
    assert.equal(bull.finishedOn, null);
  }

  for (const terminal of ["COMPLETED", "FAILED", "REVOKED"] as const) {
    const gate = new WorldChecker();
    gate.reset({ max_retries: 0 });
    assert.equal(gate.step(request("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token: "owner" })).allowed, true);
    const ending = terminal === "COMPLETED" ? request("REPORT_SUCCESS", "PERSIST_RESULT", { token: "owner", result_digest: "result" })
      : terminal === "FAILED" ? request("REPORT_FATAL_FAILURE", "TRIGGER_DEAD_LETTER_ALERT", { token: "owner", reason: "failed" })
      : request("CANCEL_FROM_ACTIVE", "NOTIFY_CANCELLATION", { token: "owner" });
    assert.equal(gate.step(ending).currentState, terminal);
    const before = gate.getContext();
    for (const replay of [request("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token: "new" }), request("REPORT_SUCCESS", "PERSIST_RESULT", { token: "owner", result_digest: "changed" }), request("REPORT_RETRYABLE_FAILURE", "SCHEDULE_BACKOFF", { token: "owner", reason: "retry" })]) {
      const verdict = gate.step(replay);
      assert.equal(verdict.violation?.code, "ILLEGAL_TRANSITION");
      assert.equal(gate.getState(), terminal);
      assert.deepEqual(gate.getContext(), before);
    }
  }

  const redis = new MemoryRedis();
  const queue = new Queue("terminal-flaw", { connection: redis });
  try {
    const job = await queue.add("work", {});
    await job.discard();
    await assert.rejects(job.retry());
    assert.equal(await job.getState(), "failed");
    assert.equal((await queue.getJob(job.id))?.failedReason, "discarded");
    const completed = await queue.add("work", {});
    const worker = new Worker("terminal-flaw", async () => "done", { connection: redis });
    try {
      const deadline = Date.now() + 3000;
      while (await completed.getState() !== "completed") {
        if (Date.now() > deadline) throw new Error("completion timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await assert.rejects(completed.retry(), /Only delayed retry jobs/);
      assert.equal(await completed.getState(), "completed");
    } finally { await worker.close(); }
  } finally { await queue.close(); }
});

test("polyglot split-brain: unguarded external writes steal a lock; compiled TS/Python gates agree on fencing and epoch", async () => {
  const redis = new MemoryRedis();
  const key = keys("bull", "polyglot").job("job-1");
  await redis.hset(key, { state: "active", lockToken: "worker-b", lockEpoch: "3" });
  // A client writing queue hashes directly has no transition/epoch check.
  await redis.hset(key, { state: "completed", lockToken: "worker-a", lockEpoch: "1" });
  assert.deepEqual(await redis.hgetall(key), { state: "completed", lockToken: "worker-a", lockEpoch: "1" });

  const steps = [
    request("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token: "worker-a" }),
    request("RECOVER_STALE_LEASE", "EVICT_STALE_WORKER", { supervisor_token: "supervisor" }),
    request("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token: "worker-b" }),
    request("REPORT_SUCCESS", "PERSIST_RESULT", { token: "worker-a", result_digest: "stale" }),
    request("REPORT_SUCCESS", "PERSIST_RESULT", { token: "worker-b", result_digest: "fresh" }),
  ];
  const gate = new WorldChecker();
  const ts = steps.map(step => {
    const verdict = gate.step(step);
    return { allowed: verdict.allowed, state: gate.getState(), epoch: gate.getContext().lock_epoch, token: gate.getContext().lock_token, code: verdict.violation?.code ?? null };
  });
  assert.deepEqual(ts.map(v => v.epoch), [1, 2, 3, 3, 3]);
  assert.deepEqual(ts.map(v => v.code), [null, null, null, "GUARD_FAILED", null]);
  assert.equal(ts[3]?.token, "worker-b");
  assert.equal(ts[4]?.state, "COMPLETED");

  const python = spawnSync("python3", ["-B", "-c", "import json,sys; from world_checker import WorldChecker\ng=WorldChecker()\nout=[]\nfor s in json.load(sys.stdin):\n v=g.step(s); c=g.get_context(); out.append({'allowed':v['allowed'],'state':g.get_state(),'epoch':c['lock_epoch'],'token':c['lock_token'],'code':(v.get('violation') or {}).get('code')})\nprint(json.dumps(out))"], {
    cwd: join(process.cwd(), "examples/job-queue-benchmark/spec"), input: JSON.stringify(steps), encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), ts);
});
