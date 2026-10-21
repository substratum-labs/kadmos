import type { CandidateIdentity, RepositoryPolicy } from './contracts.js';
export interface WorkspaceRequest { readonly source: string; readonly destination: string; readonly policy: RepositoryPolicy }
export interface WorkspaceResult { readonly status: 'pending' | 'created' | 'refused'; readonly workspace: string | null; readonly diagnostics: readonly string[] }
/** Task B stub. No checkout or traversal is performed. */
export function createWorkspace(_input: WorkspaceRequest): WorkspaceResult { return { status: 'pending', workspace: null, diagnostics: ['NOT_IMPLEMENTED: workspace'] }; }
export function snapshotCandidate(_workspace: string, policy: RepositoryPolicy): CandidateIdentity {
  return { baseCommit: policy.baseCommit, digest: 'sha256:pending', files: [], deleted: [] };
}
