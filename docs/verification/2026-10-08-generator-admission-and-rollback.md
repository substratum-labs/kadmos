# Generator Admission and Rollback Verification

**Task path date:** 2026-10-08. **Execution date:** 2026-10-09.
**Branch:** `feat/kadmos-generator-contract-20261008`
**Base:** `85ff9541d9fd2b2d11d09ac2d002997a7c3a7fe5`
**Manifest:** `@substratum-labs/kadmos@0.1.2` (unpublished from this branch)
**Contract marker:** `kadmos.compiler.k02.v1` (human identifier, not an immutable source pin)

## Implemented contract and compatibility

`admitWorldSpec` is the shared boundary for parsed YAML, direct compiler inputs, and the interpreted checker. An omitted World directive and YAML `directive:`/`directive: null` become canonical null. Explicit nonempty strings remain exact authorizations. An own JavaScript `undefined`, empty string, wrong primitive or object fails `INVALID_WORLD: directive`; rejecting the empty string is an intentional tightening. Proxy and accessor model inputs are rejected before model field reads, with zero-call getter/trap regressions. Explicit empty context, invariant, and transition collections compile without a synthetic invariant; missing required collections fail admission.

Interpreted and emitted TypeScript and emitted Python now accept optional nullable constructor context, remember the resolved constructor seed, and restore it on bare/null/None reset. An explicit object overlays World defaults without replacing the seed; explicit `{}` selects defaults. Invalid non-null shapes or values fail `INVALID_BOUNDS` before enumeration. Successful reset clears the savepoint; refusal, exception, and failed reset preserve it. An accepted step replaces the single pre-success state/context/accepted-history snapshot; rollback consumes it, with stable `NO_CHECKER_SAVEPOINT` when absent or busy. Source/emitted TS interfaces declare `rollbackLastStep()`, and the Python Protocol declares `rollback_last_step()`.

Python `state`, `context`, and `history` remain readable properties, while direct writes raise `AttributeError` and context/history reads are copies. This changes unsupported live-field mutation behavior: `examples/job-queue-benchmark/python_worker.py` now invokes `rollback_last_step()` immediately after an allowed step's physical effect fails, before Redis compensation. Python introspection can reach mangled attributes; checker rollback cannot undo external writes. The existing valid World fixtures, request keys, seeded fuzzer API/report, package dependency list, and generated zero-dependency requirement remain intact.

## Source and projection inventory

| Unit | Evidence |
| --- | --- |
| Last source checker/compiler commit | `00bf9bbd937ebca0adf354a3f8e7e1903cf95177` |
| Three-path runner/test commit | `86757ba82504716f378b8fad9ad2aa2cbf76a572` |
| JobWorld seam | Canonical CLI: `node bin/kadmos.js compile conformance/fixtures/job_lifecycle.world.yaml --out examples/job-queue-benchmark/spec --lang all`; four checked-in files regenerated. |
| Circuit-breaker seam | Canonical CLI: `node bin/kadmos.js compile examples/circuit-breaker-worker/spec/task_worker.world.yaml --out examples/circuit-breaker-worker/src/world --lang ts`; two checked-in files regenerated. |
| BullMQ adapter seam | Canonical CLI compiled `conformance/fixtures/job_lifecycle.world.yaml` to a temporary TS directory; emitted `world_checker.ts` and exact `ports.d.ts` bytes were copied to checked-in `src/adapters/bullmq/spec/world_checker.ts` and `ports.ts`, respectively. The adapter stores that generated declaration under a `.ts` filename for its `./ports.js` import; no generated code was hand-edited. |

The final Task 5 commit will contain documentation and the latter two regenerated seam sets. Its SHA is reported separately after commit; this file does not claim its own future hash. The coordinator must pin the final reviewed/integrated immutable source SHA for any later Harmonia work.

## Local gates

Host: macOS arm64, Node `v26.0.0`, Python `3.14.4`, pinned pnpm `10.32.1` via `/private/tmp/kadmos-pnpm-bin`. Frozen dependencies and the 249/249 baseline were verified on 2026-10-08 before implementation. `verify` below ran with approved network/loopback access because the packed isolated consumer and HTTP probes need it.

| Command / probe | Result on 2026-10-09 |
| --- | --- |
| `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run verify` | Exit 0; **259 tests, 259 pass, 0 fail**; packed NodeNext consumer typecheck 0 diagnostics; root strict typecheck exit 0. Full output: `/private/tmp/kadmos-k02-verify-20261009.log`. Includes packed starter/MCP, BullMQ, benchmark worker, README/copied-Skill Fabric examples, and three-path cases. |
| Strict edge-world projections | `tests/test_harness_world_compiler.test.ts` compiled emitted TS under strict NodeNext and imported/executed emitted Python for explicit empty context/invariants/transitions and zero directives; included in the 259-test pass. |
| Fixed three-path outcomes | `tests/test_world_semantics_conformance.test.ts` compared interpreted TS, emitted TS, and emitted Python separately to literal constructor/reset, accepted/refused, ordered-effect, directive, bound/invariant/guard, history, and rollback expectations; included in the 259-test pass. |
| `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run test:fuzz` | Exit 0; seed `1791531358268`, 30 runs × 20 steps = 600 sampled steps, 0 observed divergences. A separate fixed-seed CLI run with `--seed 20261008` also observed 600 steps and 0 divergences. These are finite samples, not bisimulation proof. |
| `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm pack --dry-run` | Exit 0; prepack rebuilt `dist`; 70 files, restricted to `bin/`, `dist/src/`, `skills/`, `README.md`, `LICENSE`, and `package.json`. Output: `/private/tmp/kadmos-k02-pack-20261009.log`. |
| `git diff --check` | Exit 0 before final documentation commit; staged diff and final clean status checked at handoff. |

The host does not expose `python3.10`, `python3.11`, `python3.12`, or `python3.13` executables. The exact-head 24-job Node 20/22 × Python 3.10–3.13 × Ubuntu/macOS/Windows CI matrix and physical Grok final review remain **pending with the parent**. Host Node 26/Python 3.14 success does not certify that matrix. No push, PR, release, tag, publication, deployment, or Harmonia execution was performed here.

## Rulings

1. The prior omitted-directive conformance test asserted the defect that Task 1 repaired. It was converted to a positive TS/Python acceptance regression during Task 2 so that its required focused suite could pass; Task 4 then added the independent full-outcome runner. Cost if wrong: an insufficient oracle could hide shared errors; fixed literal outcomes now check all three paths separately.
2. The BullMQ adapter's checked-in `ports.ts` is a renamed copy of generated `ports.d.ts`. It was refreshed from canonical CLI output without handwritten seam changes. Cost if wrong: a future regeneration that updates only `ports.d.ts` would leave the adapter stale; the mapping is recorded above.
3. No new Python physical-failure code fence was added to README or the copied Skill. The tested benchmark worker exercises the real Python rollback path; the Skill describes the method and limits in prose, avoiding an unexecuted displayed example.
