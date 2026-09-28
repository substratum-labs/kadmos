import type { RedisTransport } from "./redis.js";
import type { Job } from "./job.js";

export interface QueueOptions {
  connection?: RedisTransport | "mock" | { duplicate(): unknown };
  prefix?: string;
}
export interface WorkerOptions extends QueueOptions {
  concurrency?: number;
  lockDuration?: number;
}
export interface JobOptions {
  attempts?: number;
  delay?: number;
  backoff?: { type: "fixed" | "exponential" | string; delay: number } | number;
  jobId?: string;
}
export type Processor<DataType = any, ReturnType = any> = (job: Job<DataType, ReturnType>) => Promise<ReturnType> | ReturnType;
export type JobState = "waiting" | "active" | "delayed" | "completed" | "failed" | "unknown";
export interface RawJobData {
  id: string;
  name: string;
  data: string;
  opts: string;
  state: JobState;
  returnvalue: string;
  failedReason: string;
  attemptsMade: string;
  progress: string;
  lockToken: string;
}
