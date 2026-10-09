# Generator Admission and Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the physical Codex worker. Steps use checkbox (`- [ ]`) syntax for tracking. The coordinator's physical Grok preflight ACCEPT is required before any product edit; do not dispatch virtual subagents.

**Goal:** Make admitted Worlds and one-step rollback behave consistently in interpreted TypeScript, emitted TypeScript, and emitted Python, with independent expected-outcome tests.

**Architecture:** A shared admission module yields a canonical World with a required null/string directive. Both compilers and the interpreted checker enter through it; each checker implements the same one-savepoint lifecycle. A reusable command runner checks all three paths against hand-authored outcomes, while the seeded public fuzzer remains compatible.

**Tech Stack:** TypeScript 7/NodeNext, Node 20/22, pnpm 10.32.1, generated Python 3.10–3.13, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-08-generator-admission-and-rollback-design.md`

## Global Constraints

- Start implementation only after physical Grok preflight ACCEPT. No generated seam is edited by hand.
- World grammar stays `kadmos.world.v0`; compiler contract marker is `kadmos.compiler.k02.v1`; manifest starts at `0.1.2` and is not published here.
- Keep generated TS/Python zero dependency, existing `transitionId`/`eventPayload`/`proposedDirective` request keys, and seeded `kadmos test` flags/report.
- Python floor is 3.10; root CI gate is Node 20/22, Python 3.10–3.13, Ubuntu/macOS/Windows (24 jobs).
- A savepoint holds only checker memory. Fabric must serialize physical work and call rollback only after an accepted step whose physical effect fails.
- Commit reviewable task units on the named branch; no push, PR, release, tag, deployment, or Harmonia T-396 resumption by this worker.

## File map

| File | Responsibility |
| --- | --- |
| `src/types/world.ts` | Separate optional source directive from required canonical directive. |
| `src/world_admission.ts` (new) | Validate direct/YAML models once, normalize only absent directive, return owned canonical data. |
| `src/world_compiler.ts` | Restricted YAML entry and TS projection; re-export admission, version marker, TS port and empty-invariant fix. |
| `src/python_compiler.ts` | Python projection, valid zero-directive alias, savepoint and Protocol. |
| `src/world_checker.ts`, `src/types/ports.ts` | Interpreted checker admission/savepoint and source interface. |
| `tests/test_harness_world_compiler.test.ts`, `tests/test_python_compiler.test.ts` | Admission and projection regressions. |
| `tests/test_world_semantics_conformance.test.ts`, `tests/world_three_path_runner.ts` (new) | Fixed expected command traces across all paths. |
| `src/fuzzer.ts`, `tests/test_fuzzer.test.ts` | Preserve seeded API; extend only for a demonstrated command coverage gap. |
| `docs/world-semantics-v0.md`, `README.md`, `skills/kadmos/SKILL.md` | Replace stale defect descriptions and show tested rollback use. |
| Checked-in example/adapter `ports.*` and `world_checker.*` | Regenerate by canonical CLI if compiler marker/output changes. |

## Review Focus

1. A direct transition with an **own** `directive: undefined` must be rejected, while an absent property becomes null; Task 1 pins both.
2. A World with `context: {}`, `invariants: []`, and `transitions: []` must emit importable/strictly typed code and refuse unknown steps; Task 2 pins it.
3. A failed reset after an accepted step must preserve the old savepoint and accepted-history diagnostic prefix; Task 3 pins it.
4. A returned verdict/trace or caller-owned request payload must not mutate a saved history snapshot; Task 3 pins it.
5. A Python bool supplied for an integer reset/effect must be refused at the existing bounds/effect stage; Task 4 pins it.

---

### Task 1: Canonical World admission

**Files:** Create `src/world_admission.ts`; modify `src/types/world.ts`, `src/world_compiler.ts`, `src/python_compiler.ts`, `src/world_checker.ts`, `src/index.ts`; test `tests/test_harness_world_compiler.test.ts`.

**Interfaces:** `TransitionDefInput = Omit<TransitionDef, "directive"> & { readonly directive?: string | null }`; `WorldSpecInput = Omit<WorldSpec, "transitions"> & { readonly transitions: readonly TransitionDefInput[] }`; `admitWorldSpec(raw: unknown): WorldSpec`. `parseWorldSpec(source: string): WorldSpec`; `compileWorldSpec(spec: WorldSpecInput): WorldProjection`; `compileWorldSpecPython(spec: WorldSpecInput): PythonWorldProjection`; `createWorldChecker(rawSpec: WorldSpecInput, rawInitialContext?: Partial<WorldContext>): IWorldChecker`. Canonical `TransitionDef.directive` remains required.

- [ ] **Step 1: Write failing admission cases.** In `tests/test_harness_world_compiler.test.ts`, use a minimal World with one initial state, `context: {}`, `invariants: []`, and a `GO` transition lacking `directive`. Assert `parseWorldSpec(yaml).transitions[0]?.directive === null`. Pass the equivalent object directly through each compiler and `createWorldChecker` and assert no-directive `GO` accepts. Add explicit null, string `SEND`, explicit own `undefined`, `7`, `true`, `{}`, and `[]`: only absent/null/string pass, and non-null malformed values throw `/INVALID_WORLD: directive/` before emission/checker creation. Add malformed direct initial state, duplicate transition ID, undeclared endpoint, invalid guard/effect, and invalid context bounds to demonstrate the shared boundary. Assert the original object has not gained a directive property.

  ```ts
  const absent = { id: "GO", from: "START", to: "DONE", guard: true, effects: [] };
  assert.equal(admitWorldSpec({ ...base, transitions: [absent] }).transitions[0]?.directive, null);
  assert.equal(Object.hasOwn(absent, "directive"), false);
  for (const bad of [undefined, 7, true, {}, []]) {
    assert.throws(() => admitWorldSpec({ ...base, transitions: [{ ...absent, directive: bad }] }), /INVALID_WORLD: directive/);
  }
  ```
- [ ] **Step 2: Run the RED probe.** `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_harness_world_compiler.test.js`. Expect the omitted directive and bypass cases to fail on current source; capture the actual diagnostics.
- [ ] **Step 3: Implement one admission path.** Move the present `parseWorldSpec` model validation from `src/world_compiler.ts` to `admitWorldSpec` without changing its v0 rules. Have the parser call it on `parseYaml(source)`. For every transition, check `Object.hasOwn(transition, "directive")`: absent writes null into a newly created canonical transition; own null or nonempty string passes; own undefined and every other value throws `INVALID_WORLD: directive`. Copy state/context/invariant/transition objects and arrays into an owned canonical result before returning. Validate before calling `structuredClone` on hostile direct objects so proxies/accessors cannot be executed as a side effect; refuse them with `INVALID_WORLD` rather than coercing. Both generators and interpreted checker call admission at entry. Keep `.js` relative import suffixes. Export the function through `src/world_compiler.ts` and `src/index.ts`.

  ```ts
  const hasDirective = Object.hasOwn(transition, "directive");
  const directive = hasDirective ? transition.directive : null;
  if (directive !== null && (typeof directive !== "string" || directive.length === 0)) {
    throw new Error("INVALID_WORLD: directive");
  }
  const canonicalTransition: TransitionDef = {
    id: transition.id as string,
    from: transition.from as string,
    to: transition.to as string,
    guard: transition.guard as string | boolean,
    effects: [...(transition.effects as string[])],
    directive,
  };
  ```
- [ ] **Step 4: Run GREEN plus compatibility probes.** Run the focused command above, `node --test dist/tests/test_python_compiler.test.js`, then `pnpm run typecheck`. Existing explicit-null/string fixtures and public entrypoints must still pass.
- [ ] **Step 5: Commit the admission unit.** `git add src/types/world.ts src/world_admission.ts src/world_compiler.ts src/python_compiler.ts src/world_checker.ts src/index.ts tests/test_harness_world_compiler.test.ts && git commit -m "fix: canonicalize World directive admission"`.

### Task 2: Empty model projections and compiler pin

**Files:** Modify `src/world_admission.ts`, `src/world_compiler.ts`, `src/python_compiler.ts`, `src/index.ts`; test `tests/test_harness_world_compiler.test.ts`, `tests/test_python_compiler.test.ts`.

**Interfaces:** `KADMOS_COMPILER_CONTRACT_VERSION: "kadmos.compiler.k02.v1"` exported by compiler/index and stamped in all four generated headers; existing projection object keys stay `portsDts`/`worldCheckerTs` and `portsPy`/`worldCheckerPy`.

- [ ] **Step 1: Write RED projection matrix.** For YAML and direct Worlds, test (a) one initial state with no context/invariants/transitions, (b) one null or omitted directive with no named directives, (c) mixed null and `SEND`. Compile emitted TS with the existing strict NodeNext `tsc` invocation in `tests/test_world_semantics_conformance.test.ts`. Import `ports.py` and `world_checker.py` under the available Python, and assert `WorldDirective` resolves to `None` for no names. Assert no synthetic invariant was emitted and `new WorldChecker().step({transitionId:"UNKNOWN"})` yields `INVALID_TRANSITION` for nonterminal initial state. Assert version markers match the exported constant.
- [ ] **Step 2: Run RED.** `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_harness_world_compiler.test.js dist/tests/test_python_compiler.test.js dist/tests/test_world_semantics_conformance.test.js`. Expect strict TS `never` to fail before the fix. Python `WorldDirective = None` already works for explicit-null/no-transition Worlds; keep that case as a passing compatibility probe. Task 1 fixes the omitted-directive Python failure.
- [ ] **Step 3: Repair projections.** In emitted TS, assign `world.invariants` to a typed readonly `{id: string; predicate: string}[]` view before the check loop; retain the actual empty array. In Python, ensure `literal([])` is used without a `Literal[...]` wrapper and yields `None` for `WorldDirective`. Define `KADMOS_COMPILER_CONTRACT_VERSION = "kadmos.compiler.k02.v1"` in `src/world_admission.ts`; re-export it from compiler/index and stamp it as a comment in TS `ports.d.ts`/checker and Python `ports.py`/checker. Do not alter package version, dependencies, or grammar.
- [ ] **Step 4: Run GREEN.** Repeat the focused command and `pnpm run typecheck`; use Python 3.10–3.13 explicitly in CI, and locally report only interpreters actually present.
- [ ] **Step 5: Commit.** `git add src/world_admission.ts src/world_compiler.ts src/python_compiler.ts src/index.ts tests/test_harness_world_compiler.test.ts tests/test_python_compiler.test.ts tests/test_world_semantics_conformance.test.ts && git commit -m "fix: project empty Worlds and pin compiler contract"`.

### Task 3: One-step rollback across checkers

**Files:** Modify `src/types/ports.ts`, `src/world_checker.ts`, `src/world_compiler.ts`, `src/python_compiler.ts`; test `tests/test_world_semantics_conformance.test.ts`, `tests/test_python_compiler.test.ts`.

**Interfaces:** Source and emitted TS `IWorldChecker.rollbackLastStep(): void`; emitted Python `IWorldChecker.rollback_last_step() -> None`. Stable no-savepoint/busy error prefix `NO_CHECKER_SAVEPOINT`. Existing `reset`, `step`, `getState`/`getContext`, `get_state`/`get_context` signatures stay compatible.

- [ ] **Step 1: Write RED lifecycle tests.** On each path, run `rollback` before success (error), `step A` (success), rejected `step X`, failed `reset` (error), then `rollback` (restores pre-A state/context/history); second rollback errors. Run `step A; step B; rollback` and assert only B is undone. Run `step A; reset({}) ; rollback` and assert no savepoint. Make one fixture produce an accepted payload/history record, mutate the original request and returned diagnostic trace, then reject another step and assert its accepted prefix is unchanged. Add invalid initial context/invariant and reentrant hostile payload probes; errors must leave no leaked savepoint. Check `rollback` while busy preserves savepoint for a later non-busy call.
- [ ] **Step 2: Run RED.** `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_world_semantics_conformance.test.js dist/tests/test_python_compiler.test.js`. Interpreted TS and emitted Python currently lack public methods, and both emitted port contracts lack declarations.
- [ ] **Step 3: Implement interpreted TS savepoint.** Add closure-private `undo: {state: WorldState; context: Record<string, number | string>; history: StepRecord[]} | null = null`. After all step checks pass and before publishing candidate state/context/history, replace `undo` with deep copied pre-step values. Preserve it on every rejection/exception and failed reset; clear it only on successful reset or completed rollback. `rollbackLastStep` checks `busy || undo === null` first, throws `Error("NO_CHECKER_SAVEPOINT")`, then restores copies and consumes it. Add method to source `IWorldChecker`.

  ```ts
  // After guard, effects, bounds, and invariants succeed:
  undo = { state: snapshotState, context: { ...snapshotContext }, history: structuredClone(snapshotHistory) };
  state = transition.to;
  context = candidateContext;
  history.push(deepFreeze(record));
  // In rollbackLastStep, after the busy/missing check:
  const saved = undo;
  undo = null;
  state = saved.state;
  context = { ...saved.context };
  history = structuredClone(saved.history);
  ```
- [ ] **Step 4: Align emitted TS.** Declare the existing class method on generated `IWorldChecker`. Review snapshot and publication ordering in `src/world_compiler.ts`; ensure rejected/exception paths do not alter `#undo`, success replaces it, successful reset clears it, and saved history uses structured copies. Do not edit generated output directly.
- [ ] **Step 5: Implement emitted Python.** Add `rollback_last_step` to the generated Protocol and checker. Store the deep copied pre-success triple in `self.__undo`; `reset` success clears it; refusal/exception/failed reset leaves it. Check `_busy` and missing savepoint before restore; raise `RuntimeError("NO_CHECKER_SAVEPOINT")`. Keep existing public `state`, `context`, `history`, and `_busy` attributes because tests and adapters inspect them; the private savepoint must never alias these mutable values. Preserve exact primitive tests (`type(value) is int`, etc.), `copy.deepcopy` history, and Python 3.10 syntax.
- [ ] **Step 6: Run GREEN and commit.** Repeat focused tests, `pnpm run typecheck`, and relevant worker/adapter tests from `pnpm run verify`; then `git add src/types/ports.ts src/world_checker.ts src/world_compiler.ts src/python_compiler.ts tests/test_world_semantics_conformance.test.ts tests/test_python_compiler.test.ts && git commit -m "fix: align one-step checker rollback"`.

### Task 4: Independent three-path expected outcomes

**Files:** Create `tests/world_three_path_runner.ts`; modify `tests/test_world_semantics_conformance.test.ts`; modify `src/fuzzer.ts`/`tests/test_fuzzer.test.ts` only if the focused comparison exposes a reusable gap.

**Interfaces:** Test-only `Command = {kind:"step"; request:unknown} | {kind:"reset"; context?:unknown} | {kind:"rollback"} | {kind:"getState"} | {kind:"getContext"}`; `Observed = {kind: Command["kind"]; verdict?: NormalizedVerdict; state:string; context:Record<string,number|string>; errorCode?:string}`. `runThreePaths(world: WorldSpecInput, commands: readonly Command[]): Promise<{interpreted:Observed[]; emittedTs:Observed[]; emittedPy:Observed[]}>`. Python runner consumes JSON commands over stdin and emits JSON observations; TS runner invokes compiled classes directly. Exception normalization uses only stable prefixes, not language class names.

- [ ] **Step 1: Add the runner with strict compilation/import gates.** Reuse the temporary emitted TS/Python setup in the current conformance test. Each command captures post-command state/context and either normalized verdict or normalized error. Preserve `shortestCounterexampleTrace` order and own presence of optional directive/payload keys; normalize Python `None` to JSON null. Throw on unknown error prefix so the runner cannot hide a new failure.

  ```ts
  const stableErrors = /^(INVALID_BOUNDS|INITIAL_INVARIANT_FAILED|NO_CHECKER_SAVEPOINT|REENTRANCY_DETECTED)(?::|$)/;
  function errorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const match = stableErrors.exec(message);
    if (!match) throw error;
    return match[1]!;
  }
  ```
- [ ] **Step 2: Replace stale defect assertions with expected sequences.** In `tests/test_world_semantics_conformance.test.ts`, remove `expectedCompileError` and `expectedFailure` branches and the `public_rollback:false` expectation. Use literal expected observations for omitted/explicit-null/string directives, ordered effects, guard/bounds/invariant refusal stages, correct/wrong/no directive, accepted-history-plus-attempt, reset/rollback lifecycle, and empty model. Assert each of `interpreted`, `emittedTs`, and `emittedPy` equals the literal expected sequence independently. Add `true` versus integer `1` for Python integer reset/effect stage, and verify no silent coercion.
- [ ] **Step 3: Run RED/GREEN deliberately.** Run `pnpm run build && node --test dist/tests/test_world_semantics_conformance.test.js`. First capture any failing case as a real mismatch; fix only this spec's admission/rollback contract in the owning earlier task. Rerun until all three paths match the independent expected sequence. Run `pnpm run test:fuzz -- --seed 20261008` only if CLI argument forwarding is supported; otherwise use `node bin/kadmos.js test conformance/fixtures/order_settlement.world.yaml --runs 30 --seed 20261008`. Preserve existing `FuzzOptions`, `FuzzReport`, CLI flags, seeded reproducibility and report shape; do not silently redefine random traces as proof.
- [ ] **Step 4: Commit.** `git add tests/world_three_path_runner.ts tests/test_world_semantics_conformance.test.ts` plus `src/fuzzer.ts tests/test_fuzzer.test.ts` only if actually changed, then `git commit -m "test: pin three-path checker outcomes"`.

### Task 5: Documentation, regeneration, packaging, and final evidence

**Files:** Modify `docs/world-semantics-v0.md`, `README.md`, `skills/kadmos/SKILL.md`; modify `tests/test_public_fabric_example.test.ts` if adding the displayed Python failure example; regenerate checked-in projection files only by CLI; create `docs/verification/2026-10-08-generator-admission-and-rollback.md`.

**Interfaces:** Public docs describe `kadmos.compiler.k02.v1`, canonical directive admission, empty invariants, all three rollback APIs, physical-failure sequence and empirical conformance limits. Projection generation uses `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build` then `node bin/kadmos.js compile <world-file> --out <projection-directory> --lang all`, with paths matched to each example/scaffold.

- [ ] **Step 1: Update documentation from passing behavior.** Remove the three now-stale known-defect items from `docs/world-semantics-v0.md`; state omitted directive normalization, no invariant tautology, savepoint lifecycle, Python method, and current limits. Update README and copied skill consistently. If adding a Python physical-failure snippet, have `tests/test_public_fabric_example.test.ts` extract and execute that exact fence against emitted Python with a failed callback, rollback, propagated original error, and subsequent accepted step; otherwise state the Python usage in prose without an untested runnable fence.
- [ ] **Step 2: Regenerate projections.** Inventory `rg --files examples src/adapters | rg '(ports\.(d\.ts|py)|world_checker\.(ts|py)|world\.yaml)$'`. For each checked-in projection whose generating World is present, run the documented `kadmos compile` command using the compiler, then compare generated files with `git diff`; no hand edits. Leave unrelated fixtures alone. Run adapter/worker tests after regeneration.
- [ ] **Step 3: Run local acceptance.** With frozen dependencies and needed loopback/network escalation, run `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run verify`, `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run test:fuzz` with seed recorded, `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm pack --dry-run`, `git diff --check`, and `git status --short`. `verify` includes the packed clean-consumer starter/MCP test and BullMQ tests. Run strict emitted TS/Python import probes separately for the edge Worlds; list locally available Python versions, and leave missing 3.10–3.13 checks to the required CI matrix.
- [ ] **Step 4: Record precise evidence and pin.** In the verification document record commands, exits, test counts, seed/trace count, pack inventory, platform versions, compiler contract marker, manifest version, generated projection paths, and exact implementation commit SHA after the code commit. State that CI 24-job and physical Grok final review remain pending until the coordinator executes them. Harmonia's later pin is the final reviewed/integrated immutable source SHA, to be updated by the coordinator after review; never invent it in advance.
- [ ] **Step 5: Commit and hand off.** `git add` only scoped docs/tests/CLI-regenerated files; `git commit -m "docs: record generator contract and verification"`; inspect `git status --short --branch` and `git log -1 --oneline`. Send the coordinator branch, base, commits, exact local evidence and pending 24-job/final-review gates. Do not push or open a public PR.

## Self-review before execution

- [ ] Confirm all spec sections map to Tasks 1–5 and every Review Focus item has an owning regression.
- [ ] Check the exact method names: `rollbackLastStep` in both TS paths, `rollback_last_step` in Python; no alias substituted.
- [ ] Check admission import graph: `world_admission.ts` has no compiler import; both generators and checker import it; compiler re-export is compatibility only.
- [ ] Scan for incomplete instructions (`TBD`, `TODO`, vague test/implementation steps) and resolve them before preflight.
- [ ] Confirm no step mutates generated seams manually or claims finite tests prove bisimulation.
