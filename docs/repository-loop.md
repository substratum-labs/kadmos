# Repository loop interface (v1, D2a integration checkpoint)

Implemented D1 host APIs provide disposable workspaces, physical/scripted backend
process evidence, frozen verification contexts, real verification, delivery
eligibility, original run budgets, immutable checkpoints and complete-run
publication/readback. D1 foundation was physically accepted at 280f087.
D2a adds fixed-World orchestration and bounded diagnostic feedback, pending physical D review.
D2b repository CLI/live demonstration, E World proposal/activation, and F
effect reconciliation remain pending. Later behavioral tests intentionally
fail. Existing `kadmos run` and `kadmos.compiler.k02.v1` are unchanged.

The TypeScript wire shapes are in `src/agent/repository/contracts.ts`.
Persisted objects use UTF-8 JSON; run records/manifests and command inputs carry
schema `kadmos.repository.v1` (operator decisions have their own exact shape).
Unknown process/usage/effect observations are explicit `null` or `unknown`;
zero is reserved for an observed zero. JSON never serializes an AbortSignal,
backend object or checker; these are process-local dependencies.

## Calls and authority

Status below describes current implementation; planned behavior grants no authority.

- **Implemented D1:** `CodingBackend.run(CodingTask, AbortSignal) -> Promise<CodingResult>` edits
  a disposable workspace and reports process evidence; it cannot approve code.
- **Implemented D1:** `createWorkspace(WorkspaceRequest) -> WorkspaceResult` refuses a dirty source,
  escaping paths, symlinks, special files and an existing destination.
- **Implemented D1:** `snapshotCandidate(workspace, RepositoryPolicy) -> CandidateIdentity` includes
  tracked/untracked regular files, executable bits and base-relative deletions.
- **Implemented D1:** `verifyCandidate(VerificationInput, AbortSignal) -> Promise<VerificationReceipt>`
  runs host-frozen argv commands, never diagnostic instructions. The exact whole
  argv token `<candidate>` is replaced with the captured workspace path; no other
  interpolation is allowed. The same token may select the command cwd. A receipt binds
  the exact before/after input tuple, commands, actual exits and raw log paths.
- **Implemented D2a, pending review:** `runRepositoryTask(RepositoryRunOptions) -> Promise<RepositoryRunRecord>` owns
  attempts, evidence and final delivery. Exit zero and model prose cannot deliver.
- **Implemented D2a, pending review:** `classifyFailure(VerificationReceipt) -> FailureRoute` chooses `CODE_REPAIR`,
  `WORLD_CHANGE_REQUIRED`, `CORE_MISMATCH`, `ENVIRONMENT_BLOCKED` or `NEEDS_REVIEW`.
  A route is evidence routing, never World or compiler authority.
- **Planned E; current stub returns invalid pending digests:** `proposeWorldChange(WorldChangeInput) -> WorldChangeProposal` records a rationale
  and exact replacement World YAML bytes (no executable patch language).
- **Planned E; current stub returns pending, never activates:** `activateWorldRevision(ApprovedWorldChange) -> WorldRevision` loads a trusted
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

D2a implements only the display-only `run.json` compatibility projection below.
Other sketch paths remain planned; actual authoritative paths are listed in the
"Internal complete-run publication" section below:

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

D1b host helper `captureIdentity` accepts source-declared absolute input paths, maps
them into `workspace`, and returns the frozen v1 InputBinding. Its optional
`baseline` must come from a host capture before backend execution. Call it again
after execution and around verification; it enforces allowed/protected changes
against that exact snapshot, including modes and added/deleted regular files.
It regenerates both TypeScript seam files in memory with the unchanged compiler.
Ruling: v1 TS seam declarations may be directories or individual files but must
cover exactly ports.d.ts and world_checker.ts once; extra/duplicate files refuse.
This helper grants neither verifier success nor durable acceptance. Verifier and publication now use this capture; D2a wires orchestration to this capture; CLI/live work remains D2b.


## Internal complete-run publication (D1f)

The public v1 record/manifest interfaces above remain unchanged. The original
`run.json` view is display-only; `delivery.json` remains a future sketch. Neither a
projection file nor `validateDelivery` eligibility grants durable delivery.
The host uses `publication.ts`: `initializeRun` before any attempts, then
`readRunStart`, `checkpointRun`, `readRunCheckpoint`, `publishRun`, and
`readCompleteRun`. The loop is wired in D2a; CLI/live work remains D2b.

All paths below are host-selected under an external artifact root, outside and
not containing the source/candidate. No backend prose selects evidence paths.
Safe lowercase IDs, canonical paths, symlink rejection, single-link regular
files and exclusive record reservation prevent aliases/overwrite in this model.

```text
publication/<run>/start/record.json                 # kadmos.run-start.v1
publication/<run>/checkpoints/00000001/record.json   # kadmos.run-checkpoint.v1
publication/<run>/checkpoints/00000002/record.json   # next immutable version
publication/<run>/manifest/record.json              # kadmos.delivery-manifest.v1
publication/<run>/complete/record.json              # kadmos.run-complete.v1, LAST
publication/<run>/writer/                           # exclusive transient host reservation
verification/<run>/<attempt>/invocation-<unique>/   # existing actual verifier evidence
```

Start stores original limits, start time, deadline, workspace and frozen policy
once. Checkpoints contain incomplete/blocked/awaiting-world v1 records, the start
reference, preceding checkpoint reference, verifier authority and backend file
references. References contain artifact-relative path, raw-byte SHA256 and
executable mode. Histories retain immutable prefixes of attempts, revisions,
effects and diagnostics. Current D1 accepts exactly one initial active revision
with null parent/proposal and no stale receipts, bound to the original host
context World/seam identities and role paths. E must deliberately extend that
boundary using host approval evidence; no approval or budget reset is inferred. Expiry refuses
new publication, but does not prevent incomplete replay or readback of a record
that was published before its original deadline.

The real verifier seals its host context, before/after and check records, stdout,
stderr and lifecycle inventory at completion. New checkpoint authority requires
that actual in-process verifier provenance; fabricated self-consistent receipt
JSON is insufficient. Recovery can reuse only authority already sealed in
persisted host checkpoints, after all referenced bytes are reread. Failed/unknown
verification retains the available evidence and missing evidence never grants
success. The latest delivered attempt additionally needs its actual backend
receipt/logs/version/lifecycle, exact current host context/revision/binding,
frozen successful checks, latest candidate identity and matching manifest.
Unrecorded attempts, or multiple/stranded verifier invocations for a recorded
attempt, refuse publication. The later loop must allocate a new attempt ID for
another invocation and account for it in the original total attempt budget.

Publication reserves one writer, validates the latest checkpoint and eligibility,
creates the immutable manifest, then creates the complete envelope referencing
start/checkpoint/manifest. It releases the writer and performs full durable
readback plus a final actual candidate recapture before returning delivery.
Readback refuses incomplete record directories, stray temporaries, broken chains,
changed/missing receipt/log/context/manifest bytes, stale identities, retained
unknown effects or unresolved process trees. The immutable effects history is
conservative: unknown/unavailable outcomes block delivery; reconciliation and
settlement authority remain later work and cannot be invented here.

This is a commit-marker protocol over independent create-once records, not one
multi-file transaction. A stranded writer, partial checkpoint, manifest without a
complete marker, or incomplete complete reservation stays refused. A trusted host
operator must first establish writer termination and preserve the failed evidence;
there is no automatic lock stealing, deletion/retry, budget reset or fabricated
completion. Healthy incomplete checkpoints support read/replay/extension without
old JavaScript object identity. Checksums provide integrity, not signatures. The
trust boundary remains the existing single-operator host storage and sampled
process supervision; no universal relocation, power-loss atomicity, adversarial
same-user filesystem protection, World approval or effect settlement is claimed.

D1 verifier paths use the same literal executable/cwd strings recorded by the
supervisor. Callers must supply canonical host paths (including the local macOS
`/private/var` form); aliases or normalized equivalents may safely refuse exact
receipt matching. `<candidate>` is the only supported substitution.

Context envelope digests hash the compact JSON context value; evidence FileRef
digests hash exact stored bytes, including whitespace. These integrity checks
have separate meanings and are not signatures. The atomic store handles
create-once persistence; validated load paths check context integrity.
Lifecycle sidecars are also create-once (`wx`): an existing sidecar refuses
launch/qualification, preserves its bytes, and attempts known-PID cleanup.
It does not overwrite telemetry or manufacture process-tree closure.

## D2a fixed-World integration (pending physical D review)

`runRepositoryTask` reserves one external artifact root for the entire run. A
concurrent or stale fresh start refuses to overwrite its display/history. The
disposable checkout lives at the sibling `<artifactDir>-workspace`; the clean
original source remains unchanged. Original limits/start/deadline precede clone
and attempt work; the host context and an incomplete checkpoint precede backend
launch. Failed attempts remain immutable checkpoint history. `run.json` is first
incomplete and becomes delivered only after `publishRun` completes exact readback.
Clone/context/storage failures retain honest incomplete/blocked evidence.

Only ordinary compile/functional/guard failures retry, up to the original total
attempt limit. Requirement failure pauses awaiting World; core/environment or
ambiguous/protected evidence stops. Nonzero/malformed/quota/timeout/cancelled or
unknown backend closure cannot deliver or retry. Verification follows only a
known stopped successful backend, independently captures policy identities and
regenerates the unchanged seam, and returns actual protected-change receipts.

Verifier stdout/stderr are retained in their raw host logs and bounded to 4096
bytes per stream for diagnostic feedback. Feedback is JSON-quoted data appended
to the next task's instructions because the physical backend sends instructions
to stdin. It never supplies commands, approval, or permission.

Repository-backed CodexBackend snapshots load the frozen policy from validated
host context (run/revision/base/policy digest), preserving exact raw file/mode
identity and exclusions in the stored backend receipt. There is no receipt rewrite
or equality weakening. Standalone tasks without revision context retain C's
empty-exclusion behavior; an existing malformed/mismatched context fails closed.

D1 R2 Minor dispositions: M1's alleged finally-on-mkdir-throw is contradicted by
JavaScript control flow and a repeated collision test; preserve the guard. M2
rechecks the original deadline before complete creation, retaining any stranded
partial manifest. M3 actual hardlinked-log sealing failure returns incomplete /
environment while preserving the earlier raw after record. M4 allows exact
WorldRevision keys only. M5 asserts the precise multiple-invocations refusal
after restoring protected bytes. These are D2 changes, not retroactive D1 acceptance.

A10's code-repair route is exercised independently; its later F settlement trace
still intentionally fails. Task D remains IN_PROGRESS until D2b CLI/live and the
shared settlement prerequisite are handled and physical review accepts the assembly.
