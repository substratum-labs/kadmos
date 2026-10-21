# Repository contract preflight receipt

This is interface and harness evidence, not completed repository-loop behavior.
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

The contract gate currently passes 5 tests. The behavioral command currently
runs 40 tests: 39 intentionally fail assertions against pending implementations;
one conservative ambiguous-routing case passes. No tests are skipped. A20 remains
an unexecuted live gate. The unchanged legacy baseline is 268 passing tests,
with packed NodeNext consumer and strict typecheck passing separately. The full
suite is intentionally RED. Each future implementation phase must replace its
pending seam and earn the corresponding behavioral assertions.

The host-owned fixture qualifies literal argv/stdin handling, a real installed
TypeScript diagnostic, and a separate actuator process's refusal, commit/drop,
same-ID deduplication and restart query. Those fixture checks do not substitute
for the missing controller/backend behavior. Finite tests do not establish
universal correctness, isolation or crash durability.

Task C checkpoint: the argv backend and workspace implementation are now present.
Focused A01–A04 plus lifecycle/workspace regressions pass; D–F behavior remains
intentionally RED. A single Codex 0.163.0 smoke actually edited the disposable
file (41→42) and exited 0. Its child-group escape conservatively produced
`launch_failed` / `treeStopped: unknown`; this is failed qualification evidence,
not a delivered task or an A20 substitute. No auth/quota block was reported.

### C-Q qualification clarification (pending independent review)

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
