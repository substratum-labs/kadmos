import type { RedisTransport } from "./redis.js";
import type { JobOptions, JobState, RawJobData } from "./types.js";
import { checkerFor, keys, parseRaw, settle } from "./lifecycle.js";

export class Job<DataType = any, ReturnType = any> {
  readonly id: string;
  readonly name: string;
  readonly data: DataType;
  readonly opts: JobOptions;
  returnvalue: ReturnType | undefined;
  failedReason: string | undefined;
  attemptsMade: number;
  progress: any;
  constructor(raw: RawJobData, private readonly redis: RedisTransport, private readonly prefix: string, private readonly queueName: string) {
    this.id = raw.id; this.name = raw.name; this.data = JSON.parse(raw.data) as DataType;
    this.opts = JSON.parse(raw.opts) as JobOptions;
    this.returnvalue = raw.returnvalue ? JSON.parse(raw.returnvalue) as ReturnType : undefined;
    this.failedReason = raw.failedReason || undefined;
    this.attemptsMade = Number(raw.attemptsMade || 0);
    this.progress = raw.progress ? JSON.parse(raw.progress) : 0;
  }
  private async raw(): Promise<RawJobData> {
    const raw = parseRaw(await this.redis.hgetall(keys(this.prefix, this.queueName).job(this.id)));
    if (!raw) throw new Error(`Job ${this.id} no longer exists`);
    return raw;
  }
  async getState(): Promise<JobState> {
    const raw = parseRaw(await this.redis.hgetall(keys(this.prefix, this.queueName).job(this.id)));
    return raw?.state ?? "unknown";
  }
  async updateProgress(progress: any): Promise<void> {
    const k = keys(this.prefix, this.queueName); const raw = await this.raw();
    if (raw.state === "completed" || raw.state === "failed" || raw.state === "revoked") throw new Error("Cannot update terminal job");
    await this.redis.hset(k.job(this.id), "progress", JSON.stringify(progress));
    this.progress = progress;
    await this.redis.publish(k.events, JSON.stringify({ event: "progress", jobId: this.id, data: progress }));
  }
  async retry(): Promise<void> {
    const k = keys(this.prefix, this.queueName); const raw = await this.raw();
    if (raw.state !== "delayed") throw new Error("Only delayed retry jobs can be manually retried");
    const checker = checkerFor(raw);
    if ((await this.redis.zrem(k.delayed, this.id)) === 0) throw new Error("Delayed job already claimed");
    const retried = await settle(checker, "RETRY_DELAY_ELAPSED", "ENQUEUE_FOR_PICKUP", {}, async () => this.redis.transitionJob({
      jobKey: k.job(this.id), id: this.id, expectedState: "delayed", changes: { state: "waiting" }, pushList: k.wait,
    }));
    if (!retried) throw new Error("Job state changed during retry");
  }
  async discard(): Promise<void> {
    const k = keys(this.prefix, this.queueName); const raw = await this.raw();
    if (raw.state === "completed" || raw.state === "failed" || raw.state === "revoked") throw new Error("Cannot discard terminal job");
    const checker = checkerFor(raw);
    const transition = raw.state === "active" ? "CANCEL_FROM_ACTIVE" : raw.state === "delayed" && Number(raw.attemptsMade) > 0 ? "CANCEL_FROM_DELAYED" : "CANCEL_FROM_WAITING";
    const payload = raw.state === "active" ? { supervisor_token: "discard" } : {};
    const discarded = await settle(checker, transition, "NOTIFY_CANCELLATION", payload, async () => this.redis.transitionJob({
      jobKey: k.job(this.id), id: this.id, expectedState: raw.state, expectedToken: raw.state === "active" ? raw.lockToken : undefined,
      changes: { state: "failed", failedReason: "discarded", returnvalue: "", lockToken: "", lockAcquiredAt: "", lockEpoch: String(Math.max(1, Number(raw.lockEpoch || 0))) },
      removeList: raw.state === "active" ? k.active : k.wait, removeSet: k.delayed,
      addSet: { key: k.failed, score: Date.now() },
    }));
    if (!discarded) throw new Error("Job state changed during discard");
    this.failedReason = "discarded";
  }
}
