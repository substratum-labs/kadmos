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
runs 37 tests: 36 intentionally fail assertions against pending implementations;
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
