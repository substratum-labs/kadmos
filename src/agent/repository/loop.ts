import { REPOSITORY_CONTRACT, type RepositoryRunOptions, type RepositoryRunRecord } from './contracts.js';
/** Task B stub: no backend, verifier, effect or delivery is executed. */
export async function runRepositoryTask(options: RepositoryRunOptions): Promise<RepositoryRunRecord> {
  const now = Date.now();
  return { schema: REPOSITORY_CONTRACT, runId: options.runId, status: 'incomplete', limits: options.limits,
    startedAt: new Date(now).toISOString(), deadlineEpochMs: now + options.limits.overallMs,
    attempts: [], revisions: [options.revision], effects: [], delivery: null, diagnostics: ['NOT_IMPLEMENTED: repository loop'] };
}
