# Repository loop interface (v1)

Implemented host APIs provide disposable workspaces, physical/scripted backend
process evidence, frozen verification contexts, real verification, delivery
eligibility, original run budgets, immutable checkpoints and complete-run
publication/readback. Tasks D and E received independent physical Grok acceptance;
E acceptance is frozen at59885a5. Host commands include run, inspect, propose-world,
approve-world, reject-world and continue, with runtime validation. F1 adds local
settlement reconciliation. F2 connects a trusted host effect journal to the runtime
fence and adds a bounded SCRIPTED repair example; whole Task F and live A20 remain pending. Existing
`kadmos run` and `kadmos.compiler.k02.v1` are unchanged.

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
- **Implemented E, pending independent review:** `proposeWorldChange(WorldChangeInput) -> WorldChangeProposal` records a rationale
  and exact replacement World YAML bytes (no executable patch language).
- **Implemented E, pending independent review:** `activateWorldRevision(ApprovedWorldChange) -> WorldRevision` loads a trusted
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

Implemented: `kadmos repo run --input <run.json>`,
`propose-world --input <proposal.json>`, `approve-world --input <decision.json> --artifact-dir <hostRoot>`,
`reject-world --input <decision.json> --artifact-dir <hostRoot>` and `continue --input <continue.json>`.
Run input uses `schema: "kadmos.repository.v1"`, `runId`, absolute `source`,
`artifactDir`, `requirementsPath`, `worldPath`, nonempty `seamPaths`, `instructions`,
`policy`, `backend` and `revisionId`. See `repository-input.schema.json` for nested
policy/verifier shapes. `limits` may omit keys; each missing key uses the finite
default above (maximum supported timer integer 2147483647). `decisionsDir` defaults
to `<artifactDir>/decisions`. Unknown fields, serialized signals/capabilities and
unsupported arguments/subcommands refuse. Paths are canonicalized before freezing
host policy/context; verifier argv data tokens remain literal. The initial revision
is constructed from actual frozen World/seam digests, without World activation.
Backend config is `{executable, prefixArgs}`: production prefix is `[]`; a trusted
scripted launcher must explicitly supply its prefix. The backend adds only the
frozen installed CLI argv above and inherits operator configuration. SIGINT/SIGTERM
abort the controller and reach the shared supervisor. Continuation and deliberate operator decision commands use the original frozen control described below. JSON output gives exact run `status`, `runId`, canonical
`artifactDir`, `workspace`, attempts and delivery/diagnostics. The bin exits 0 for delivered run/continue results and completed proposal/decision commands (including deliberate rejection); all other run/continue statuses exit 1. Delivery requires complete-run
readback, never the display projection or process exit alone. Continue identifies run/artifact directory and exact
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
path, finite-budget and digest validation is implemented by the host command parser. TypeScript run
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


## Historical 2026-10-21 D1f: complete-run publication

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

## Historical 2026-10-21 D2a: fixed-World integration

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

## Historical 2026-10-21 D2b: early F precommit prerequisite

The example order-service settlement seam authorizes INITIATE_PAYMENT with the
fixed directive before invoking its trusted host actuator argv through the shared
supervisor. Timeout is 5000ms with 100ms termination grace. It reserves a permanent
`<recordPath>.dispatch` directory and writes `{outcome:"unknown", delivery:null}`
before step/launch. Record paths must be absolute with safe ancestors; stored
records and unknown reservations fence restart and overlap. The same host must
reuse the same operation record path. This is trusted single-host operation
fencing, without adversarial storage or power-loss guarantees.

The only recognized noncommit protocol is exit 2, no signal/reason, qualified
process closure, and stdout containing exactly one JSON object with exactly:
`{"protocol":"kadmos.precommit-refusal.v1","operationId":"<exact ID>","outcome":"not_committed","effectCount":0}`.
Only that trusted precommit refusal permits internal checker rollback and trace
`["step","actuator:refused","rollback"]`. It never undoes external physical work.
Malformed output, arbitrary nonzero, timeout, cancellation, committed output and
lost response remain unknown, delivery null, without repeat execution or rollback
claim. stdout/stderr, lifecycle and process observation remain outside candidate.
The query argument is unused: reconciliation and independent HTTP/fault/live F
acceptance remain deferred. A17 passing this shared prerequisite does not accept F.


### Frozen verifier result protocol

`VerifierCommand.resultProtocol` optionally accepts only `"exit-v1"`. Freeze it
before backend work; it participates in the policy hash, verification context,
CLI schema and exact command in each immutable CheckReceipt. Unknown or malformed
values refuse before backend launch. No shell, function, prose or model JSON
can override routing.

With `exit-v1`, exit0 passes; exit1 uses the frozen `failureKind` only after an
actual completed process with no signal/reason and a known closed tree. Every
other/null exit, signal, launch failure, timeout or unknown tree is an
infrastructure failure: `ENVIRONMENT_BLOCKED`, no repair attempt. Without the
field, legacy host-declared nonzero routing (including exit9) remains coarse and
cannot distinguish infrastructure from code failures. Signals always block as
infrastructure under both modes. Existing frozen policies are never upgraded
silently.

Host adapters must reserve exit1 for actual candidate assertions/positively
identified code diagnostics and use another exit (the demo uses86) for setup,
imports, tool launch, configuration and uncaught harness exceptions. A buggy or
lying host that reports setup failure as1 cannot be diagnosed from its prose.
An entrypoint digest does not attest all transitive toolchain bytes.

Reusable owner demo adapters live in `scripts/repository-demo/`. Copy
`typecheck.cjs` and `functional.cjs` outside source/candidate, then freeze argv
`[hostScript, "<candidate>", absoluteTscEntrypoint, absoluteKadmosRoot]` with
`cwd` equal to the host script directory and `resultProtocol: "exit-v1"`.
Build Kadmos first. Functional imports use `dist/pricing.js` and `dist/order.js`;
setup/import/compilation stays outside assertion catches. Its top-level catch
uses86. The typecheck adapter conservatively maps all nonzero compiler exits
to86: it has no trusted structured diagnostic adapter and does not parse text
to guess whether a source/config/tool failure caused the exit. This may stop a
repairable syntax error; it avoids spending attempts on ambiguous infrastructure.

Before freezing/launching a real run, prepare original-defect and independently
known-good reference samples, then execute:

```sh
node scripts/repository-demo/preflight.mjs /absolute/host/run-input.json /absolute/original /absolute/reference /absolute/new-preflight-directory
```

This tool executes only the exact frozen external checker argv/cwd (candidate
token substituted), never a backend. It saves input/program/tool-entrypoint and
sample hashes, actual exits and raw logs. It requires reference typecheck +
PASS5, and original typecheck + actual expected pricing/order assertion failures.
Wrong output paths/cwd/missing tools block launch with zero model calls. Recheck
these hashes, source cleanliness and current source head at the separate manual
budget gate. Preflight alone never authorizes a live run or grants delivery to
historical failed evidence. Freeze all final bytes only after successful preflight.


## Historical 2026-10-21 E1: World archive foundation

The library `proposeWorldChange` and `activateWorldRevision` implement standalone
host archives. A proposal contains exact complete replacement YAML, rationale,
requirements digest and an exact base revision. Initial base raw World and both
TypeScript seam files are re-read and compared with the unchanged compiler.
Proposal storage is create-once at `proposals/<run>/<proposal>/`, with `patch.yaml`
and a final `record.json` (`kadmos.host-world-proposal.v1`). Host roots must be
outside source roles; symlinks, unsafe lowercase IDs and existing reservations
refuse. Partial reservations remain evidence and cannot be silently recovered.

Activation re-reads the retained proposal and raw patch, checks every digest,
compares the current base, then reads the exact `OperatorDecision` shape above
from a separately trusted `decisionsDir`. Unknown decision fields, missing or
reject records, mismatched IDs/digests, invalid operator/time and symlinks reject.
The frozen decision shape has no extra schema field. Operator time is canonical
UTC ISO milliseconds. JSON host records assume one trusted local operator;
checksums are not signatures or malicious same-user exclusion. Tests explicitly
label operators SCRIPTED. No business World decision is implied.

The revision ID is `r-` plus the proposal SHA-256 hex. The archive is
`inputs/revisions/<run>/<revision>/activation/{world.yaml,seam/ports.d.ts,seam/world_checker.ts,record.json}`.
World and exactly the two unchanged compiler outputs are written exclusively;
the `kadmos.host-world-activation.v1` record is committed last. It retains exact
proposal/requirements/decision bindings, decision bytes digest and revision.
Repeated activation, even with a new decision file, refuses the existing revision
reservation. All provided historical receipt IDs plus prior stale IDs are retained
as a sorted unique list. Rejection returns the current revision with explicit
`rejected` state, preserving its identity and source bytes.

The sibling `verification-context` directory is independently reserved by the
host verifier; the archive never reserves or overwrites that directory.
Returned revision worldPath/seamPaths are physical archive paths. Existing source
role declarations remain lexical source paths. E2 must materialize archived bytes
into those same candidate roles, load the frozen controller and decision root,
verify the activation record/bytes again, and deliberately extend D1's initial
revision gate. Caller `state: active` and standalone archives grant neither a
running controller nor delivery. E2 must record decision consumption at its
controller transition and preserve original attempts/start/deadline/budgets.

CLI `propose-world --input`, `approve-world --input`, `reject-world --input` and
`continue --input` remain unavailable in this E1 library slice. The frozen
proposal wire shape has base IDs but no physical base paths; the decision wire
shape has no trusted storage root. Wiring them coherently requires E2's frozen
controller lookup rather than a caller-provided active revision or inferred root.
No actual approve command is automatically invoked. A12 first pauses a real
scripted run, then persists its proposal; D's fresh-start refusal for preexisting
standalone artifacts remains unchanged.


E2a adds internal `createControl` / `readControl` and `readApprovedActivation` foundations. A fresh loop captures `inputs/controllers/<run>/original-control/record.json` after the legitimate initial context and before the first backend call. The record retains original instructions, lexical source/roles, canonical filesystem addresses, initial revision, policy, decision root, supported backend configuration and exact header/context references. Readback is detached/frozen and never creates records, renews deadlines/limits, restores attempts or grants delivery. Older runs without this record remain readable through D's fixed-World publication API but cannot use this new controller lookup.

Only the host selects an external artifact root/run ID. Source/candidate metadata cannot redirect a lookup to another root. Control, source and candidate storage must be disjoint; decisions must be outside source/candidate. IDs use the existing lowercase bounded host-ID grammar. Control instructions and paths are nonempty strings without NUL; executable/prefix configuration contains only strings. Exact built-in `CodexBackend` / `ScriptedBackend` configurations are detached before any await, including actual execution options. A generic backend gets `{kind:"host-capability",restorable:false}`; later direct API use must receive the original host capability, while CLI cannot reconstruct it. Functions, arbitrary objects and provider guesses are never retained/evaluated. Backend choice grants no acceptance authority; actual process receipts remain authoritative.

The approved-archive loader supports one exact successor of the frozen initial revision. It reuses E1 proposal/base/decision/compiler validators, revalidates original protected inputs, requires the exact archived revision including its stale-ID list, and checks every archive/proposal/decision file against path/alias restrictions. It uses the original frozen decision directory and requires the original decision's raw hash and parsed copy to remain available and unchanged. Missing/replaced evidence refuses, even if replacement JSON describes the same approval. This is a trusted single-operator host integrity protocol, not a signature or same-user isolation. It grants no runtime active pointer or backend attempt.

Continuation, fresh candidate reconstruction/materialization, revised verification context, versioned publication and host CLI commands remain pending. They must preserve the original header, all attempts and deadline, serialize/quiesce workspace replacement, and fence previous complete authority before switching revision intent. Archive physical World/seam paths must be materialized into the original lexical role locations. An archived stale-ID list may be a historical subset; later current-revision tuple validation must invalidate every actual old receipt, with any additional derived staleness retained separately.

### Historical 2026-10-21 E2b: direct continuation

`runRepositoryTask` can continue an original controlled run into **one exact approved successor**. Supply the original options and the approved archive's `revision`, `worldPath` and `seamPaths`. It acquires the existing run's exclusive controller, validates original control/header/checkpoint/evidence, and retains the original start, deadline, limits and attempt numbering. Operator wait consumes the original deadline. Missing control, overrides, exhausted/expired budgets, unresolved effects/processes, blocked infrastructure/core/unknown routes, changed candidates/source or partial history refuse continuation. No automatic recovery, lock stealing or budget renewal is provided.

The host preserves the previous physical workspace, reconstructs a fresh clean base plus recorded regular candidate bytes, executable modes and deletions, then materializes the approved World and compiler-generated seam at the **original source role locations**. A fresh verification context binds these bytes and the unchanged policy/requirements before another SCRIPTED or host-authorized backend can run. Exact built-in configuration comes from frozen control; an opaque backend requires an explicit host capability and cannot be restored from JSON. Capability object identity across processes is outside the existing trusted single-operator guarantee.

A create-once generation reservation under `publication/<run>/generations/00000001` fences the original complete marker before workspace mutation. Intent, preserved workspace, new context/switch, checkpoints, manifest and complete are distinct from the original publication. Complete is last; current readback independently checks the new revision's actual backend and verifier evidence. Missing/partial intent, switch or publication never falls back to the old complete. Original receipts remain historical and cannot deliver a different current revision, regardless of the archived stale-receipt subset. Derived staleness is retained separately in the intent; archived WorldRevision metadata remains exact.

Compatibility ruling: public `RepositoryRunRecord` and `WorldRevision` shapes stay unchanged. Initial D fixed-World readback remains supported. This internal v1 supports only one successor rooted in the initial durable history; a second successor is explicitly refused even if independently approved. An interrupted reservation requires trusted host recovery; no automatic crash repair is claimed. Host records are integrity evidence under the existing trusted local operator assumption, not signatures or malicious same-user isolation. Direct continuation does not add `propose`/`approve`/`reject`/`continue` CLI commands; E2c owns those. No business World approval or installed coding-agent invocation is implied by SCRIPTED tests.


## Historical 2026-10-21 E2c: host CLI and seam frames

The four commands above are implemented. Proposal and continuation JSON use the exact frozen schema; decision JSON remains the exact nine-field object with no schema or artifact locator. **Class C CLI-context clarification:** `approve-world` and `reject-world` require `--artifact-dir <hostRoot>` after `--input <decision.json>`. This flag only locates the original control for the stated run. It is not operator permission and cannot override the original `decisionsDir`. The previously underspecified locator is explicit rather than inferred from cwd, global registries, candidate metadata or filesystem scans. Unknown arguments/fields refuse. Host input files must be absolute, regular, unaliased, and outside source/candidate; system `/var` and `/tmp` aliases retain existing canonical handling.

`propose-world` resolves base paths and roles exclusively from `readControl` and validated original checkpoints/context. It checks current base IDs/digests/requirements, original remaining budget, source/candidate and supported pause route before reserving a proposal. A new root is never adopted. This bounded v1 supports one successor: after any generation reservation/use, further proposal/decision/continuation requests refuse early. Completed original runs may also propose a successor while budget remains; their complete receipt is validated before proposal.

A deliberate host `approve-world` or `reject-world` validates command, nonempty operator, canonical millisecond UTC time and all retained proposal/base/digest bindings using the same validator as archive readback. It creates exactly one trusted decision at `<original decisionsDir>/<runId>/<proposalId>/record.json`. Replays, conflicting approval/rejection, overwrite and cross-run bindings refuse. Approval then creates the immutable E1 archive with actual historical verifier-attempt receipt IDs (`runId/attemptId`); rejection preserves the current World and creates no active archive/controller generation. An activation failure retains its decision reservation for explicit host recovery. Candidate-authored JSON and model prose never automatically become approval. This trusted local operator protocol supplies integrity checks, not authentication against a malicious same-user host process.

`continue` accepts only `{schema,runId,artifactDir,revisionId}`. It loads the requested stored activation and exact original control/history, constructs the saved built-in backend and process-local signal, and passes original source/roles/instructions/policy/limits/decision root into the existing controller. Opaque host capabilities cannot be reconstructed by the CLI. SIGINT/SIGTERM propagate and listeners are removed on exit. Original attempt count/start/deadline are never renewed; operator wait consumes the deadline. Delivered output requires a fresh `readCompleteRun` whose revision/World/seam tuple and last revision equal the requested archive. An old root complete is never a fallback.

New archives preserve the existing seam hash frame: declared role index, root-relative path (basename for individual files), and executable bit. Standard single-directory archive paths/bytes remain compatible. Individual files in either order, nested directories and multiple nonempty roots retain their exact frame. Strict readback derives expected archive locations and the entire directory/file set from validated original roles, then validates compiler bytes, modes, hashes and decision evidence. Continuation materializes by those logical generated slots at the original lexical roles. An empty declared role root is outside this bounded archive format and is refused before archive reservation or continuation intent; no hashes or old contexts are rewritten. Empty subdirectories within a nonempty role are not part of the identity frame and are not archived.

All worker demonstrations are SCRIPTED backend/operator fixtures. No actual business World decision, Yong approval, installed coding-agent qualification or production mutation is implied. Parent physical Grok reviews assembled Task E; F still owns HTTP reconciliation/A18 and the later A20 live gate.


## Historical 2026-10-21 F1: local settlement and independent HTTP faults

`examples/repository-order-service/settlement.ts` preserves the required
`SettlementInput` fields. The HOST supplies executable/argv capabilities; generated
Fabric/model stdout cannot select an actuator or grant authority. The independent
HTTP server and argv adapter in `tests/fixtures/repository/http-{actuator,client}.cjs`
use actual loopback sockets and separate processes. The server serializes requests,
persists stable operation IDs and a counter, and creates each request trace file
once. Literal `constructor` and `__proto__` IDs have no inherited-key behavior.

The permanent `.dispatch` directory reserves an operation; `unknown.json` and
`binding.json` precede checker authorization and dispatch. Unknown evidence is never
erased. `authorized.json`, qualified process logs, and a create-once `outcome.json`
retain provenance; `recordPath` remains the legacy JSON outcome plus `delivery:null`
projection. Existing/interrupted reservations are never stolen, even after restart.
Unknown restart is fenced without retrying apply or query. Known results revalidate
their retained receipt. A fresh checker matching the saved starting state may
reconstruct the authorized step; otherflow state is never reset. Matching already
applied state is left alone. A known effect with incompatible checker state is
conservatively returned as unknown without re-actuation.

All receipts have exactly `protocol, operationId, outcome, effectCount`. Only closed,
qualified processes count: committed apply requires `kadmos.effect-commit.v1`, exit0,
committed/count1; original refusal requires `kadmos.precommit-refusal.v1`, exit2,
not_committed/count0. Ambiguous apply is followed by `kadmos.effect-query.v1`, exit0,
with committed/count1 or not_committed/count0 for that same operation. Invalid,
wrong-ID, extra-field, count, signal, timeout and transport results alone never prove
zero. Apply and query share a five-second deadline and bounded supervisor cleanup.
A query is never launched unless apply's sampled process tree is stopped.

A denied or throwing checker step already restores its internal state and can leave
an earlier operation's undo. Settlement never rolls it back. Explicit refusal or
qualified query noncommit can rollback only this operation's successful step while
its saved state/context still matches. Callers must provide exclusive checker access
during settlement; direct concurrent checker changes are outside the wrapper's
serialization (detectable state drift refuses rollback). Internal rollback cannot
undo an external commit. Committed-but-dropped HTTP replies physically query before
settling; repeated IDs observe one mock effect. Unavailable query retains unknown,
no delivery, and blocks automatic repetition across process restart.

Scope: trusted local host capabilities/filesystem and one serialized mock server;
process crash/restart fencing only, not fsync/power-loss recovery, multi-host safety,
malicious same-user tampering protection or universal exactly-once delivery. Retained
files are create-once by this controller; permissions are not an OS security boundary.
The repository runtime still initializes `effects:[]`: F2 must collect/fence genuine
host effects through the actual run path and prove unknown blocks delivery there.
F1 settlement tests do not establish that broader integration. Task F's faulty
Fabric→SCRIPTED loop repair, live installed-backend A20 with explicit exact human
World approval, assembled physical Grok and cognitive delivery remain pending.

E review Minor2 is safely deferred: approval may archive a decision/activation while
orphan attempt/verifier directories or inconsistent committed counts exist. Owner
F1 reproduction confirms continuation refuses before generation reservation,
workspace mutation or backend dispatch. The archive alone grants no continuation or
delivery. Frozen E acceptance did not execute those tests. Earlier rejection can be
separately hardened; F1 makes no broader approval-history claim.

The legacy file actuator keeps its original default JSON reply shapes. Settlement
acceptance opts into `--bound` host receipts; original contract assertions remain
unchanged. Legacy unbound stdout cannot resolve settlement.


## 2026-10-21 F2: frozen host effect journal (Class C runtime evidence extension)

Required DTOs, `EffectRecord`, exact operator decisions, original limits, and K-02
semantics are unchanged. A frozen verifier argv may end with two literal arguments:
`--kadmos-order-effect-v1` and a JSON object with exactly `operationId`, `actuator`,
and `query`. The two commands use the existing `VerifierCommand` contract, with
absolute host executable/script paths, frozen program digests and literal endpoint
arguments. Candidate cwd/argv placeholders, nested effect markers, and candidate
paths cannot supply these commands. This is the single order-settlement observer,
not a generic effect executor. The host selects it when freezing policy. The
functional verifier still runs independently and has its original exit semantics.
The runtime then uses the frozen World to instantiate its own host checker and
observes the selected apply/query processes. Candidate stdout and candidate-returned
`EffectRecord` objects are never journal authority.

`<artifactDir>/effects/<operationId>/reservation/record.json` binds run, revision,
attempt, check, complete input identity, frozen verifier and host commands, with an
unknown reservation **before** checker authorization or actual launch. The sibling
`settlement.dispatch/` retains F1's original unknown, authorized checker state,
actuator/query observations, raw stdout/stderr and sampled lifecycle traces. The
create-once `outcome/record.json` seals the observed result and exact file references.
Immediate drop followed by a qualified committed query can seal known commit while
retaining raw ambiguous evidence. The optional host settlement deadline caps its
existing five-second limit by the original verifier/run deadline. The optional host
command cwd is honored explicitly; default legacy cwd remains the record directory. The example
`settlement.ts` reexports this source-owned implementation.

The current journal is censused before retries/checks, after verification, before
revision intent, and during publication and every complete readback. Missing,
malformed, stale, foreign, aliased, duplicate, incomplete or altered evidence refuses
acceptance. Missing journal means no effects only for pure runs with no dispatched
reserved check; a missing expected reservation is never zero. Late reservations or
receipt changes invalidate an old complete grant, including in a fresh reader.
Incomplete/unknown observations block later checks, model attempts, actuation and
World continuation. Unknown overrides CODE_REPAIR even when the functional verifier
fails. Exact SCRIPTED archive approval cannot erase it or renew the original budget.
There is no automatic unknown recovery. Known same-operation observations may be
reused after rechecking their original evidence without another actuation.

The existing trusted single-operator filesystem/process assumption still applies:
create-once records and digests detect observed drift; they do not provide OS
isolation against hostile same-user mutation, arbitrary candidate network effects,
power-loss durability or a universal savepoint-token/exactly-once guarantee.
Only the configured host-mediated operation is qualified. Exclusive checker
ownership during await remains required; detected state/context drift refuses
rollback.

Reproduce from this source checkout (Node and the frozen lockfile installed):

```sh
pnpm run build
node --test dist/tests/test_repository_effect_journal.test.js
node --test dist/tests/test_repository_scripted_order.test.js
node dist/examples/repository-order-service/scripted-demo.js /private/tmp/kadmos-scripted-order-demo
```

The last command requires a new output directory. It creates a disposable Git
repository, three editable Fabric/client/persistence modules, a host SCRIPTED
backend and frozen independent HTTP verifier. Three real backend/check iterations
observe illegal guard order, then forbidden retry after ambiguous apply, then a
passing repaired repository. The verifier measures refusal/rollback, drop/query
commit and unavailable-query retention using the separate HTTP server ledger and
request traces. `summary.json`, feedback, candidate identities, process logs and
complete evidence remain under the output directory. The server exits before the
command returns. Expected negative test operations use `negative-fixture-*` IDs
and a separate fixture ledger, not the business run's effect journal. The example
uses the source-checkout HTTP fixture in `tests/fixtures/repository/`; it is not an
npm-installed service. It demonstrates SCRIPTED repair, not actual installed R3,
live A20, human World approval, physical reviewer acceptance or whole-Epic delivery.
