import { WorldChecker } from "./spec/world_checker.js";
import type { StepVerdict, WorldDirective } from "./spec/ports.js";

// The method names and arguments match ioredis; inject an ioredis client in production.
export interface RedisTransport {
  lpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  rpoplpush(source: string, destination: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  zadd(key: string, score: number, value: string): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, value: string): Promise<number>;
}

export class MemoryRedis implements RedisTransport {
  private lists = new Map<string, string[]>();
  private strings = new Map<string, string>();
  private sets = new Map<string, Map<string, number>>();
  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value); this.lists.set(key, list); return list.length;
  }
  async lpop(key: string): Promise<string | null> { return this.lists.get(key)?.shift() ?? null; }
  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    let removed = 0;
    for (let i = 0; i < list.length && (count === 0 || removed < count);) {
      if (list[i] === value) { list.splice(i, 1); removed++; } else i++;
    }
    return removed;
  }
  async rpoplpush(source: string, destination: string): Promise<string | null> {
    const value = this.lists.get(source)?.pop();
    if (value === undefined) return null;
    await this.lpush(destination, value); return value;
  }
  async set(key: string, value: string): Promise<string> { this.strings.set(key, value); return "OK"; }
  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  async del(key: string): Promise<number> { return Number(this.strings.delete(key)); }
  async zadd(key: string, score: number, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Map<string, number>();
    const added = Number(!set.has(value)); set.set(value, score); this.sets.set(key, set); return added;
  }
  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const lower = min === "-inf" ? -Infinity : Number(min);
    const upper = max === "+inf" ? Infinity : Number(max);
    return [...(this.sets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => score >= lower && score <= upper)
      .sort((a, b) => a[1] - b[1]).map(([value]) => value);
  }
  async zrem(key: string, value: string): Promise<number> { return Number(this.sets.get(key)?.delete(value) ?? false); }
}

export class JobWorker {
  lastRejection: StepVerdict | null = null;
  constructor(
    private readonly redis: RedisTransport,
    readonly checker: WorldChecker,
    readonly jobId: string,
  ) {}
  private get lockKey(): string { return `${this.jobId}:lock`; }
  private permit(transitionId: string, directive: WorldDirective, payload: Record<string, string>): boolean {
    const verdict = this.checker.step({ transitionId, proposedDirective: directive, eventPayload: payload });
    if (!verdict.allowed || verdict.directiveAllowed !== directive) {
      this.lastRejection = verdict;
      return false;
    }
    this.lastRejection = null;
    return true;
  }
  private async settle(transitionId: string, directive: WorldDirective, payload: Record<string, string>, effect: () => Promise<void>): Promise<boolean> {
    const lock = await this.redis.get(this.lockKey);
    const resultKey = `${this.jobId}:result`;
    const result = await this.redis.get(resultKey);
    if (!this.permit(transitionId, directive, payload)) return false;
    try {
      await effect();
      return true;
    } catch (error) {
      // A command may throw after writing, so remove every possible partial destination.
      await this.redis.lrem("jobs:wait", 0, this.jobId);
      await this.redis.zrem("jobs:delayed", this.jobId);
      await this.redis.lrem("jobs:dead", 0, this.jobId);
      if (result === null) await this.redis.del(resultKey);
      else await this.redis.set(resultKey, result);
      if (lock === null) await this.redis.del(this.lockKey);
      else await this.redis.set(this.lockKey, lock);
      await this.redis.lrem("jobs:active", 0, this.jobId);
      await this.redis.lpush("jobs:active", this.jobId);
      this.checker.rollbackLastStep();
      throw error;
    }
  }
  async enqueue(): Promise<void> { await this.redis.lpush("jobs:wait", this.jobId); }
  async begin(token: string): Promise<boolean> {
    const id = await this.redis.rpoplpush("jobs:wait", "jobs:active");
    if (id === null) return false;
    if (id !== this.jobId) {
      await this.redis.lrem("jobs:active", 1, id);
      await this.redis.lpush("jobs:wait", id);
      return false;
    }
    if (!this.permit("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token })) {
      await this.redis.lrem("jobs:active", 1, id);
      await this.redis.lpush("jobs:wait", id);
      return false;
    }
    await this.redis.set(this.lockKey, token);
    return true;
  }
  async recoverLease(supervisorToken: string): Promise<boolean> {
    return this.settle("RECOVER_STALE_LEASE", "EVICT_STALE_WORKER", { supervisor_token: supervisorToken }, async () => {
      await this.redis.del(this.lockKey);
      await this.redis.lrem("jobs:active", 1, this.jobId);
      await this.enqueue();
    });
  }
  async succeed(token: string, result_digest: string): Promise<boolean> {
    return this.settle("REPORT_SUCCESS", "PERSIST_RESULT", { token, result_digest }, async () => {
      await this.redis.set(`${this.jobId}:result`, result_digest);
      await this.redis.del(this.lockKey);
      await this.redis.lrem("jobs:active", 1, this.jobId);
    });
  }
  async fail(token: string, reason: string, dueAt: number, fatal = false): Promise<boolean> {
    const exhausted = this.checker.getContext().retries >= this.checker.getContext().max_retries;
    const transitionId = fatal ? "REPORT_FATAL_FAILURE" : exhausted ? "RETRY_EXHAUSTED" : "REPORT_RETRYABLE_FAILURE";
    const directive = fatal || exhausted ? "TRIGGER_DEAD_LETTER_ALERT" : "SCHEDULE_BACKOFF";
    return this.settle(transitionId, directive, { token, reason }, async () => {
      await this.redis.del(this.lockKey);
      await this.redis.lrem("jobs:active", 1, this.jobId);
      if (directive === "SCHEDULE_BACKOFF") await this.redis.zadd("jobs:delayed", dueAt, this.jobId);
      else await this.redis.lpush("jobs:dead", this.jobId);
    });
  }
  async wakeDue(now: number): Promise<boolean> {
    const due = await this.redis.zrangebyscore("jobs:delayed", "-inf", now);
    if (!due.includes(this.jobId)) return false;
    try {
      if (!await this.redis.zrem("jobs:delayed", this.jobId)) return false;
      await this.enqueue();
      if (this.permit("RETRY_DELAY_ELAPSED", "ENQUEUE_FOR_PICKUP", {})) return true;
    } catch (error) {
      await this.redis.lrem("jobs:wait", 1, this.jobId);
      await this.redis.zadd("jobs:delayed", now, this.jobId);
      throw error;
    }
    await this.redis.lrem("jobs:wait", 1, this.jobId);
    await this.redis.zadd("jobs:delayed", now, this.jobId);
    return false;
  }
}
