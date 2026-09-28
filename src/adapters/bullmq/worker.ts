import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WorldChecker } from "../../../examples/job-queue-benchmark/spec/world_checker.js";
import { Job } from "./job.js";
import { checkerFor, keys, parseRaw, settle } from "./lifecycle.js";
import { resolveRedis, type RedisTransport } from "./redis.js";
import type { JobOptions, Processor, RawJobData, WorkerOptions } from "./types.js";

export class Worker<DataType = any, ReturnType = any> extends EventEmitter {
  readonly name: string;
  readonly opts: WorkerOptions;
  private readonly redis: RedisTransport;
  private readonly prefix: string;
  private readonly processor: Processor<DataType, ReturnType>;
  private readonly active = new Set<Promise<void>>();
  private readonly localProcessing = new Set<string>();
  private stopped = false;
  private paused = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly concurrency: number;
  private draining = false;
  private readonly lockDuration: number;
  constructor(name: string, processor: Processor<DataType, ReturnType>, opts: WorkerOptions = {}) {
    super(); this.name = name; this.processor = processor; this.opts = opts;
    this.prefix = opts.prefix ?? "kadmos"; this.redis = resolveRedis(opts.connection);
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.lockDuration = Math.max(1, opts.lockDuration ?? 30000);
    this.schedule();
  }
  private schedule(): void {
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), 10);
  }
  private report(error: unknown): void {
    if (this.listenerCount("error")) this.emit("error", error instanceof Error ? error : new Error(String(error)));
  }
  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.paused) {
        const k = keys(this.prefix, this.name);
        if ((await this.redis.get(k.paused)) !== "1") {
          await this.recoverStaleLeases();
          await this.wakeDue();
          while (!this.stopped && !this.paused && this.active.size < this.concurrency) {
            const id = await this.redis.rpoplpush(k.wait, k.active);
            if (!id) break;
            let task!: Promise<void>;
            task = this.process(id).catch(error => this.report(error)).finally(() => this.active.delete(task));
            this.active.add(task);
          }
          if (this.active.size === 0 && !this.draining && await this.redis.llen(k.wait) === 0 && await this.redis.zcard(k.delayed) === 0) {
            this.draining = true;
            this.emit("drained");
            await this.redis.publish(k.events, JSON.stringify({ event: "drained" }));
          }
        }
      }
    } catch (error) { this.report(error); }
    finally { this.schedule(); }
  }
  private async wakeDue(): Promise<void> {
    const k = keys(this.prefix, this.name);
    const due = await this.redis.zrangebyscore(k.delayed, "-inf", Date.now());
    for (const id of due) {
      if ((await this.redis.zrem(k.delayed, id)) === 0) continue;
      try {
        const raw = parseRaw(await this.redis.hgetall(k.job(id)));
        if (!raw || raw.state !== "delayed") continue;
        if (Number(raw.attemptsMade) === 0) {
          await this.redis.transitionJob({ jobKey: k.job(id), id, expectedState: "delayed", changes: { state: "waiting" }, pushList: k.wait });
        } else {
          const checker = checkerFor(raw);
          await settle(checker, "RETRY_DELAY_ELAPSED", "ENQUEUE_FOR_PICKUP", {}, async () => {
            return this.redis.transitionJob({ jobKey: k.job(id), id, expectedState: "delayed", changes: { state: "waiting" }, pushList: k.wait });
          });
        }
        this.draining = false;
      } catch (error) {
        await this.redis.zadd(k.delayed, Date.now(), id);
        throw error;
      }
    }
  }
  private async recoverStaleLeases(): Promise<void> {
    const k = keys(this.prefix, this.name);
    for (const id of await this.redis.lrange(k.active, 0, -1)) {
      if (this.localProcessing.has(id)) continue;
      const raw = parseRaw(await this.redis.hgetall(k.job(id)));
      if (!raw) { await this.redis.lrem(k.active, 0, id); continue; }
      if (raw.state === "waiting") {
        await this.redis.transitionJob({ jobKey: k.job(id), id, expectedState: "waiting", expectedToken: raw.lockToken || "", changes: {}, removeList: k.active, pushList: k.wait });
        continue;
      }
      if (raw.state !== "active") { await this.redis.lrem(k.active, 0, id); continue; }
      if (raw.lockAcquiredAt && Date.now() - Number(raw.lockAcquiredAt) <= this.lockDuration) continue;
      const checker = raw.lockToken ? checkerFor(raw) : checkerFor({ ...raw, lockToken: "unclaimed-lease", lockEpoch: String(Math.max(1, Number(raw.lockEpoch || 0))) });
      await settle(checker, "RECOVER_STALE_LEASE", "EVICT_STALE_WORKER", { supervisor_token: "lease-recovery" }, async () => {
        return this.redis.transitionJob({ jobKey: k.job(id), id, expectedState: "active", expectedToken: raw.lockToken,
          expectedLease: raw.lockAcquiredAt, changes: { state: "waiting", lockToken: "", lockEpoch: String(checker.getContext().lock_epoch), lockAcquiredAt: "" },
          removeList: k.active, pushList: k.wait });
      });
      this.draining = false;
    }
  }
  private async process(id: string): Promise<void> {
    const k = keys(this.prefix, this.name);
    const raw = parseRaw(await this.redis.hgetall(k.job(id)));
    if (!raw || raw.state !== "waiting") { await this.redis.lrem(k.active, 1, id); return; }
    const token = randomUUID();
    const checker = checkerFor(raw);
    const claimed = await settle(checker, "ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token }, async () => this.redis.transitionJob({
      jobKey: k.job(id), id, expectedState: "waiting", expectedToken: raw.lockToken || "",
      requireList: k.active,
      changes: { state: "active", lockToken: token, lockEpoch: String(Number(raw.lockEpoch || 0) + 1), lockAcquiredAt: String(Date.now()) },
    }));
    if (!claimed) return;
    this.draining = false;
    const job = new Job<DataType, ReturnType>({ ...raw, state: "active", lockToken: token, lockEpoch: String(Number(raw.lockEpoch || 0) + 1) }, this.redis, this.prefix, this.name);
    this.localProcessing.add(id);
    const heartbeat = setInterval(() => {
      void this.redis.transitionJob({ jobKey: k.job(id), id, expectedState: "active", expectedToken: token,
        changes: { lockAcquiredAt: String(Date.now()) } }).catch(error => this.report(error));
    }, Math.max(10, Math.floor(this.lockDuration / 2)));
    // Forward job progress to the worker as well as QueueEvents.
    const onProgress = (message: string) => {
      try { const event = JSON.parse(message) as { event: string; jobId: string; data: unknown }; if (event.event === "progress" && event.jobId === id) this.emit("progress", job, event.data); }
      catch (error) { this.report(error); }
    };
    try {
      await this.redis.subscribe(k.events, onProgress);
      let result: ReturnType;
      try { result = await this.processor(job); }
      catch (error) { await this.failJob(job, checker, token, error); return; }
      const fresh = parseRaw(await this.redis.hgetall(k.job(id)));
      if (!fresh || fresh.state !== "active" || fresh.lockToken !== token) return;
      const settled = await settle(checker, "REPORT_SUCCESS", "PERSIST_RESULT", { token, result_digest: JSON.stringify(result) ?? "null" }, async () => this.redis.transitionJob({
        jobKey: k.job(id), id, expectedState: "active", expectedToken: token,
        changes: { state: "completed", returnvalue: JSON.stringify(result) ?? "null", failedReason: "", lockToken: "", lockAcquiredAt: "" },
        removeList: k.active, addSet: { key: k.completed, score: Date.now() },
      }));
      if (!settled) return;
      job.returnvalue = result;
      this.emit("completed", job, result);
      await this.redis.publish(k.events, JSON.stringify({ event: "completed", jobId: id, returnvalue: result, prev: "active" }));
    } finally {
      clearInterval(heartbeat);
      this.localProcessing.delete(id);
      await this.redis.unsubscribe(k.events, onProgress);
    }
  }
  private async failJob(job: Job<DataType, ReturnType>, checker: WorldChecker, token: string, error: unknown): Promise<void> {
      const id = job.id; const k = keys(this.prefix, this.name);
      const fresh = parseRaw(await this.redis.hgetall(k.job(id)));
      if (!fresh || fresh.state !== "active" || fresh.lockToken !== token) return;
      const reason = error instanceof Error ? error.message : String(error);
      const opts = JSON.parse(fresh.opts) as JobOptions;
      const attempts = Math.max(1, opts.attempts ?? 1);
      const retryable = Number(fresh.attemptsMade) < attempts - 1;
      if (retryable) {
        const backoff = typeof opts.backoff === "number" ? opts.backoff : opts.backoff?.delay ?? 0;
        const delay = opts.backoff && typeof opts.backoff !== "number" && opts.backoff.type === "exponential"
          ? backoff * 2 ** Number(fresh.attemptsMade) : backoff;
        await settle(checker, "REPORT_RETRYABLE_FAILURE", "SCHEDULE_BACKOFF", { token, reason }, async () => this.redis.transitionJob({
          jobKey: k.job(id), id, expectedState: "active", expectedToken: token,
          changes: { state: "delayed", attemptsMade: String(Number(fresh.attemptsMade) + 1), failedReason: reason, lockToken: "", lockAcquiredAt: "" },
          removeList: k.active, addSet: { key: k.delayed, score: Date.now() + delay },
        }));
      } else {
        const settled = await settle(checker, "RETRY_EXHAUSTED", "TRIGGER_DEAD_LETTER_ALERT", { token, reason }, async () => this.redis.transitionJob({
          jobKey: k.job(id), id, expectedState: "active", expectedToken: token,
          changes: { state: "failed", attemptsMade: String(Number(fresh.attemptsMade) + 1), failedReason: reason, lockToken: "", lockAcquiredAt: "" },
          removeList: k.active, addSet: { key: k.failed, score: Date.now() },
        }));
        if (!settled) return;
        job.failedReason = reason;
        job.attemptsMade = Number(fresh.attemptsMade) + 1;
        this.emit("failed", job, error instanceof Error ? error : new Error(reason));
        await this.redis.publish(k.events, JSON.stringify({ event: "failed", jobId: id, failedReason: reason, prev: "active" }));
      }
  }
  async pause(doNotWaitActive = false): Promise<void> { this.paused = true; if (!doNotWaitActive) await Promise.all([...this.active]); }
  async resume(): Promise<void> { this.paused = false; }
  async close(force = false): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    if (!force) await Promise.all([...this.active]);
  }
  isRunning(): boolean { return !this.stopped && !this.paused; }
}
