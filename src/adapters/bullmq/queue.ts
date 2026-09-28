import { randomUUID } from "node:crypto";
import { Job } from "./job.js";
import { keys, parseRaw } from "./lifecycle.js";
import { resolveRedis, type RedisTransport } from "./redis.js";
import type { JobOptions, QueueOptions, RawJobData } from "./types.js";

export class Queue<DataType = any, ReturnType = any> {
  readonly name: string;
  readonly prefix: string;
  readonly redis: RedisTransport;
  constructor(name: string, opts: QueueOptions = {}) {
    this.name = name; this.prefix = opts.prefix ?? "kadmos"; this.redis = resolveRedis(opts.connection);
  }
  async add(jobName: string, data: DataType, opts: JobOptions = {}): Promise<Job<DataType, ReturnType>> {
    const id = opts.jobId ?? randomUUID(); const k = keys(this.prefix, this.name);
    if ((await this.redis.hsetnx(k.job(id), "id", id)) === 0) throw new Error(`Job ${id} already exists`);
    try {
      const delay = Math.max(0, opts.delay ?? 0);
      const raw: RawJobData = { id, name: jobName, data: JSON.stringify(data), opts: JSON.stringify(opts), state: delay > 0 ? "delayed" : "waiting", returnvalue: "", failedReason: "", attemptsMade: "0", progress: "0", lockToken: "", lockEpoch: "0", lockAcquiredAt: "" };
      const job = new Job<DataType, ReturnType>(raw, this.redis, this.prefix, this.name);
      await this.redis.hset(k.job(id), raw as unknown as Record<string, string>);
      if (delay > 0) await this.redis.zadd(k.delayed, Date.now() + delay, id);
      else await this.redis.lpush(k.wait, id);
      return job;
    } catch (error) {
      await this.redis.del(k.job(id));
      throw error;
    }
  }
  async getJob(jobId: string): Promise<Job<DataType, ReturnType> | null> {
    const raw = parseRaw(await this.redis.hgetall(keys(this.prefix, this.name).job(jobId)));
    return raw ? new Job(raw, this.redis, this.prefix, this.name) : null;
  }
  async pause(): Promise<void> { await this.redis.set(keys(this.prefix, this.name).paused, "1"); }
  async resume(): Promise<void> { await this.redis.del(keys(this.prefix, this.name).paused); }
  async isPaused(): Promise<boolean> { return (await this.redis.get(keys(this.prefix, this.name).paused)) === "1"; }
  async count(): Promise<number> { const k = keys(this.prefix, this.name); return (await this.redis.llen(k.wait)) + (await this.redis.llen(k.active)) + (await this.redis.zcard(k.delayed)); }
  async close(): Promise<void> { /* Caller-owned transport remains usable by workers and events. */ }
}
