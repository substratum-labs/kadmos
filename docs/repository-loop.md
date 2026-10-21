# Repository loop interface (v1, pre-implementation)

This contract adds a future repository workflow. The existing `kadmos run`
and `kadmos.compiler.k02.v1` are unchanged. The physical backend, scripted executable backend and disposable workspace now
produce process/snapshot evidence. Verification, orchestration, World revision
and delivery modules still return pending/incomplete results. Later behavioral
tests intentionally fail. No usable repository CLI is claimed yet.

The TypeScript wire shapes are in `src/agent/repository/contracts.ts`.
Persisted objects use UTF-8 JSON; run records/manifests and command inputs carry
schema `kadmos.repository.v1` (operator decisions have their own exact shape).
Unknown process/usage/effect observations are explicit `null` or `unknown`;
zero is reserved for an observed zero. JSON never serializes an AbortSignal,
backend object or checker; these are process-local dependencies.

## Calls and authority

- `CodingBackend.run(CodingTask, AbortSignal) -> Promise<CodingResult>` edits
  a disposable workspace and reports process evidence; it cannot approve code.
- `createWorkspace(WorkspaceRequest) -> WorkspaceResult` refuses a dirty source,
  escaping paths, symlinks, special files and an existing destination.
- `snapshotCandidate(workspace, RepositoryPolicy) -> CandidateIdentity` includes
  tracked/untracked regular files, executable bits and base-relative deletions.
- `verifyCandidate(VerificationInput, AbortSignal) -> Promise<VerificationReceipt>`
  runs host-frozen argv commands, never diagnostic instructions. The exact whole
  argv token `<candidate>` is replaced with the captured workspace path; no other
  interpolation is allowed. The same token may select the command cwd. A receipt binds
  the exact before/after input tuple, commands, actual exits and raw log paths.
- `runRepositoryTask(RepositoryRunOptions) -> Promise<RepositoryRunRecord>` owns
  attempts, evidence and final delivery. Exit zero and model prose cannot deliver.
- `classifyFailure(VerificationReceipt) -> FailureRoute` chooses `CODE_REPAIR`,
  `WORLD_CHANGE_REQUIRED`, `CORE_MISMATCH`, `ENVIRONMENT_BLOCKED` or `NEEDS_REVIEW`.
  A route is evidence routing, never World or compiler authority.
- `proposeWorldChange(WorldChangeInput) -> WorldChangeProposal` records a rationale
  and exact replacement World YAML bytes (no executable patch language).
- `activateWorldRevision(ApprovedWorldChange) -> WorldRevision` loads a trusted
  operator record, validates all bound IDs/digests and that decisionPath is inside the separately
  trusted decisionsDir (with no symlink traversal), freezes a new World and
  independently regenerated seam, and marks historical receipt IDs stale.
  Rejected activation preserves the old revision. No compiler changes are allowed.

Default limits are three total backend attempts, 20 minutes per attempt,
5 minutes per verifier, 90 minutes overall and 2 seconds termination grace.
All overrides must be positive finite safe integers. The overall start/deadline
and attempt count persist across revisions and continuation; no budget reset.
Quota stops without automatic retry. Missing tools, cancellation, timeout,
malformed output and verifier launch failures never become successful evidence.

## Identity and filesystem policy

`sha256:<64 lowercase hex digits>` hashes raw file bytes. Git base commits are
full object IDs. Paths are UTF-8 relative POSIX paths; reject absolute paths,
empty components, `.`/`..`, NULs, duplicate/case-colliding paths and symlinks
(including ancestor traversal); use lstat before reads. Local mode assumes one
trusted operator and writer, with no hostile process-isolation claim.

Candidate digest is SHA-256 of compact JSON with keys in this order:
`{baseCommit,files,deleted}`. `files` is sorted by path and contains objects
`{path,sha256,executable}`; `deleted` is a sorted list relative to the frozen
base tree. Include all regular input files and untracked additions, excluding
only `.git/` metadata and explicitly declared output paths. Record deletions
rather than hashing only surviving files. Requirements and World hash raw
bytes. Seam digest hashes a sorted file-entry array with paths prefixed by the
zero-based declared seamPaths index (`0/ports.d.ts`, for example), then the
root-relative path (or basename for a single file); policy digest hashes the frozen policy JSON bytes, retained verbatim.

`allowedPaths` and `protectedPaths` are exact paths or prefixes ending `/`.
Protected paths take precedence; unknown edits fail closed. World, requirements,
generated core, acceptance tests and verifier policy are protected. A frozen verifier command declares its failure kind; a failed trusted
requirement check may request World review. Diagnostic prose cannot invent a
classification or grant authority. Launch/timeout/cancellation override that kind
with environment failure. Frozen
verifier programs, commands, digests and host decision records live outside the
candidate edit set. Candidate tests cannot replace required checks. Independently
regenerate the core; compare protected bytes and all identities before and after
checks and again at final manifest readback. A missing check, late write or
unresolved physical effect clears delivery eligibility.

`validateDelivery(DeliveryValidationInput) -> DeliveryValidation` performs the
last fresh snapshot/readback against the exact receipt, required check IDs and
retained unresolved effects; pending/failed/drifted/incomplete evidence cannot
produce an eligible manifest.

## Installed CLI invocation and process lifecycle

Measured CLI: Codex 0.163.0, macOS 27.0.1 arm64, Node 26.0.0. Resolve the installed
executable; freeze its absolute path and version in each attempt receipt.
Use `spawn(executable, argv, {cwd: workspace, shell: false, detached: true})`
on POSIX. The argv is:

```json
["exec","--json","--color","never","--sandbox","workspace-write","--cd","<absolute workspace>","-"]
```

Write literal task bytes to stdin and close it. Capture stdout JSONL and stderr
separately outside the editable workspace. Do not pass model, effort, config,
profile, ignore-user-config, bypass or shell-interpolation flags. Inherit the
operator's existing auth/model configuration. Live read-only probe used the same
argv with `read-only`: JSONL thread/turn/item events and a `turn.completed.usage`
were observed, with correct cwd. Invalid cwd failed noninteractively (exit 1).
Restricted parent sandbox initialization also failed noninteractively; it did
not produce agent success. No success/output schema from the model is authority.

Record start/end, PID/process group, actual exit/signal, logs and usage. Abort,
finite deadline, launch error and quota must stop tracked work and await closure.
POSIX cancellation sends SIGTERM to the detached group, waits at most killGraceMs,
then SIGKILL if required, and confirms closure. A measured host probe stopped an
installed CLI waiting on stdin and a heartbeat descendant in the same group.
A later bounded installed-CLI smoke made its requested disposable edit and exited
0, but a tool child changed groups: the adapter returned `launch_failed` with
`treeStopped: unknown`, no candidate and no delivery. Observed escaping children
are signalled individually; lifecycle sidecars retain tracked PID/group inventory
and remaining members. Unobserved rapid escapes remain unqualified. Such uncertainty
is retained, not success.
Windows requires measured tree termination (for example `taskkill /T /F`) before
live qualification; the adapter refuses to launch on unsupported platforms. Portable argv tests remain mandatory on Windows and Linux;
only the macOS host probe is currently qualified. No universal containment claim.

## Input files, decisions and artifacts

Future commands are `kadmos repo run --input <run.json>`,
`propose-world --input <proposal.json>`, `approve-world --input <decision.json>`,
`reject-world --input <decision.json>` and `continue --input <continue.json>`.
Run input contains source/artifact paths, requirements/World/seam paths, policy,
instructions and finite limits. Backend config identifies executable/prefix argv;
production prefix is empty. Continue identifies run/artifact directory and exact
revision; it loads immutable recorded inputs and the original budget. No stdin
or candidate-authored approval is accepted automatically.

The trusted operator deliberately executes `approve-world`; this records
command/operator/time, run ID, proposal ID/digest, base revision ID/World digest
and patch digest. Activation recomputes digests from exact bytes, checks the
current base and trusted record location, then creates a new immutable directory.
Proposal digest is SHA-256 over compact JSON with keys in this order:
`{runId,proposalId,baseRevisionId,baseWorld,requirements,patchDigest,rationale}`.
Patch digest hashes exact UTF-8 replacement YAML bytes. The recorded base revision
and World must match the current immutable revision before parsing/applying a patch.
Backend prose and a candidate-written lookalike JSON file cannot grant approval.
Local filesystem access by the operator remains a trust assumption. This contract
itself grants no authority to approve an actual business World.

The default trusted decisionsDir is `<artifactDir>/decisions`; an explicitly
configured host-owned directory is persisted with run inputs. Activation receives
that trusted root separately from the decisionPath to validate. World proposal
artifactDir names the run root, not the revisions subdirectory.

Host-owned layout:

```text
<artifactDir>/run.json                 # incomplete first; original budget/start
<artifactDir>/inputs/                  # exact requirements/policy/base identities
<artifactDir>/attempts/<id>/           # stdin, stdout.jsonl, stderr, process.json
<artifactDir>/attempts/<id>/checks/    # argv/exits/logs, before/after receipt
<artifactDir>/revisions/<id>/         # immutable World, regenerated seam, proposal
<artifactDir>/decisions/<proposal>/   # trusted deliberate operator decision
<artifactDir>/effects/<operation>/   # retained committed/not_committed/unknown
<artifactDir>/delivery.json           # only complete, revalidated manifest
```

Manifest check receipt IDs are derived as `<runId>/<attemptId>/<checkId>`;
overall verification receipt IDs use the final component `verification`. IDs
are immutable within the run and all referenced raw records/hashes are read back.
A new revision cannot borrow an old tuple or its receipt IDs.

Write artifacts atomically (temporary sibling plus rename), retain failures and
read back all referenced hashes. Partial records after crash/cancel are incomplete.
Old receipts remain historical and cannot authorize a new revision even if bytes
happen to match. Unknown remote effects are never converted to noncommit by local
checker rollback; query/reconciliation precedes settlement and automatic retry.
The example settlement seam promises per-checker serialization and record-based
reconstruction only for its bounded local actuator, not crash-durable exactly-once
payment behavior.

## Executable gates and current evidence

Build then run `node --test dist/tests/test_repository_contracts.test.js` for
compile-time seams and independent fixture qualification. Run the four scenario
files separately for A01–A19; pending modules must cause behavioral assertions to
fail, rather than missing imports, skipped tests or unconditional assertions.
A20 is a separately authorized live gate: actual installed-agent normal/repair and
exact-approved revision demonstrations, with real process/diff/check receipts.
It has no passing scripted substitute and is not executed at this stage.

Legacy tests run separately. A passing contract/legacy baseline must never be
reported as a green full suite while these intentional stubs remain.

Machine-readable input-file shapes are frozen in
[`repository-input.schema.json`](repository-input.schema.json). Runtime shape,
path, finite-budget and digest validation is required in later implementation;
this stage provides the schema, not a working command parser. TypeScript run
options replace `revisionId` with the loaded immutable `WorldRevision`, resolve
the configured backend to `CodingBackend`, and supply the process-local signal.
Proposal input loads its exact base revision; decisions must also match retained
proposal bytes rather than trusting digest fields provided by a caller.

Task C backend checks also stop remaining group members after normal parent exit.
Attempt IDs cannot overwrite earlier logs. Version probes are separately bounded
and stopped, usage is parsed only when actually reported, and missing runtime
limits fail before launch. POSIX process inventory is a local best-effort measure,
not adversarial containment. Windows live execution remains refused; Linux live
execution has not been measured. macOS system `/var` and `/tmp` aliases are
canonicalized; candidate aliases and other symlink ancestors are refused.
