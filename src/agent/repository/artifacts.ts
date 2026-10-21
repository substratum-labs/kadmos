import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { REPOSITORY_CONTRACT, type DeliveryValidationInput, type DeliveryValidation } from './contracts.js';
import { containsPath, hashBytes, safePath, snapshotCandidate } from './workspace.js';

/** Final eligibility only. The host must separately persist a complete run atomically. */
export function validateDelivery(input: DeliveryValidationInput): DeliveryValidation {
  try {
    const { receipt, expected, policy } = input;
    const require = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
    require(receipt.status === 'passed' && receipt.failureKind === null, 'verification incomplete or failed');
    require(Boolean(receipt.runId && receipt.attemptId), 'missing receipt identity');
    require(isDeepStrictEqual(receipt.before, expected) && isDeepStrictEqual(receipt.after, expected), 'verification input mismatch');
    require(hashBytes(JSON.stringify(policy)) === expected.policy, 'frozen policy mismatch');
    require(input.unresolvedEffects.length === 0, 'retained unresolved effects');
    const ids = policy.verifiers.map(x => x.id);
    require(ids.length > 0 && new Set(ids).size === ids.length, 'missing or duplicate frozen checks');
    require(new Set(input.requiredCheckIds).size === input.requiredCheckIds.length &&
      isDeepStrictEqual([...input.requiredCheckIds].sort(), [...ids].sort()), 'required checks differ from policy');
    require(receipt.checks.length === ids.length && new Set(receipt.checks.map(x => x.checkId)).size === ids.length, 'missing or duplicate receipts');
    const workspace = safePath(input.workspace);
    for (const command of policy.verifiers) {
      const check = receipt.checks.find(x => x.checkId === command.id);
      require(Boolean(check), 'missing check receipt');
      if (!check) throw new Error('missing check receipt');
      require(isDeepStrictEqual(check.command, command), 'check command differs from frozen policy');
      const process = check.process;
      require(check.status === 'passed' && process.exitCode === 0 && process.signal === null && process.treeStopped === true, 'check did not exit successfully with closed tree');
      require(process.executable === command.executable && process.cwd === command.cwd &&
        isDeepStrictEqual(process.argv, command.argv.map(x => x === '<candidate>' ? input.workspace : x)), 'process invocation mismatch');
      require(Number.isInteger(process.pid) && process.pid! > 0 && process.startedAt !== null && process.endedAt !== null &&
        Number.isFinite(Date.parse(process.startedAt)) && Number.isFinite(Date.parse(process.endedAt)) &&
        Date.parse(process.endedAt) >= Date.parse(process.startedAt), 'missing process lifecycle');
      // A script launcher freezes argv[0]; a direct executable freezes itself.
      const program = command.argv[0] && isAbsolute(command.argv[0]) ? command.argv[0] : command.executable;
      for (const path of [command.executable, program, command.cwd, process.stdoutPath, process.stderrPath]) {
        require(isAbsolute(path) && !containsPath(workspace, safePath(path)), 'host verifier paths must be outside candidate');
      }
      require(lstatSync(program).isFile() && hashBytes(readFileSync(program)) === command.programDigest, 'host verifier program drift');
      require(lstatSync(process.stdoutPath).isFile() && lstatSync(process.stderrPath).isFile(), 'missing regular process logs');
    }
    // Last operation before manifest construction: re-read exact regular input bytes and modes.
    const candidate = snapshotCandidate(input.workspace, policy);
    require(isDeepStrictEqual(candidate, expected.candidate), 'candidate drift at delivery readback');
    return { status: 'eligible', manifest: { schema: REPOSITORY_CONTRACT, binding: expected,
      receiptIds: receipt.checks.map(x => `${receipt.runId}/${receipt.attemptId}/${x.checkId}`), files: candidate.files }, diagnostics: [] };
  } catch (error) {
    return { status: 'refused', manifest: null, diagnostics: [String(error)] };
  }
}
