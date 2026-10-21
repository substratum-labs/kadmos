# Repository contract preflight receipt

Current owner checkpoint (2026-10-21, F2): repository loop and Task E commands are
implemented; D/E physical review receipts remain scoped to their frozen commits.
F1 owner full suite was 750/750; F2 adds runtime host-journal and SCRIPTED repair
checks. Current final measured verification belongs to the F2 receipt below.
Live A20, exact human business World approval and assembled F physical review
remain pending. No whole-Epic acceptance is claimed.

Historical checkpoints below are retained as dated evidence, not current status.
The original K-02 compiler/checker and existing `run` remain unchanged.

Measured host: macOS 27.0.1 arm64, Node 26.0.0, Codex CLI 0.163.0.
An installed read-only CLI invocation emitted JSONL, reported the requested cwd
and exposed turn usage. Invalid cwd and restricted-parent initialization returned
noninteractive failures. A detached-group host probe stopped a CLI waiting on
stdin plus a heartbeat descendant. Live tool-execution cancellation and other
platforms remain unqualified.

Reproduce from the repository root:

```sh
pnpm run build
node --test dist/tests/test_repository_contracts.test.js
node --test dist/tests/test_coding_backend.test.js dist/tests/test_repository_loop.test.js dist/tests/test_world_revision.test.js dist/tests/test_repository_demo.test.js
```

Historical B checkpoint (2026-10-20): the contract gate passed 5 tests. The behavioral command
then ran 40 tests: 39 intentionally failed assertions against pending implementations;
one conservative ambiguous-routing case passed. D2a now implements bounded fixed-World
loop/feedback; current measured counts and exact remaining failures are archived in
the coordination D2a evidence packet. CLI/live, E and F remain pending. No tests are skipped. A20 remains
an unexecuted live gate. The unchanged legacy baseline is 268 passing tests,
with packed NodeNext consumer and strict typecheck passing separately. The full
suite is intentionally RED. Each future implementation phase must replace its
pending seam and earn the corresponding behavioral assertions.

The host-owned fixture qualifies literal argv/stdin handling, a real installed
TypeScript diagnostic, and a separate actuator process's refusal, commit/drop,
same-ID deduplication and restart query. Those fixture checks do not substitute
for the missing controller/backend behavior. Finite tests do not establish
universal correctness, isolation or crash durability.

Historical Task C checkpoint (2026-10-20): the argv backend and workspace implementation are now present.
Focused A01–A04 plus lifecycle/workspace regressions pass; D–F behavior remains
intentionally RED. A single Codex 0.163.0 smoke actually edited the disposable
file (41→42) and exited 0. Its child-group escape conservatively produced
`launch_failed` / `treeStopped: unknown`; this is failed qualification evidence,
not a delivered task or an A20 substitute. No auth/quota block was reported.

### Historical C-Q qualification clarification (subsequently physically accepted)

For the existing single trusted operator, non-adversarial local profile,
`treeStopped: true` means sampled tracked-lineage closure, not universal process
containment. A PGID departure alone is not unresolved work: it may qualify only
when a later successful inventory observes that PID absent, before supervisor
cleanup, while its last observed chain reaches an ancestor still present and rooted in the
launched process. Missing intermediate links must all be tracked departures also
observed absent in that inventory; nested tools may close in the same sample. Every observed departure must meet that condition. Reparenting,
a departure surviving to cleanup (even if killed), inventory failure/malformed
inventory, or remaining tracked members yields unknown. Cancellation and timeout
remain failures regardless of closure. Missing lifecycle writes throw rather
than returning a candidate. Full timestamped inventories, natural closures and
lineage-loss flags are retained beside stdout. Sampling cannot detect an
unobserved rapid double-fork/escape; no adversarial containment is claimed.
The literal argv, stdin, inherited operator configuration and finite limits are
unchanged. The original C failed smoke remains failed qualification evidence.
This bounded clarification of B's tracked-tree wording requires physical Grok
review before D; it grants no software delivery, World approval or A20 result.


## F2 owner verification — 2026-10-21

Final signed build/typecheck and `pnpm run verify`: **767/767**
passing, zero failures/skips/cancellations. This includes all 750 F1 baseline tests
and 17 added F2 tests, plus the existing packed NodeNext consumer gate. Relevant
HTTP/journal/SCRIPTED/A17–A19/contract checks: 70/70.
Finite order-World differential fuzz: 30 runs, no divergence; package build/pack
and diff hygiene passed. These are owner observations on the frozen technical
files, not independent reviewer acceptance. The final source commit records these
files and this documentation-only measured receipt.

Actual compiling RED retained: five runtime-journal assertions; a second actual
effect after unknown; deliberately faulty Fabric's independent guard assertion;
frozen subprocess cwd. GREEN proves blocked delivery with effect retained after
otherwise passing or functionally failing checks, no second backend/actuation,
fresh-process restart/readback, exact SCRIPTED archive approval fencing, journal
corruption/alias/late-census refusal, and separate known commit/refusal/reconciliation.
The SCRIPTED example records three multi-file iterations with independent guard
and HTTP retry diagnostics before final acceptance. Negative fixture effects are
scoped separately. No installed-backend invocation or business World approval was
performed by F2. Task E commands are implemented. E Minor2 remains safely deferred;
live A20, assembled physical Grok review, Yong acceptance and cognitive delivery
remain pending.
