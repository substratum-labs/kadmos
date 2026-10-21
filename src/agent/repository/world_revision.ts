import type { ApprovedWorldChange, WorldChangeInput, WorldChangeProposal, WorldRevision } from './contracts.js';
/** Task B stubs. Digests are explicitly invalid; no approval or revision is activated. */
export function proposeWorldChange(input: WorldChangeInput): WorldChangeProposal { return { ...input, patchDigest: 'sha256:pending', proposalDigest: 'sha256:pending' }; }
export function activateWorldRevision(input: ApprovedWorldChange): WorldRevision { return { ...input.current, state: 'pending' }; }
