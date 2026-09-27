import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { JobWorker, MemoryRedis } from "../examples/job-queue-benchmark/ts_worker.js";
import { WorldChecker } from "../examples/job-queue-benchmark/spec/world_checker.js";

function setup() {
  const redis = new MemoryRedis();
  const checker = new WorldChecker();
  const worker = new JobWorker(redis, checker, "job-42");
  return { redis, checker, worker };
}

test("TypeScript worker completes a picked up job", async () => {
  const { redis, checker, worker } = setup();
  await worker.enqueue();
  assert.equal(await worker.begin("worker-a"), true);
  assert.equal(checker.getState(), "ACTIVE");
  assert.equal(await worker.succeed("worker-a", "sha256:abc"), true);
  assert.equal(checker.getState(), "COMPLETED");
  assert.equal(await redis.get("job-42:result"), "sha256:abc");
  assert.equal(await redis.get("job-42:lock"), null);
});

test("TypeScript worker backs off and recovers after a transient failure", async () => {
  const { redis, checker, worker } = setup();
  await worker.enqueue();
  assert.equal(await worker.begin("worker-a"), true);
  assert.equal(await worker.fail("worker-a", "503", 100), true);
  assert.equal(checker.getState(), "DELAYED_RETRY");
  assert.equal(checker.getContext().retries, 1);
  assert.equal(await worker.wakeDue(99), false);
  assert.equal(await worker.wakeDue(100), true);
  assert.equal(checker.getState(), "WAITING");
  assert.equal(await worker.begin("worker-b"), true);
  assert.equal(await worker.succeed("worker-b", "recovered"), true);
  assert.equal(await redis.get("job-42:result"), "recovered");
});

test("TypeScript worker dead letters after three permitted retries", async () => {
  const { redis, checker, worker } = setup();
  await worker.enqueue();
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(await worker.begin(`worker-${attempt}`), true);
    assert.equal(await worker.fail(`worker-${attempt}`, "503", attempt), true);
    assert.equal(checker.getState(), "DELAYED_RETRY");
    assert.equal(await worker.wakeDue(attempt), true);
  }
  assert.equal(await worker.begin("worker-4"), true);
  assert.equal(await worker.fail("worker-4", "503", 4), true);
  assert.equal(checker.getState(), "FAILED");
  assert.equal(checker.getContext().retries, 3);
  assert.equal(await redis.lpop("jobs:dead"), "job-42");
  assert.equal(await redis.get("job-42:lock"), null);
});

test("TypeScript worker rejects stale settlement without deleting the new lock", async () => {
  const { redis, checker, worker } = setup();
  await worker.enqueue();
  assert.equal(await worker.begin("worker-a"), true);
  assert.equal(await worker.recoverLease("supervisor-token"), true);
  assert.equal(checker.getState(), "WAITING");
  assert.equal(await worker.begin("worker-b"), true);
  assert.equal(await worker.succeed("worker-a", "stale"), false);
  assert.equal(worker.lastRejection?.violation?.code, "GUARD_FAILED");
  assert.equal(await redis.get("job-42:lock"), "worker-b");
  assert.equal(await redis.get("job-42:result"), null);
  assert.equal(await worker.succeed("worker-b", "fresh"), true);
  assert.equal(await redis.get("job-42:result"), "fresh");
});

test("TypeScript worker routes a fatal failure directly to dead letter", async () => {
  const { redis, checker, worker } = setup();
  await worker.enqueue();
  assert.equal(await worker.begin("worker-a"), true);
  assert.equal(await worker.fail("worker-a", "invalid payload", 0, true), true);
  assert.equal(checker.getState(), "FAILED");
  assert.equal(checker.getContext().retries, 0);
  assert.equal(await redis.lpop("jobs:dead"), "job-42");
  assert.equal(await redis.get("job-42:result"), null);
});

test("Python worker exercises the offline lifecycles and Redis rollback", () => {
  const script = join(process.cwd(), "examples/job-queue-benchmark/python_worker.py");
  const run = spawnSync("python3", ["-B", script, "--self-test"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    happy: "COMPLETED", recovery: "COMPLETED", exhausted: "FAILED", fencing: "COMPLETED", rollback: "DELAYED_RETRY",
  });
});

test("wakeDue restores delayed membership when queue insertion throws after mutation", async () => {
  class ThrowingRedis extends MemoryRedis {
    failWaitPush = false;
    override async lpush(key: string, value: string): Promise<number> {
      const count = await super.lpush(key, value);
      if (key === "jobs:wait" && this.failWaitPush) { this.failWaitPush = false; throw new Error("injected Redis failure"); }
      return count;
    }
  }
  const redis = new ThrowingRedis();
  const checker = new WorldChecker();
  const worker = new JobWorker(redis, checker, "job-42");
  await worker.enqueue();
  assert.equal(await worker.begin("worker-a"), true);
  assert.equal(await worker.fail("worker-a", "503", 100), true);
  redis.failWaitPush = true;
  await assert.rejects(worker.wakeDue(100), /injected Redis failure/);
  assert.equal(checker.getState(), "DELAYED_RETRY");
  assert.deepEqual(await redis.zrangebyscore("jobs:delayed", "-inf", 100), ["job-42"]);
  assert.equal(await redis.lpop("jobs:wait"), null);
  assert.equal(await worker.wakeDue(100), true);
});

test("begin leaves a foreign queued job available to its owner", async () => {
  const redis = new MemoryRedis();
  const worker = new JobWorker(redis, new WorldChecker(), "job-42");
  await redis.lpush("jobs:wait", "job-99");
  assert.equal(await worker.begin("worker-a"), false);
  assert.equal(await redis.lpop("jobs:wait"), "job-99");
  assert.equal(await redis.lpop("jobs:active"), null);
});

test("wakeDue restores the due job when the gate rejects", async () => {
  const { redis, checker, worker } = setup();
  await worker.enqueue();
  assert.equal(await worker.begin("worker-a"), true);
  assert.equal(await worker.fail("worker-a", "503", 100), true);
  checker.reset();
  assert.equal(await worker.wakeDue(100), false);
  assert.deepEqual(await redis.zrangebyscore("jobs:delayed", "-inf", 100), ["job-42"]);
  assert.equal(await redis.lpop("jobs:wait"), null);
});

test("begin returns a rejected job to wait when the lock token is empty", async () => {
  const { redis, worker } = setup();
  await worker.enqueue();
  assert.equal(await worker.begin(""), false);
  assert.equal(await redis.lpop("jobs:active"), null);
  assert.equal(await redis.lpop("jobs:wait"), "job-42");
});
