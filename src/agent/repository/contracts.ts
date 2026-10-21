/** Repository loop v1. Interfaces only: behavior is intentionally pending. */
export const REPOSITORY_CONTRACT = 'kadmos.repository.v1' as const;
export const DEFAULT_LIMITS: RunLimits = Object.freeze({ maxAttempts: 3, attemptMs: 1_200_000, verifierMs: 300_000, overallMs: 5_400_000, killGraceMs: 2_000 });
export type Digest = `sha256:${string}`;
export type Usage = { readonly tokens: number; readonly costUsd: number | 'unknown' } | 'unknown';
export interface RunLimits { readonly maxAttempts: number; readonly attemptMs: number; readonly verifierMs: number; readonly overallMs: number; readonly killGraceMs: number }
export interface FileIdentity { readonly path: string; readonly sha256: Digest; readonly executable: boolean }
export interface CandidateIdentity {
  readonly baseCommit: string;
  readonly digest: Digest;
  readonly files: readonly FileIdentity[];
  readonly deleted: readonly string[];
}
export interface InputBinding {
  readonly requirements: Digest; readonly world: Digest; readonly seam: Digest;
  readonly policy: Digest; readonly candidate: CandidateIdentity; readonly revisionId: string;
}
export interface VerifierCommand {
  readonly id: string; readonly executable: string; readonly argv: readonly string[];
  readonly cwd: string; readonly programDigest: Digest;
}
export interface RepositoryPolicy {
  readonly sourceRoot: string; readonly baseCommit: string;
  readonly allowedPaths: readonly string[]; readonly protectedPaths: readonly string[];
  readonly excludedOutputs: readonly string[]; readonly verifiers: readonly VerifierCommand[];
}
export interface CodingTask {
  readonly runId: string; readonly attemptId: string; readonly workspace: string;
  readonly instructions: string; readonly binding: InputBinding; readonly limits: RunLimits;
  readonly deadlineEpochMs: number; readonly artifactDir: string;
  readonly feedback: readonly string[];
}
export interface ProcessEvidence {
  readonly executable: string; readonly version: string; readonly argv: readonly string[];
  readonly cwd: string; readonly pid: number | null; readonly processGroup: number | null;
  readonly exitCode: number | null; readonly signal: string | null;
  readonly stdoutPath: string; readonly stderrPath: string;
  readonly startedAt: string | null; readonly endedAt: string | null;
  readonly treeStopped: boolean | 'unknown'; readonly usage: Usage;
}
export type BackendStatus = 'not_started' | 'exited' | 'timeout' | 'cancelled' | 'quota' | 'malformed' | 'launch_failed';
export interface CodingResult {
  readonly runId: string; readonly attemptId: string; readonly status: BackendStatus;
  readonly process: ProcessEvidence; readonly candidate: CandidateIdentity | null;
  readonly diagnostics: readonly string[];
  // Deliberately no acceptance field. An exited process never grants delivery.
}
export interface CodingBackend { run(task: CodingTask, signal: AbortSignal): Promise<CodingResult> }
export interface BackendOptions {
  readonly executable: string;
  /** Test launchers may prefix a host-owned executable fixture. No shell. */
  readonly prefixArgs: readonly string[];
}
export type FailureRoute = 'CODE_REPAIR' | 'WORLD_CHANGE_REQUIRED' | 'CORE_MISMATCH' | 'ENVIRONMENT_BLOCKED' | 'NEEDS_REVIEW';
export interface CheckReceipt {
  readonly checkId: string; readonly command: VerifierCommand;
  readonly status: 'passed' | 'failed' | 'timeout' | 'launch_failed' | 'cancelled';
  readonly process: ProcessEvidence;
}
export interface VerificationInput {
  readonly runId: string; readonly attemptId: string; readonly workspace: string;
  readonly binding: InputBinding; readonly policy: RepositoryPolicy; readonly artifactDir: string;
  readonly limits: RunLimits; readonly deadlineEpochMs: number;
}
export interface VerificationReceipt {
  readonly runId: string; readonly attemptId: string;
  readonly status: 'incomplete' | 'passed' | 'failed' | 'drift' | 'protected_change';
  readonly before: InputBinding; readonly after: InputBinding | null;
  readonly checks: readonly CheckReceipt[]; readonly diagnostics: readonly string[];
  readonly failureKind: 'compile' | 'functional' | 'guard' | 'requirement' | 'core' | 'environment' | 'ambiguous' | null;
}
export interface WorldRevision {
  readonly id: string; readonly world: Digest; readonly seam: Digest;
  readonly parentId: string | null; readonly proposalId: string | null;
  readonly worldPath: string; readonly seamPaths: readonly string[];
  readonly state: 'pending' | 'rejected' | 'active'; readonly staleReceiptIds: readonly string[];
}
export interface WorldChangeInput {
  readonly runId: string; readonly proposalId: string; readonly base: WorldRevision;
  /** Exact complete replacement World YAML, not an executable patch. */
  readonly patch: string; readonly artifactDir: string; readonly rationale: string; readonly requirements: Digest;
}
export interface WorldChangeProposal extends WorldChangeInput { readonly patchDigest: Digest; readonly proposalDigest: Digest }
export interface OperatorDecision {
  readonly command: 'approve-world' | 'reject-world'; readonly operator: string;
  readonly runId: string; readonly proposalId: string; readonly proposalDigest: Digest;
  readonly baseRevisionId: string; readonly baseWorld: Digest; readonly patchDigest: Digest;
  readonly recordedAt: string;
}
export interface ApprovedWorldChange {
  readonly proposal: WorldChangeProposal; readonly current: WorldRevision;
  /** Host-controlled record path, outside candidate edit set; never model prose. */
  readonly decisionPath: string; readonly runId: string;
  readonly historicalReceiptIds: readonly string[];
}
export interface AttemptRecord { readonly id: string; readonly revisionId: string; readonly backend: CodingResult; readonly verification: VerificationReceipt | null; readonly route: FailureRoute }
export interface EffectRecord {
  readonly operationId: string; readonly outcome: 'not_committed' | 'committed' | 'unknown';
  readonly reconciliation: 'not_needed' | 'queried' | 'unavailable'; readonly effectCount: number | 'unknown';
  readonly checkerRollback: boolean; readonly trace: readonly string[];
}
export interface DeliveryManifest {
  readonly schema: typeof REPOSITORY_CONTRACT; readonly binding: InputBinding;
  readonly receiptIds: readonly string[]; readonly files: readonly FileIdentity[];
}
export interface RepositoryRunOptions {
  readonly runId: string; readonly source: string; readonly artifactDir: string;
  readonly requirementsPath: string; readonly worldPath: string; readonly seamPaths: readonly string[];
  readonly instructions: string; readonly policy: RepositoryPolicy; readonly backend: CodingBackend;
  readonly limits: RunLimits; readonly signal: AbortSignal;
  readonly revision: WorldRevision;
  readonly decisionsDir: string;
}
export interface RepositoryRunRecord {
  readonly schema: typeof REPOSITORY_CONTRACT; readonly runId: string;
  readonly status: 'incomplete' | 'blocked' | 'awaiting_world' | 'delivered';
  readonly limits: RunLimits; readonly startedAt: string; readonly deadlineEpochMs: number;
  readonly attempts: readonly AttemptRecord[]; readonly revisions: readonly WorldRevision[];
  readonly effects: readonly EffectRecord[]; readonly delivery: DeliveryManifest | null;
  readonly diagnostics: readonly string[];
}
