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
  private stopped = false;
  private paused = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly concurrency: number;
  private draining = false;
  constructor(name: string, processor: Processor<DataType, ReturnType>, opts: WorkerOptions = {}) {
    super(); this.name = name; this.processor = processor; this.opts = opts;
    this.prefix = opts.prefix ?? "kadmos"; this.redis = resolveRedis(opts.connection);
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
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
      const raw = parseRaw(await this.redis.hgetall(k.job(id)));
      if (!raw || raw.state !== "delayed") { await this.redis.zrem(k.delayed, id); continue; }
      if (Number(raw.attemptsMade) === 0) {
        await this.redis.zrem(k.delayed, id);
        await this.redis.lpush(k.wait, id);
        await this.redis.hset(k.job(id), "state", "waiting");
      } else {
        const checker = checkerFor(raw);
        await settle(checker, "RETRY_DELAY_ELAPSED", "ENQUEUE_FOR_PICKUP", {}, async () => {
          await this.redis.zrem(k.delayed, id);
          await this.redis.lpush(k.wait, id);
          await this.redis.hset(k.job(id), "state", "waiting");
        }, async () => {
          await this.redis.lrem(k.wait, 0, id);
          await this.redis.zadd(k.delayed, Date.now(), id);
          await this.redis.hset(k.job(id), raw as unknown as Record<string, string>);
        });
      }
      this.draining = false;
    }
  }
  private async process(id: string): Promise<void> {
    const k = keys(this.prefix, this.name);
    const raw = parseRaw(await this.redis.hgetall(k.job(id)));
    if (!raw || raw.state !== "waiting") { await this.redis.lrem(k.active, 1, id); return; }
    const token = randomUUID();
    const checker = checkerFor(raw);
    try {
      await settle(checker, "ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token }, async () => {
        await this.redis.hset(k.job(id), { state: "active", lockToken: token });
      }, async () => {
        await this.redis.hset(k.job(id), raw as unknown as Record<string, string>);
      });
    } catch (error) {
      await this.redis.lrem(k.active, 1, id);
      await this.redis.lpush(k.wait, id);
      throw error;
    }
    this.draining = false;
    const job = new Job<DataType, ReturnType>({ ...raw, state: "active", lockToken: token }, this.redis, this.prefix, this.name);
    // Forward job progress to the worker as well as QueueEvents.
    const onProgress = (message: string) => {
      try { const event = JSON.parse(message) as { event: string; jobId: string; data: unknown }; if (event.event === "progress" && event.jobId === id) this.emit("progress", job, event.data); }
      catch (error) { this.report(error); }
    };
    await this.redis.subscribe(k.events, onProgress);
    try {
      let result: ReturnType;
      try { result = await this.processor(job); }
      catch (error) { await this.failJob(job, checker, token, error); return; }
      const fresh = parseRaw(await this.redis.hgetall(k.job(id)));
      if (!fresh || fresh.state !== "active" || fresh.lockToken !== token) return;
      await settle(checker, "REPORT_SUCCESS", "PERSIST_RESULT", { token, result_digest: JSON.stringify(result) ?? "null" }, async () => {
        await this.redis.hset(k.job(id), { state: "completed", returnvalue: JSON.stringify(result) ?? "null", lockToken: "" });
        await this.redis.lrem(k.active, 1, id);
        await this.redis.zadd(k.completed, Date.now(), id);
      }, async () => {
        await this.redis.zrem(k.completed, id);
        await this.redis.lrem(k.active, 0, id);
        await this.redis.lpush(k.active, id);
        await this.redis.hset(k.job(id), fresh as unknown as Record<string, string>);
      });
      job.returnvalue = result;
      this.emit("completed", job, result);
      await this.redis.publish(k.events, JSON.stringify({ event: "completed", jobId: id, returnvalue: result, prev: "active" }));
    } finally { await this.redis.unsubscribe(k.events, onProgress); }
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
        await settle(checker, "REPORT_RETRYABLE_FAILURE", "SCHEDULE_BACKOFF", { token, reason }, async () => {
          await this.redis.hset(k.job(id), { state: "delayed", attemptsMade: String(Number(fresh.attemptsMade) + 1), failedReason: reason, lockToken: "" });
          await this.redis.lrem(k.active, 1, id);
          await this.redis.zadd(k.delayed, Date.now() + delay, id);
        }, async () => {
          await this.redis.zrem(k.delayed, id);
          await this.redis.lrem(k.active, 0, id);
          await this.redis.lpush(k.active, id);
          await this.redis.hset(k.job(id), fresh as unknown as Record<string, string>);
        });
      } else {
        await settle(checker, "RETRY_EXHAUSTED", "TRIGGER_DEAD_LETTER_ALERT", { token, reason }, async () => {
          await this.redis.hset(k.job(id), { state: "failed", attemptsMade: String(Number(fresh.attemptsMade) + 1), failedReason: reason, lockToken: "" });
          await this.redis.lrem(k.active, 1, id);
          await this.redis.zadd(k.failed, Date.now(), id);
        }, async () => {
          await this.redis.zrem(k.failed, id);
          await this.redis.lrem(k.active, 0, id);
          await this.redis.lpush(k.active, id);
          await this.redis.hset(k.job(id), fresh as unknown as Record<string, string>);
        });
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
