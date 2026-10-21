import type { VerificationInput, VerificationReceipt } from './contracts.js';
/** Task B stub: missing checks remain incomplete. */
export async function verifyCandidate(input: VerificationInput, _signal: AbortSignal): Promise<VerificationReceipt> {
  return { runId: input.runId, attemptId: input.attemptId, status: 'incomplete', before: input.binding,
    after: null, checks: [], diagnostics: ['NOT_IMPLEMENTED: verifier'], failureKind: null };
}
