import { WorldChecker } from "../../../examples/job-queue-benchmark/spec/world_checker.js";
import type { WorldDirective } from "../../../examples/job-queue-benchmark/spec/ports.js";
import type { RawJobData } from "./types.js";

export function keys(prefix: string, name: string) {
  const base = prefix === "kadmos" ? `kadmos:${name}` : `${prefix}:${name}`;
  return { base, wait: `${base}:wait`, active: `${base}:active`, delayed: `${base}:delayed`, completed: `${base}:completed`, failed: `${base}:failed`, paused: `${base}:paused`, events: `${base}:events`, job: (id: string) => `${base}:job:${id}` };
}
export function step(checker: WorldChecker, transitionId: string, proposedDirective: WorldDirective, eventPayload: Record<string, string> = {}): void {
  const verdict = checker.step({ transitionId, proposedDirective, eventPayload });
  if (!verdict.allowed) throw new Error(`Unconstitutional job transition: ${verdict.violation?.code}: ${verdict.violation?.message}`);
}
export async function settle<T>(checker: WorldChecker, transitionId: string, directive: WorldDirective, payload: Record<string, string>, mutate: () => Promise<T>, compensate?: () => Promise<void>): Promise<T> {
  step(checker, transitionId, directive, payload);
  try { return await mutate(); }
  catch (error) {
    try { await compensate?.(); } finally { checker.rollbackLastStep(); }
    throw error;
  }
}
export function checkerFor(raw: RawJobData): WorldChecker {
  const checker = new WorldChecker();
  const attempts = Math.max(1, raw.opts ? (JSON.parse(raw.opts) as { attempts?: number }).attempts ?? 1 : 1);
  const retries = Number(raw.attemptsMade || 0);
  const epoch = Number(raw.lockEpoch || 0);
  const needsAcquire = raw.state === "active" || raw.state === "completed" || raw.state === "failed" || (raw.state === "delayed" && retries > 0);
  checker.reset({ job_id: raw.id, max_retries: Math.max(attempts - 1, retries), lock_epoch: Math.max(0, epoch - Number(needsAcquire)), retries: raw.state === "delayed" && retries > 0 ? retries - 1 : retries });
  if (needsAcquire) {
    const token = raw.state === "active" ? raw.lockToken : "rehydrate-terminal";
    step(checker, "ACQUIRE_LOCK", "DISPATCH_PAYLOAD", { token });
    if (raw.state === "delayed") step(checker, "REPORT_RETRYABLE_FAILURE", "SCHEDULE_BACKOFF", { token, reason: raw.failedReason || "retry" });
    if (raw.state === "completed") step(checker, "REPORT_SUCCESS", "PERSIST_RESULT", { token, result_digest: raw.returnvalue || "" });
    if (raw.state === "failed") step(checker, "REPORT_FATAL_FAILURE", "TRIGGER_DEAD_LETTER_ALERT", { token, reason: raw.failedReason || "failed" });
  }
  if (raw.state === "revoked") step(checker, "CANCEL_FROM_WAITING", "NOTIFY_CANCELLATION");
  return checker;
}
export function parseRaw(hash: Record<string, string>): RawJobData | null {
  return hash.id ? hash as unknown as RawJobData : null;
}
