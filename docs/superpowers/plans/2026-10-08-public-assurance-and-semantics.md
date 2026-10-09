# Public Assurance and World Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This is native physical execution with no virtual subagents. Steps use checkbox (`- [ ]`) syntax for tracking. Product execution starts only after independent physical Grok preflight acceptance coordinated by the parent.

**Goal:** Make Kadmos developer-preview claims and Fabric examples accurate, pin observed World semantics with executable TS/Python tests, and verify the actual packaged Quick Start and MCP path.

**Architecture:** Keep the current World parser, expression evaluator, checker generators, CLI and fuzzer architecture. Put current-behavior semantics in docs and tests; correct public prose/examples; run a packed clean-consumer probe. Any newly discovered semantic defect requiring behavior change gets a separate reviewed proposal.

**Tech Stack:** Node >=20, pnpm 10.32.1, TypeScript 7.0.2/NodeNext, Python >=3.10, built-in `node:test`, generated zero-dependency checkers.

**Spec:** `docs/superpowers/specs/2026-10-08-public-assurance-and-semantics-design.md`

**Version inventory (parent-provided, 2026-10-08):** npm latest 0.1.1; GitHub latest Release v0.1.1; this worktree's source manifest 0.1.2. The local tarball probe verifies source 0.1.2 only; no release or publish authority is implied.

## Global Constraints

- Work only in the native isolated Kadmos worktree and a named feature branch; do not touch main checkout, Harmonia, or the concurrent primary coordination checkout.
- `world.yaml` is policy; generated `ports.d.ts`, `world_checker.ts`, `ports.py`, and `world_checker.py` are read-only projections.
- No new public API, runtime dependency, unsolicited compiler rewrite, release publish, or public PR in the first batch.
- Runtime admission must refuse malformed primitive inputs without coercion; preserve checker state/history on refusal.
- Verify with `pnpm run verify`, `pnpm run test:fuzz`, and `pnpm pack --dry-run` for packaging work. Collect exact command outputs and exit codes.
- Current design describes implemented behavior. Correctness proof, differential evidence, reference semantics, and target correspondence remain separate claims.
- All full World YAML examples and normal conformance fixtures must spell `directive: null` when no directive is authorized. An omitted World directive is a known TS/Python defect, not the same as a request with missing/wrong `proposedDirective`.
- Keep private task IDs out of `README.md`, `skills/kadmos/SKILL.md`, and public `docs/world-semantics-v0.md`.

## Review Focus

1. A rejected request after an accepted step must leave that accepted state intact; Task 2 tests it against the emitted TS checker with an explicit World `directive: null`.
2. A queued later call on the same checker must run after a failed callback's rollback, see `CREATED`, and commit despite the first caller receiving a rejection; Task 2 tests it.
3. Sequential effects must read the prior effect's new value and destination state; Task 3 tests both emitted languages against fixed expected values.
4. Boundary and malformed values (`bool`, string integer, fraction, unsafe integer, reserved payload key) must be handled in the documented stage; Task 3 tests payload copying separately from integer effect/reset checks.
5. A clean tarball consumer must find both MCP entry points, starter scripts, LICENSE, and every packed README/skill relative link target without relying on this repo's `node_modules`; Task 4 tests them.

---

## File map for the first batch

| File | Responsibility |
| --- | --- |
| `README.md` | Public assurance wording, accurate TS Fabric example, Quick Start and MCP instructions |
| `skills/kadmos/SKILL.md` | Packaged agent guidance matching the real checker API and guarantee limits |
| `docs/world-semantics-v0.md` (create) | Versioned, current-behavior semantic contract and explicitly separate defect register |
| `tests/test_public_fabric_example.test.ts` (create) | Execute the public example logic with a generated checker, not just match its text |
| `tests/test_world_semantics_conformance.test.ts` (create) | Hand-authored World cases run against emitted TS and Python checkers with independent expected results |
| `tests/test_packed_quickstart.test.ts` (create) | Pack/install into temp clean consumer; CLI, starter TS/Python, MCP stdio probe |
| `src/scaffold.ts` | Modify only if clean-consumer evidence reproduces a scaffold or Quick Start defect |

Do not hand-edit checked-in generated checker files. `src/world_compiler.ts`, `src/python_compiler.ts`, `src/world_expression.ts`, `src/world_checker.ts`, and `src/fuzzer.ts` are reference files for this batch, not preauthorized mutation targets. Document a behavior-change issue and seek separate review if a test exposes a defect.

### Task 1: Public assurance language

**Files:** Modify `README.md`, `skills/kadmos/SKILL.md`.

**Interfaces:** Consumes the spec evidence table and current CLI/skill text. Produces public language that Task 2's example and Task 4's packaged probe can use.

- [x] **Step 1: Record the exact claims.** Run `rg -n -i 'proof|proven|bisimulation|shortest|atomic|rollback|verified|guarantee' README.md skills/kadmos/SKILL.md`; keep a manual before/after checklist with each affected sentence and its code/test evidence. Include the BullMQ paragraph: `src/adapters/bullmq/redis.ts` has one inline `transitionJob` Lua `EVAL` checking state/token/lease, but does not establish the comparison to BullMQ's “30+ scripts.”
- [x] **Step 2: Edit prose from evidence.** State that `step()` checks the given transition against the declared World and refuses observed invalid inputs; seeded differential tests compare selected TS/Python traces; a violation trace is the accepted prefix plus refused attempt. Describe the observed BullMQ adapter mechanism without a whole-BullMQ replacement or comparative script-count claim. Keep infer, legislate, compile, run, test, graph, init, MCP, skill, BullMQ preview and roadmap visible. Remove unconditional “shortest” and proof wording from diagrams, tables, commands and skill phases as well as paragraphs. Do not insert private task IDs into public copy.
- [x] **Step 3: Verify and commit.** Run the same `rg` claim audit, manually reconcile remaining uses against the checklist, then `pnpm run verify`. Expected: the public copy matches source evidence and existing tests/typecheck pass. Do not add wording-snapshot or marketing-string tests. Commit only the Task 1 files, e.g. `git commit -m "docs: calibrate Kadmos assurance claims"`.

### Task 2: Executable Fabric rollback example

**Files:** Modify `README.md`, `skills/kadmos/SKILL.md`; create `tests/test_public_fabric_example.test.ts`.

**Interfaces:** Consumes emitted `WorldChecker` from `compileWorldSpec(parseWorldSpec(...))` and the README's `CONFIRM_PAYMENT` World. Produces an honest `processPayment(orderId, amount, persist)` example with per-checker serialization. No new package export.

- [x] **Step 1: Write a failing executable test.** Extract the README World YAML fence and parse it with `parseWorldSpec` before compiling; its current inline `{ type: ... }` context maps are unsupported and must first fail the test. Compile the corrected World into a temporary NodeNext ESM directory using the actual compile-and-import pattern in `tests/test_harness_world_compiler.test.ts:136-176`; load emitted `WorldChecker`. Confirm every no-directive transition in that World explicitly says `directive: null`, especially `CONFIRM_PAYMENT`. Execute the actual README TS snippet or an identical shared fixture against this checker: accepted payment followed by a refused attempt leaves `PAID` (no rejection rollback). On a **single checker**, start a payment whose `persist` Promise is held then rejects; queue another payment before releasing it. Assert the second callback has not run while the first is pending; the first caller receives the original rejection; `rollbackLastStep()` restores `CREATED` before the second step; and the second call succeeds and leaves `PAID`. Check callback counts/order, not only source text.
- [x] **Step 2: Run RED.** `pnpm run build && node --test dist/tests/test_public_fabric_example.test.js`. Expected: current inline-map YAML parse fails first; after documenting that failure, the current `createWorldChecker()`/`payload`/rejection rollback and missing World directive prevent the target behavior. Keep these defects distinct in test output.
- [x] **Step 3: Publish the minimal example.** Expand README inline context maps to the supported indented YAML subset and put `directive: null` on `CONFIRM_PAYMENT` (and any other no-directive transition). Use `new WorldChecker()` from the generated `./world/world_checker.js`; send `eventPayload` with no `proposedDirective` or with explicit null. On `!verdict.allowed` throw without rollback. In `try { await persist(orderId, verdict.currentState); } catch (error) { checker.rollbackLastStep(); throw error; }`, place no `await` between catch and rollback. Serialize the entire step/persist/rollback operation with a Promise tail that recovers after rejection so later queued calls still run, while each caller sees its own outcome. Make the injected callback type `(_orderId: string, _state: string) => Promise<void>` and avoid an undefined `db`. State that all users of this checker must use the serialized path and that a callback which commits before throwing needs compensation, idempotency or a real transaction.
- [x] **Step 4: Audit the packaged skill.** Replace its unsafe TS pattern, remove the nonexistent Python `rollback_last_step()` usage, and describe Python post-success rollback as an open gap. Check `src/cli.ts` usage and `src/scaffold.ts` Python import: use `kadmos infer <requirements-file>` (not `infer --prd`), pass requirements prose to `kadmos legislate <requirements-file>` (not `world.yaml`), and if a Python example remains use the scaffold's `src/world` path plus `from world_checker import WorldChecker`. Use `eventPayload`, not `payload`, in both languages; spell `directive: null` in any full no-directive World snippet. Check `rg -n 'payload:|rollbackLastStep|rollback_last_step|atomic|guarantee|infer --prd|legislate world.yaml|world.world_checker' README.md skills/kadmos/SKILL.md examples src/scaffold.ts`; preserve factual adapter behavior, correcting misleading public instructions.
- [x] **Step 5: Run GREEN and commit.** Run the focused execution test and `pnpm run verify`. Expected: all tests/typecheck pass; no generated seam edited. Commit the example and test as a reviewed unit.

### Task 3: Current World semantics and generated-checker conformance

**Files:** Create `docs/world-semantics-v0.md`, `tests/test_world_semantics_conformance.test.ts`. Do not edit compiler/checker generators in this task.

**Interfaces:** Consumes `parseWorldSpec`, `compileWorldSpec`, `compileWorldSpecPython`; produces independent expected observations and a documented semantic contract. It does not define a new API.

- [x] **Step 1: Write fixed World fixtures in the test.** A `START -> DONE` World has `a: integer(0..10, default 2)`, `b: integer(0..10, default 0)`, explicit `directive: null`, and effects `a = a + 1`, `b = a + 1`; expected post-context is `{a:3,b:4}`. A second effect may use `state == 'DONE'` in an expression with a string context to pin destination visibility. Add a separate transition with `directive: SEND` to test exact matching. Every ordinary fixture transition declares its directive. Use independent literal expected verdict fields, not one checker as the sole oracle for the other.
- [x] **Step 2: Compile and execute both emitted languages.** Reuse the temp projection compile pattern in `tests/test_harness_world_compiler.test.ts` for TS; write `ports.py`, `world_checker.py`, and a small Python runner to the same temp directory, invoke `python3 -B` (Windows: `python`), and parse JSON output. Use a table of deterministic requests and expected `allowed`, state, context, directive, violation code and trace length.
- [x] **Step 3: Add hostile and rollback cases.** Cover explicit World null directive with omitted request `proposedDirective` (allowed) versus an explicit World `SEND` with missing/wrong request directive (`UNAUTHORIZED_DIRECTIVE`). Separately create one deliberately **omitted World directive** fixture and assert emitted TS typecheck failure and emitted Python import `SyntaxError`; if emitted JS is run despite diagnostics, assert TS `UNAUTHORIZED_DIRECTIVE` and unchanged state, not a fake parity verdict. Cover guard `true` vs nonboolean result; integer default/min/max, fraction and safe-integer overflow in reset/effects; boolean/string pretending to be an integer at effect/reset; reserved payload keys `__proto__`, `constructor`, `prototype` at sanitizer; malformed request primitive at request admission; accepted then rejected history; failed reset preserving state; terminal refusal; generated TS rollback consuming one savepoint. Show that payload booleans/fractions/unsafe numbers are copied, then refused only when consumed by an integer effect or failing guard/invariant; pin the actual violation stage. Add expression probes for falsy property base → null, division by zero producing non-finite, equality on non-finite, and refusal where a finite numeric operand or integer context is required. For Python, assert the current absence of a public post-success rollback method in a capability-gap test. If existing behavior already passes, record characterization evidence rather than inventing a RED result.
- [x] **Step 4: Write `docs/world-semantics-v0.md`.** Define restricted YAML and explicit World directive requirement, expression precedence/eager logical/falsy property/non-finite behavior, sequential effects, strict request-field admission versus permissive primitive payload copying, exact boolean guards/invariants, ordered refusal stages/codes, history and directive rules, reset and rollback boundaries, TS/Python comparison limits. Explicitly separate a defect register: omitted World directive causing TS typecheck/Python import failure (with latent TS refusal/Python `KeyError` if their runtime bodies are reached), empty-invariant TS typecheck failure, TS port omission of `rollbackLastStep`, Python/interpreted lack of public post-success rollback, any observed mismatches. Cite test names and source paths; keep private task IDs out. Do not label a defect as contractual desired behavior.
- [x] **Step 5: Verify and commit.** Run `node --test dist/tests/test_world_semantics_conformance.test.js` after build, `pnpm run verify`, and `pnpm run test:fuzz`; record seed/coverage and failures. Expected: characterization tests pass and no generated code is changed. Commit semantic doc and tests together.

### Task 4: Packed clean-consumer Quick Start and MCP

**Files:** Create `tests/test_packed_quickstart.test.ts`; modify `README.md` and `src/scaffold.ts` only for empirically reproduced instruction/scaffold defects; update `tests/test_scaffold.test.ts` if scaffold changes.

**Interfaces:** Consumes `package.json` files allowlist, `bin/kadmos.js`, `bin/kadmos-mcp.js`, `src/scaffold.ts` output and current MCP JSON-RPC interface. Produces a reproducible local tarball consumer probe, no network dependency or publish action.

- [x] **Step 1: Add the failing clean-consumer test.** From repo root run `pnpm pack --pack-destination <temp>` after build; create a second temp consumer with its own `package.json`, install the tarball with an offline/frozen local dependency strategy that does not symlink this repo's `node_modules`, and resolve package binaries from that consumer. Assert package file list excludes `tests/`, `examples/`, `docs/`, caches and notes while retaining README, packaged skill, `LICENSE`, `bin/` and `dist/src/`. Parse Markdown links in the **packed** README and skill; for each relative file target (ignore fragment-only links and external URLs), resolve from that file's packed directory and assert the target exists in the tarball. In particular, `[MIT](LICENSE)` must resolve; do not add a packed README/skill link to excluded `docs/world-semantics-v0.md`. If pnpm store lacks a dependency, report environmental blockage rather than substituting a linked install.
- [x] **Step 2: Walk the documented route.** Run installed `kadmos demo`, `kadmos init <temp>/app --lang all`, then the generated `compile` and `test` scripts; install the scaffold's declared dependencies in the temp app and run `test:worker` plus Python `unittest` using the documented commands. Assert actual exit codes and key state/verdict output. The current scaffold uses `@substratum-labs/kadmos: "latest"`; for a local unreleased probe, rewrite only the temporary consumer manifest to the packed tarball path, never the source repo manifest.
- [x] **Step 3: Probe MCP stdio.** Spawn both installed CLI forms: `kadmos mcp` and `kadmos-mcp`. Send newline-delimited JSON-RPC `initialize`, `tools/list`, and `tools/call` for `kadmos_step` with a tiny World. Assert server handshake, four tool names, allowed verdict and JSON-only stdout. Use the shapes in `tests/test_mcp_server.test.ts`; do not infer client integration from a ping alone.
- [x] **Step 4: Correct only reproduced discrepancies.** If the generated Quick Start uses a script/command that fails, change `README.md` or `src/scaffold.ts` with a failing regression first, then rerun the clean consumer. Generated scaffold CI currently requests pnpm 11 while root `packageManager` says pnpm 10.32.1; change that only if the probe reproduces a failure. Do not promise external `npx` network behavior or public 0.1.2 availability based on a local tarball test.
- [x] **Step 5: Final gate and commit.** Run focused probe, `pnpm run verify`, `pnpm run test:fuzz`, `pnpm pack --dry-run`, and `git diff --check`. Record Node/Python versions, package file count, consumer install source, commands and exit codes. Commit only scoped files. Submit the branch for independent review through the parent's physical workflow; do not publish, push or merge as part of this plan handoff.

## Deferred roadmap (no implementation in this batch)

| Priority | Dependency | Done criterion for its later, separately reviewed plan |
| --- | --- | --- |
| 5. Harmonia correspondence | Accepted Tasks 1–4; explicit resumption of paused T-396 | Reference World-to-semantics and emitted-checker-to-target correspondence obligations defined, independently checked, counterexamples retained; no claim from differential fuzzing alone. |
| 6. Real Fabric faults | Task 2 rollback limit and chosen persistence architecture | Fault injection for partial commit/crash/retry/concurrency with durable reconciliation evidence; no checker-only atomicity claim. |
| 7. Templates/diagnostics | Stable Task 3 contract and Task 6 outcomes | Optional templates and actionable diagnostics tested on real fixtures without weakening existing Worlds. |
| 8. Composition/backends | Stable reference semantics and reviewed composition contracts | Sound mapping and counterexample validation for composed Worlds or selected verification backend, with explicit limits. |

## Execution self-review

- [x] Map every spec priority to Tasks 1–4 or the deferred table; stop if a task silently starts priorities 5–8.
- [x] Recheck public example signatures against the emitted checker and README World before editing.
- [x] Confirm each characterization test has a fixed independent expectation; document a mismatch instead of changing the compiler under this plan.
- [x] Recheck the five Review Focus cases against the owning task's executed tests.
- [x] Re-read both docs and `git diff --check`; record any baseline/environment failure separately from product regressions.

Execution deviations recorded in `docs/verification/2026-10-08-public-assurance-and-semantics.md`: omitted-World-directive projection fails earlier than the accepted plan anticipated; empty invariants fail emitted TS typecheck; CLI/demo copy needed narrowing; and the clean consumer used `--prefer-offline` after local metadata was unavailable. The generator and scaffold were not changed.
