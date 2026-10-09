# Public Assurance and World Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This is native physical execution with no virtual subagents. Steps use checkbox (`- [ ]`) syntax for tracking. Product execution starts only after independent physical Grok preflight acceptance coordinated by the parent.

**Goal:** Make Kadmos developer-preview claims and Fabric examples accurate, pin observed World semantics with executable TS/Python tests, and verify the actual packaged Quick Start and MCP path.

**Architecture:** Keep the current World parser, expression evaluator, checker generators, CLI and fuzzer architecture. Put current-behavior semantics in docs and tests; correct public prose/examples; run a packed clean-consumer probe. Any newly discovered semantic defect requiring behavior change gets a separate reviewed proposal.

**Tech Stack:** Node >=20, pnpm 10.32.1, TypeScript 7.0.2/NodeNext, Python >=3.10, built-in `node:test`, generated zero-dependency checkers.

**Spec:** `docs/superpowers/specs/2026-10-08-public-assurance-and-semantics-design.md`

## Global Constraints

- Work only in the native isolated Kadmos worktree and a named feature branch; do not touch main checkout, Harmonia, or the concurrent primary coordination checkout.
- `world.yaml` is policy; generated `ports.d.ts`, `world_checker.ts`, `ports.py`, and `world_checker.py` are read-only projections.
- No new public API, runtime dependency, unsolicited compiler rewrite, release publish, or public PR in the first batch.
- Runtime admission must refuse malformed primitive inputs without coercion; preserve checker state/history on refusal.
- Verify with `pnpm run verify`, `pnpm run test:fuzz`, and `pnpm pack --dry-run` for packaging work. Collect exact command outputs and exit codes.
- Current design describes implemented behavior. Correctness proof, differential evidence, reference semantics, and target correspondence remain separate claims.

## Review Focus

1. A rejected request after an accepted step must leave that accepted state intact; Task 2 tests it against the emitted TS checker.
2. An async persistence callback that throws after authorization must trigger checker rollback before a later queued call; Task 2 tests it.
3. Sequential effects must read the prior effect's new value and destination state; Task 3 tests both emitted languages against fixed expected values.
4. Boundary and malformed values (`bool`, string integer, fraction, unsafe integer, reserved payload key) must be refused in the documented stage; Task 3 tests them against fixed verdicts.
5. A clean tarball consumer must find both MCP entry points and generated starter scripts without relying on this repo's `node_modules`; Task 4 tests them.

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
| `tests/test_release_hygiene.test.ts` | Keep existing package allowlist assertion; add only a claim-specific guard if needed |

Do not hand-edit checked-in generated checker files. `src/world_compiler.ts`, `src/python_compiler.ts`, `src/world_expression.ts`, `src/world_checker.ts`, and `src/fuzzer.ts` are reference files for this batch, not preauthorized mutation targets. Document a behavior-change issue and seek separate review if a test exposes a defect.

### Task 1: Public assurance language

**Files:** Modify `README.md`, `skills/kadmos/SKILL.md`; optionally test `tests/test_release_hygiene.test.ts`.

**Interfaces:** Consumes the spec evidence table and current CLI/skill text. Produces public language that Task 2's example and Task 4's packaged probe can use.

- [ ] **Step 1: Record the exact claims.** Run `rg -n -i 'proof|proven|bisimulation|shortest|atomic|rollback|verified|guarantee' README.md skills/kadmos/SKILL.md`; keep a before/after checklist with each affected sentence and its code/test evidence.
- [ ] **Step 2: Add a focused failing release-copy test only for stable, high-risk wording.** For example, in `tests/test_release_hygiene.test.ts` assert `assert.doesNotMatch(readme, /algebraic proof of correctness|mathematically verified|verify cross-language bisimulation/i);` and assert the skill does not promise external atomicity. Run `node --test dist/tests/test_release_hygiene.test.js` after `pnpm run build` and confirm RED.
- [ ] **Step 3: Edit prose.** State that `step()` checks the given transition against the declared World and refuses observed invalid inputs; seeded differential tests compare selected TS/Python traces; a violation trace is the accepted prefix plus refused attempt. Keep the real features and developer-preview roadmap. Remove unconditional “shortest” and proof wording from diagrams, tables, commands and skill phases as well as paragraphs.
- [ ] **Step 4: Verify.** Run the focused test and `rg` audit again. Expected: no unsupported claims; the existing command table, package skill, BullMQ preview and roadmap remain discoverable. Commit only the Task 1 files, e.g. `git commit -m "docs: calibrate Kadmos assurance claims"`.

### Task 2: Executable Fabric rollback example

**Files:** Modify `README.md`, `skills/kadmos/SKILL.md`; create `tests/test_public_fabric_example.test.ts`.

**Interfaces:** Consumes emitted `WorldChecker` from `compileWorldSpec(parseWorldSpec(...))` and the README's `CONFIRM_PAYMENT` World. Produces an honest `processPayment(orderId, amount, persist)` example with per-checker serialization. No new package export.

- [ ] **Step 1: Write a failing executable test.** Compile the README World into a temporary NodeNext ESM directory using the pattern in `tests/test_harness_world_compiler.test.ts:94-181`; load emitted `WorldChecker`. Exercise the logic intended for the README example with injected `persist`: first accepted payment followed by a refused payment leaves the accepted state; a fresh checker with a throwing callback returns to `CREATED`; a deferred callback holds the queue so a second call cannot step until it settles; a successful callback leaves `PAID`. Assert state and callback count/order, not source strings. The test should execute the exact snippet extracted from a marked README TS fence or a dedicated test fixture reproduced verbatim in the README, with an assertion that both match; do not maintain divergent illustrative code.
- [ ] **Step 2: Run RED.** `pnpm run build && node --test dist/tests/test_public_fabric_example.test.js`. Expected: fail on the current README's zero-argument interpreted factory/`payload`/rollback-on-rejection pattern or missing executable marker.
- [ ] **Step 3: Publish the minimal example.** Use `new WorldChecker()` from the generated `./world/world_checker.js`; send `eventPayload`; on `!verdict.allowed` throw without rollback. In `try { await persist(orderId, verdict.currentState); } catch (error) { checker.rollbackLastStep(); throw error; }`, place no `await` between catch and rollback. Serialize the entire step/persist/rollback operation with a Promise tail, including rejected and thrown runs. Make the injected callback type `(_orderId: string, _state: string) => Promise<void>` and avoid an undefined `db`. State that all users of this checker must use the serialized path and that committed external effects need their own recovery design.
- [ ] **Step 4: Audit the packaged skill.** Replace its unsafe TS pattern, remove the nonexistent Python `rollback_last_step()` usage, and describe Python post-success rollback as an open gap. Check `rg -n 'payload:|rollbackLastStep|rollback_last_step|atomic|guarantee' README.md skills/kadmos/SKILL.md examples src/scaffold.ts`; preserve factual adapter behavior, correcting only misleading public instructions.
- [ ] **Step 5: Run GREEN and commit.** Run the focused execution test and `pnpm run verify`. Expected: all tests/typecheck pass; no generated seam edited. Commit the example and test as a reviewed unit.

### Task 3: Current World semantics and generated-checker conformance

**Files:** Create `docs/world-semantics-v0.md`, `tests/test_world_semantics_conformance.test.ts`. Do not edit compiler/checker generators in this task.

**Interfaces:** Consumes `parseWorldSpec`, `compileWorldSpec`, `compileWorldSpecPython`; produces independent expected observations and a documented semantic contract. It does not define a new API.

- [ ] **Step 1: Write fixed World fixtures in the test.** A `START -> DONE` World has `a: integer(0..10, default 2)`, `b: integer(0..10, default 0)`, and effects `a = a + 1`, `b = a + 1`; expected post-context is `{a:3,b:4}`. A second effect may use `state == 'DONE'` in a guard/effect expression with a string context to pin destination visibility. Add a transition with directive `SEND` to test exact matching. Use independent literal expected verdict fields, not one checker as the sole oracle for the other.
- [ ] **Step 2: Compile and execute both emitted languages.** Reuse the temp projection compile pattern in `tests/test_harness_world_compiler.test.ts` for TS; write `ports.py`, `world_checker.py`, and a small Python runner to the same temp directory, invoke `python3 -B` (Windows: `python`), and parse JSON output. Use a table of deterministic requests and expected `allowed`, state, context, directive, violation code and trace length.
- [ ] **Step 3: Add hostile and rollback cases.** Cover exact directive vs missing/wrong directive; guard `true` vs nonboolean result; integer default/min/max, fraction and safe-integer overflow in reset/effects; boolean/string pretending to be an integer; reserved payload key and malformed request; accepted then rejected history; failed reset preserving state; terminal refusal; generated TS rollback consuming one savepoint. For Python, assert the current absence of a public post-success rollback method in a capability-gap test, without pretending the languages have full rollback parity. Run focused test RED if the first expectation targets a missing documented guarantee; if existing behavior already passes, record that the test is characterization evidence rather than inventing a failure.
- [ ] **Step 4: Write `docs/world-semantics-v0.md`.** Define parser/YAML subset, expression precedence and eager logical evaluation, sequential effects, integer and payload admission, exact boolean guards/invariants, ordered refusal stages/codes, history and directive rules, reset and rollback boundaries, TS/Python comparison limits. Explicitly separate a defect register: TS port omission of `rollbackLastStep`, Python/interpreted lack of public post-success rollback, any observed mismatches. Cite test names and source paths. Do not label a defect as contractual desired behavior.
- [ ] **Step 5: Verify and commit.** Run `node --test dist/tests/test_world_semantics_conformance.test.js` after build, `pnpm run verify`, and `pnpm run test:fuzz`; record seed/coverage and failures. Expected: characterization tests pass and no generated code is changed. Commit semantic doc and tests together.

### Task 4: Packed clean-consumer Quick Start and MCP

**Files:** Create `tests/test_packed_quickstart.test.ts`; modify `README.md` and `src/scaffold.ts` only for empirically reproduced instruction/scaffold defects; update `tests/test_scaffold.test.ts` if scaffold changes.

**Interfaces:** Consumes `package.json` files allowlist, `bin/kadmos.js`, `bin/kadmos-mcp.js`, `src/scaffold.ts` output and current MCP JSON-RPC interface. Produces a reproducible local tarball consumer probe, no network dependency or publish action.

- [ ] **Step 1: Add the failing clean-consumer test.** From repo root run `pnpm pack --pack-destination <temp>` after build; create a second temp consumer with its own `package.json`, install the tarball with an offline/frozen local dependency strategy that does not symlink this repo's `node_modules`, and resolve package binaries from that consumer. Assert package file list excludes `tests/`, `examples/`, `docs/`, caches and notes while retaining README, skill, `bin/` and `dist/src/`. If pnpm store lacks a dependency, report environmental blockage rather than substituting a linked install.
- [ ] **Step 2: Walk the documented route.** Run installed `kadmos demo`, `kadmos init <temp>/app --lang all`, then the generated `compile` and `test` scripts; install the scaffold's declared dependencies in the temp app and run `test:worker` plus Python `unittest` using the documented commands. Assert actual exit codes and key state/verdict output. The current scaffold uses `@substratum-labs/kadmos: "latest"`; for a local unreleased probe, rewrite only the temporary consumer manifest to the packed tarball path, never the source repo manifest.
- [ ] **Step 3: Probe MCP stdio.** Spawn both installed CLI forms: `kadmos mcp` and `kadmos-mcp`. Send newline-delimited JSON-RPC `initialize`, `tools/list`, and `tools/call` for `kadmos_step` with a tiny World. Assert server handshake, four tool names, allowed verdict and JSON-only stdout. Use the shapes in `tests/test_mcp_server.test.ts`; do not infer client integration from a ping alone.
- [ ] **Step 4: Correct only reproduced discrepancies.** If the generated Quick Start uses a script/command that fails, change `README.md` or `src/scaffold.ts` with a failing regression first, then rerun the clean consumer. Do not promise external `npx` network behavior based on the local tarball test.
- [ ] **Step 5: Final gate and commit.** Run focused probe, `pnpm run verify`, `pnpm run test:fuzz`, `pnpm pack --dry-run`, and `git diff --check`. Record Node/Python versions, package file count, consumer install source, commands and exit codes. Commit only scoped files. Submit the branch for independent review through the parent's physical workflow; do not publish, push or merge as part of this plan handoff.

## Deferred roadmap (no implementation in this batch)

| Priority | Dependency | Done criterion for its later, separately reviewed plan |
| --- | --- | --- |
| 5. Harmonia correspondence | Accepted Tasks 1–4; explicit resumption of paused T-396 | Reference World-to-semantics and emitted-checker-to-target correspondence obligations defined, independently checked, counterexamples retained; no claim from differential fuzzing alone. |
| 6. Real Fabric faults | Task 2 rollback limit and chosen persistence architecture | Fault injection for partial commit/crash/retry/concurrency with durable reconciliation evidence; no checker-only atomicity claim. |
| 7. Templates/diagnostics | Stable Task 3 contract and Task 6 outcomes | Optional templates and actionable diagnostics tested on real fixtures without weakening existing Worlds. |
| 8. Composition/backends | Stable reference semantics and reviewed composition contracts | Sound mapping and counterexample validation for composed Worlds or selected verification backend, with explicit limits. |

## Self-review before execution

- [ ] Map every spec priority to Tasks 1–4 or the deferred table; stop if a task silently starts priorities 5–8.
- [ ] Recheck public example signatures against the emitted checker and README World before editing.
- [ ] Confirm each characterization test has a fixed independent expectation; document a mismatch instead of changing the compiler under this plan.
- [ ] Recheck the five Review Focus cases against the owning task's executed tests.
- [ ] Re-read both docs and `git diff --check`; record any baseline/environment failure separately from product regressions.
