# Generator Admission and Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the physical Codex worker. Steps use checkbox (`- [x]`) syntax for tracking. The coordinator's physical Grok preflight ACCEPT is required before any product edit; do not dispatch virtual subagents.

**Goal:** Make admitted Worlds and one-step rollback behave consistently in interpreted TypeScript, emitted TypeScript, and emitted Python, with independent expected-outcome tests.

**Architecture:** A shared admission module yields a canonical World with a required null/string directive. Both compilers and the interpreted checker enter through it; each checker implements the same constructor seed, reset, and one-savepoint lifecycle. A reusable command runner checks all three paths against hand-authored outcomes, while the seeded public fuzzer remains compatible.

**Tech Stack:** TypeScript 7/NodeNext, Node 20/22, pnpm 10.32.1, generated Python 3.10–3.13, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-08-generator-admission-and-rollback-design.md`

## Global Constraints

- Start implementation only after physical Grok preflight ACCEPT. No generated seam is edited by hand.
- World grammar stays `kadmos.world.v0`; compiler contract marker is `kadmos.compiler.k02.v1`; manifest starts at `0.1.2` and is not published here.
- Keep generated TS/Python zero dependency, existing `transitionId`/`eventPayload`/`proposedDirective` request keys, and seeded `kadmos test` flags/report.
- Python floor is 3.10; root CI gate is Node 20/22, Python 3.10–3.13, Ubuntu/macOS/Windows (24 jobs).
- A savepoint holds only checker memory. Fabric must serialize physical work and call rollback only after an accepted step whose physical effect fails.
- Constructor and reset accept a plain context object or null/None; null/None means the nullable absence variant, while malformed non-null shapes fail `INVALID_BOUNDS` before enumeration.
- Commit reviewable task units on the named branch; no push, PR, release, tag, deployment, or Harmonia T-396 resumption by this worker.

## File map

| File | Responsibility |
| --- | --- |
| `src/types/world.ts` | Separate optional source directive from required canonical directive. |
| `src/world_admission.ts` (new) | Validate direct/YAML models once, normalize only absent directive, return owned canonical data. |
| `src/world_compiler.ts` | Restricted YAML entry and TS projection; re-export admission, version marker, TS port and empty-invariant fix. |
| `src/python_compiler.ts` | Python projection, valid zero-directive alias, savepoint and Protocol. |
| `src/world_checker.ts`, `src/types/ports.ts` | Interpreted checker constructor seed/reset/savepoint and source interface. |
| `examples/job-queue-benchmark/python_worker.py` | Use the generated Python rollback API after physical failure instead of direct field assignment. |
| `tests/test_harness_world_compiler.test.ts`, `tests/test_python_compiler.test.ts` | Admission and projection regressions. |
| `tests/test_world_semantics_conformance.test.ts`, `tests/world_three_path_runner.ts` (new) | Fixed expected command traces across all paths. |
| `src/fuzzer.ts`, `tests/test_fuzzer.test.ts` | Preserve seeded API; extend only for a demonstrated command coverage gap. |
| `docs/world-semantics-v0.md`, `README.md`, `skills/kadmos/SKILL.md` | Replace stale defect descriptions and show tested rollback use. |
| Checked-in example/adapter `ports.*` and `world_checker.*` | Regenerate by canonical CLI if compiler marker/output changes. |

## Review Focus

1. Own `directive: undefined` and `directive: ""` must fail while absence and YAML `directive:` normalize to null; Task 1 pins each.
2. A nested accessor/proxy in a direct World must be rejected before its getter/trap runs; Task 1 pins zero calls.
3. Explicit `context: {}`, `invariants: []`, and `transitions: []` must emit importable/strictly typed code, while missing collections fail admission; Task 2 pins both.
4. Constructor `{n: 2}` then explicit reset to 4 then bare/null reset must restore 2; malformed resets must preserve an earlier savepoint; Task 3 and Task 4 pin it.
5. Python public context/history copies must not mutate backing state or private undo, and the benchmark worker must roll back an accepted physical failure; Task 3 pins both.

---

### Task 1: Canonical World admission

**Files:** Create `src/world_admission.ts`; modify `src/types/world.ts`, `src/world_compiler.ts`, `src/python_compiler.ts`, `src/world_checker.ts`, `src/index.ts`; test `tests/test_harness_world_compiler.test.ts`.

**Interfaces:** `TransitionDefInput = Omit<TransitionDef, "directive"> & { readonly directive?: string | null }`; `WorldSpecInput = Omit<WorldSpec, "transitions"> & { readonly transitions: readonly TransitionDefInput[] }`; `admitWorldSpec(raw: unknown): WorldSpec`. `parseWorldSpec(source: string): WorldSpec`; `compileWorldSpec(spec: WorldSpecInput): WorldProjection`; `compileWorldSpecPython(spec: WorldSpecInput): PythonWorldProjection`; `createWorldChecker(rawSpec: WorldSpecInput, rawInitialContext?: Partial<WorldContext>): IWorldChecker`. Canonical `TransitionDef.directive` remains required.

- [x] **Step 1: Write failing admission cases.** In `tests/test_harness_world_compiler.test.ts`, use a minimal World with one initial state, explicit `context: {}`, `invariants: []`, and a `GO` transition lacking `directive`. Assert `parseWorldSpec(yaml).transitions[0]?.directive === null` for omission, YAML `directive:`, and YAML `directive: null`; compare the source YAML string before/after parsing. Pass the equivalent object directly through each compiler and `createWorldChecker` and assert no-directive `GO` accepts. Add explicit null, nonempty `SEND`, explicit own `undefined`, empty string, `7`, `true`, `{}`, and `[]`: only absence/null/nonempty string pass; invalid values throw `/INVALID_WORLD: directive/` before emission/checker creation. Add malformed direct initial state, duplicate transition ID, undeclared endpoint, invalid guard/effect, and invalid context bounds to demonstrate the shared boundary. Assert the original object has not gained a directive property. Put a counting getter on nested `directive`, `id`, and `effects` in turn; assert each counter remains zero when admission, either compiler, or interpreted checker rejects the direct model. Repeat with a nested Proxy whose trap counts calls; the Node proxy check precedes any descriptor lookup. YAML cannot contain an accessor, so its probe checks source-type admission and unchanged string input.

  ```ts
  const absent = { id: "GO", from: "START", to: "DONE", guard: true, effects: [] };
  assert.equal(admitWorldSpec({ ...base, transitions: [absent] }).transitions[0]?.directive, null);
  assert.equal(Object.hasOwn(absent, "directive"), false);
  for (const bad of [undefined, "", 7, true, {}, []]) {
    assert.throws(() => admitWorldSpec({ ...base, transitions: [{ ...absent, directive: bad }] }), /INVALID_WORLD: directive/);
  }
  let reads = 0;
  const hostile = Object.defineProperty({ ...absent }, "directive", { get() { reads++; return null; } });
  assert.throws(() => admitWorldSpec({ ...base, transitions: [hostile] }), /INVALID_WORLD/);
  assert.equal(reads, 0);
  ```
- [x] **Step 2: Run the RED probe.** `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_harness_world_compiler.test.js`. Expect the omitted directive and bypass cases to fail on current source; capture the actual diagnostics.
- [x] **Step 3: Implement one admission path.** Move the present `parseWorldSpec` model validation from `src/world_compiler.ts` to `admitWorldSpec` without changing its v0 rules. Have the parser call it on `parseYaml(source)`. Recursively check every input object/array with Node `types.isProxy(value)` before `Object.getOwnPropertyDescriptors(value)`; reject accessor descriptors, then read only descriptor `.value` slots into owned plain records/arrays. Do this before validation touches `.directive`, `.id`, `.effects`, context field definitions, or other nested properties. For each transition, a missing own directive writes null into a newly created canonical transition; own null or nonempty string passes; own undefined and every other value throws `INVALID_WORLD: directive`. Validate required fields and copy objects/arrays into the canonical result. Both generators and interpreted checker call admission at entry. Keep `.js` relative import suffixes. Export the function through `src/world_compiler.ts` and `src/index.ts`.

  ```ts
  // transition is the owned data-only copy produced after proxy/descriptor inspection.
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
- [x] **Step 4: Run GREEN plus compatibility probes.** Run the focused command above, `node --test dist/tests/test_python_compiler.test.js`, then `pnpm run typecheck`. Existing explicit-null/string fixtures and public entrypoints must still pass.
- [x] **Step 5: Commit the admission unit.** `git add src/types/world.ts src/world_admission.ts src/world_compiler.ts src/python_compiler.ts src/world_checker.ts src/index.ts tests/test_harness_world_compiler.test.ts && git commit -m "fix: canonicalize World directive admission"`.

### Task 2: Empty model projections and compiler pin

**Files:** Modify `src/world_admission.ts`, `src/world_compiler.ts`, `src/python_compiler.ts`, `src/index.ts`; test `tests/test_harness_world_compiler.test.ts`, `tests/test_python_compiler.test.ts`.

**Interfaces:** `KADMOS_COMPILER_CONTRACT_VERSION: "kadmos.compiler.k02.v1"` exported by compiler/index and stamped in all four generated headers; existing projection object keys stay `portsDts`/`worldCheckerTs` and `portsPy`/`worldCheckerPy`.

- [x] **Step 1: Write RED projection matrix.** For YAML and direct Worlds, test (a) one initial state with explicit `context: {}`, `invariants: []`, `transitions: []`, (b) one null or omitted directive with no named directives, (c) mixed null and `SEND`. Separately omit context, invariants, or transitions and assert `INVALID_WORLD` before any emitted output. Compile emitted TS with the existing strict NodeNext `tsc` invocation in `tests/test_world_semantics_conformance.test.ts`; exercise empty invariant **and transition** loops. Import `ports.py` and `world_checker.py` under the available Python, and assert `WorldDirective` resolves to `None` for no names. Assert no synthetic invariant was emitted and `new WorldChecker().step({transitionId:"UNKNOWN"})` yields `INVALID_TRANSITION` for nonterminal initial state. Assert version markers match the exported constant.
- [x] **Step 2: Run RED.** `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_harness_world_compiler.test.js dist/tests/test_python_compiler.test.js dist/tests/test_world_semantics_conformance.test.js`. Expect strict TS `never` to fail before the fix. Python `WorldDirective = None` already works for explicit-null/no-transition Worlds; keep that case as a passing compatibility probe. Task 1 fixes the omitted-directive Python failure.
- [x] **Step 3: Repair projections.** In emitted TS, assign `world.invariants` to a typed readonly `{id: string; predicate: string}[]` view before the check loop and widen any `world.transitions` use whose empty literal infers `never`; retain the actual empty arrays. In Python, ensure `literal([])` is used without a `Literal[...]` wrapper and yields `None` for `WorldDirective`. Define `KADMOS_COMPILER_CONTRACT_VERSION = "kadmos.compiler.k02.v1"` in `src/world_admission.ts`; re-export it from compiler/index and stamp it as a comment in TS `ports.d.ts`/checker and Python `ports.py`/checker. Do not alter package version, dependencies, or grammar.
- [x] **Step 4: Run GREEN.** Repeat the focused command and `pnpm run typecheck`; use Python 3.10–3.13 explicitly in CI, and locally report only interpreters actually present.
- [x] **Step 5: Commit.** `git add src/world_admission.ts src/world_compiler.ts src/python_compiler.ts src/index.ts tests/test_harness_world_compiler.test.ts tests/test_python_compiler.test.ts tests/test_world_semantics_conformance.test.ts && git commit -m "fix: project empty Worlds and pin compiler contract"`.

### Task 3: One-step rollback across checkers

**Files:** Modify `src/types/ports.ts`, `src/world_checker.ts`, `src/world_compiler.ts`, `src/python_compiler.ts`, `examples/job-queue-benchmark/python_worker.py`; regenerate `examples/job-queue-benchmark/spec/{ports.d.ts,world_checker.ts,ports.py,world_checker.py}` from `conformance/fixtures/job_lifecycle.world.yaml`; test `tests/test_world_semantics_conformance.test.ts`, `tests/test_python_compiler.test.ts`, `tests/test_job_queue_fabric_workers.test.ts`.

**Interfaces:** Source and emitted TS `IWorldChecker.reset(initialContext?: Partial<WorldContext> | null): void` and `rollbackLastStep(): void`; interpreted `createWorldChecker(world: WorldSpecInput, initialContext?: Partial<WorldContext> | null)`; emitted TS `new WorldChecker(initialContext?: Partial<WorldContext> | null)`. Emitted Python `WorldChecker(initial_context: dict[str, int | str] | None = None)`, `IWorldChecker.reset(initial_context: dict[str, int | str] | None = None) -> None`, and `rollback_last_step() -> None`. Stable exception prefixes are `INVALID_BOUNDS`, `INITIAL_INVARIANT_FAILED`, `NO_CHECKER_SAVEPOINT`, and `REENTRANCY_DETECTED`; each Python error uses its existing `ValueError`/`RuntimeError` class. `step`, TS getters, Python getters and aliases remain compatible.

- [x] **Step 1: Write RED constructor/reset/savepoint tests.** On each path, construct from a World whose `n` default is 0 with `{n: 2}`; check context 2, step to `n=3`, explicit `reset({n: 4})` yields 4, `reset({})` yields World default 0, then bare `reset()` and explicit `reset(null)`/Python `reset(None)` each yield 2 and no savepoint. Confirm explicit reset does not redefine the remembered seed. Test constructor omitted/null defaults, malformed top-level bool/number/string/array, wrong field types, bounds, and initial invariant on all three paths: malformed non-null shapes raise `INVALID_BOUNDS` before enumeration; initial invariant uses `INITIAL_INVARIANT_FAILED`. Direct TS probes additionally reject Date, Proxy, and accessor records before enumeration; Python direct probes reject dict subclasses and accept only exact dict/None. After success, malformed reset preserves current state/context/history and prior savepoint. Then test rollback before success (error), `step A` success, rejected `step X`, failed `reset` (error), rollback restoring pre-A state/context/history, and second rollback error. Run `step A; step B; rollback` and assert only B is undone. Make one fixture produce accepted payload/history; mutate original request and returned trace, reject another step, and assert accepted prefix unchanged. Reentrant evaluation must not leak/consume a savepoint; busy rollback raises `NO_CHECKER_SAVEPOINT` while retaining the savepoint for a later call. For Python, assert public `state`/`context`/`history` reads still work, direct writes raise `AttributeError`, mutations of returned context/history copies do nothing, and rollback restores the exact pre-success triple. Keep hostile rejection tests but replace direct live-field mutation expectations. Run the benchmark worker's physical-failure path with the new rollback call.
- [x] **Step 2: Run RED.** `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_world_semantics_conformance.test.js dist/tests/test_python_compiler.test.js`. Interpreted TS and emitted Python currently lack public methods, and both emitted port contracts lack declarations.
- [x] **Step 3: Implement interpreted TS constructor seed, reset, and savepoint.** Validate the optional constructor context before enumeration: null/undefined selects World defaults; a plain data-only object overlays defaults; every malformed non-null shape raises `INVALID_BOUNDS`. Validate the resolved candidate against bounds and initial invariants, then store a private owned seed. In `reset(initialContext?: Partial<WorldContext> | null)`, null/undefined restores that seed, while an explicit object overlays World defaults without changing the seed. On success publish state/context/empty history and clear `undo`; on failure restore the previous triple and keep `undo`. Add closure-private `undo: {state: WorldState; context: Record<string, number | string>; history: StepRecord[]} | null = null`. After all step checks pass and before publishing candidate state/context/history, replace `undo` with deep copied pre-step values. Preserve it on every rejection/exception. `rollbackLastStep` checks `busy || undo === null` first, throws `Error("NO_CHECKER_SAVEPOINT")`, then restores copies and consumes it. Add method and nullable reset to source `IWorldChecker`.

  ```ts
  // Only after reset validation succeeds:
  state = initial;
  context = candidateContext;
  history = [];
  undo = null;
  // Only after guard, effects, bounds, and invariants succeed:
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
- [x] **Step 4: Align emitted TS.** Declare the existing rollback method and nullable reset on generated `IWorldChecker`; add `constructor(initialContext?: Partial<WorldContext> | null)` to the emitted class. Resolve and copy the constructor seed after strict shape/value/invariant checks. Bare/null reset restores it, explicit object reset overlays World defaults without redefining it. Review snapshot and publication ordering in `src/world_compiler.ts`; ensure rejected/exception paths do not alter `#undo`, success replaces it, successful reset clears it, and saved history uses structured copies. Do not edit generated output directly.
- [x] **Step 5: Implement emitted Python and migrate the worker.** Add `rollback_last_step` to the generated Protocol and checker. Store backing state/context/history, resolved constructor seed, and deep copied pre-success triple in double-underscore attributes; expose read-only `state`, `context`, `history` properties, with context/history returning `copy.deepcopy`. Keep `_busy` for the existing reentrancy probe. `reset(None)` restores the resolved constructor seed, explicit exact-dict reset overlays World defaults without changing the seed, and only successful reset clears `__undo`. Refusal/exception/failed reset leaves it. Check `_busy` and missing savepoint before restore; raise `RuntimeError("NO_CHECKER_SAVEPOINT")`. Replace the three `checker.state/context/history = ...` assignments in `examples/job-queue-benchmark/python_worker.py` after its accepted physical failure with one `checker.rollback_last_step()`; preserve its Redis compensation and original-error propagation. Update `tests/test_python_compiler.test.ts` hostile probes that currently mutate live public fields to assert writes are blocked and reads are copies; retain request rejection/exception rollback coverage. Build, then regenerate the worker's checked-in seam only through `node bin/kadmos.js compile conformance/fixtures/job_lifecycle.world.yaml --out examples/job-queue-benchmark/spec --lang all`; inspect the four generated diffs. Preserve exact primitive tests (`type(value) is int`, etc.), deep copied history, and Python 3.10 syntax. Do not claim Python introspection-proof isolation.
- [x] **Step 6: Run GREEN and commit.** Repeat focused tests, `node --test dist/tests/test_job_queue_fabric_workers.test.js`, `pnpm run typecheck`, and relevant adapter tests from `pnpm run verify`; then `git add src/types/ports.ts src/world_checker.ts src/world_compiler.ts src/python_compiler.ts examples/job-queue-benchmark/python_worker.py examples/job-queue-benchmark/spec/ports.d.ts examples/job-queue-benchmark/spec/world_checker.ts examples/job-queue-benchmark/spec/ports.py examples/job-queue-benchmark/spec/world_checker.py tests/test_world_semantics_conformance.test.ts tests/test_python_compiler.test.ts tests/test_job_queue_fabric_workers.test.ts && git commit -m "fix: align constructor reset and one-step rollback"`.

### Task 4: Independent three-path expected outcomes

**Files:** Create `tests/world_three_path_runner.ts`; modify `tests/test_world_semantics_conformance.test.ts`; modify `src/fuzzer.ts`/`tests/test_fuzzer.test.ts` only if the focused comparison exposes a reusable gap.

**Interfaces:** The test-only runner has exact shapes below. `initialContext` is an optional **third** argument; its own absence and an explicit null both select World defaults. `Command.context` own absence invokes bare reset, own null invokes explicit nullable reset, and own non-null value passes through unchanged. Python runner consumes JSON commands over stdin and emits JSON observations; TS runner invokes compiled classes directly. Unsupported JS-only inputs such as Proxy/accessor are separate direct API probes, not serialized as fake JSON. Exception normalization uses only stable prefixes, not language class names.

```ts
type Command =
  | { kind: "step"; request: unknown }
  | { kind: "reset"; context?: unknown }
  | { kind: "rollback" }
  | { kind: "getState" }
  | { kind: "getContext" };
type NormalizedRecord = {
  step: number; state: string; action: string;
  eventPayload?: Readonly<Record<string, unknown>>;
  proposedDirective?: string | null;
};
type NormalizedViolation = {
  code: string; message: string; violatedInvariant?: string;
  shortestCounterexampleTrace: readonly NormalizedRecord[];
};
type NormalizedVerdict = {
  allowed: boolean; previousState: string; currentState: string;
  context: Readonly<Record<string, number | string>>;
  directiveAllowed: string | null; violation?: NormalizedViolation;
};
type Observed = {
  kind: Command["kind"]; state: string;
  context: Readonly<Record<string, number | string>>;
  verdict?: NormalizedVerdict; errorCode?: string;
};
type PathOutcome = { constructionError?: string; observations: readonly Observed[] };
type ThreePathOutcome = { interpreted: PathOutcome; emittedTs: PathOutcome; emittedPy: PathOutcome };
function runThreePaths(
  world: WorldSpecInput, commands: readonly Command[],
  initialContext?: unknown,
): Promise<ThreePathOutcome>;
```

- [x] **Step 1: Add the runner with strict compilation/import gates.** Reuse the temporary emitted TS/Python setup in the current conformance test. Before constructing each checker, distinguish absent `initialContext` from explicit null; pass null directly to all three APIs when present. Record a recognized constructor failure as `{constructionError, observations: []}` for each path and omit `constructionError` entirely on success. Each command captures post-command state/context and either the full normalized verdict or normalized error; omit absent optional fields rather than populating them with undefined. Use `Object.hasOwn(command, "context")` to choose `reset()` versus `reset(command.context)` in TS and `reset()` versus `reset(command["context"])` in Python; explicit null must be exercised directly and succeed. Preserve trace order and own presence of optional directive/payload keys in JSON; normalize Python `None` to JSON null. Reject or explicitly test unsupported JSON values before serialization. Throw on unknown error prefix so the runner cannot hide a new failure.

  ```ts
  const stableErrors = /^(INVALID_BOUNDS|INITIAL_INVARIANT_FAILED|NO_CHECKER_SAVEPOINT|REENTRANCY_DETECTED)(?::|$)/;
  function errorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const match = stableErrors.exec(message);
    if (!match) throw error;
    return match[1]!;
  }
  ```
- [x] **Step 2: Replace stale defect assertions with expected sequences.** In `tests/test_world_semantics_conformance.test.ts`, remove `expectedCompileError` and `expectedFailure` branches and the `public_rollback:false` expectation. Use literal expected observations for omitted/explicit-null/nonempty-string directives, ordered effects, guard/bounds/invariant refusal stages, correct/wrong/no directive, accepted-history-plus-attempt, reset/rollback lifecycle, and explicit empty model. For a loop World with `n` default 0 and `INC` effect `n = n + 1`, call `runThreePaths(world, commands, {n: 2})`: assert initial `n=2`, step `INC` gives 3, `reset({n:4})` gives 4, `reset({})` gives 0, bare reset gives 2, `reset(null)` gives 2, and rollback after each successful reset gives `NO_CHECKER_SAVEPOINT`. In a second sequence, after success, failed `reset({n:"bad"})` leaves `n=3` and rollback restores 2; array/bool/number/string top-level reset also returns `INVALID_BOUNDS`. Constructor array/bool/number/string yields `constructionError:"INVALID_BOUNDS"` and no observations on all three paths. Assert each path equals a separately authored literal expected `PathOutcome`, never another path. Add `true` versus integer `1` for Python integer reset/effect stage. Literal refusal expectations include violation code, exact message, optional invariant presence, every trace record in order, and own presence/absence of directive and payload; compare whole objects, not selected fields.

  ```ts
  const commands: Command[] = [
    { kind: "step", request: { transitionId: "INC" } },
    { kind: "reset", context: { n: 4 } },
    { kind: "reset", context: {} },
    { kind: "reset" },
    { kind: "reset", context: null },
    { kind: "rollback" },
  ];
  const world: WorldSpecInput = {
    version: "kadmos.world.v0", name: "ResetSeedProbe",
    states: [{ id: "START", initial: true }],
    context: { n: { type: "integer", default: 0 } }, invariants: [],
    transitions: [{ id: "INC", from: "START", to: "START", guard: true,
      directive: null, effects: ["n = n + 1"] }],
  };
  const expected: PathOutcome = { observations: [
    { kind: "step", state: "START", context: { n: 3 }, verdict: {
      allowed: true, previousState: "START", currentState: "START",
      context: { n: 3 }, directiveAllowed: null,
    } },
    { kind: "reset", state: "START", context: { n: 4 } },
    { kind: "reset", state: "START", context: { n: 0 } },
    { kind: "reset", state: "START", context: { n: 2 } },
    { kind: "reset", state: "START", context: { n: 2 } },
    { kind: "rollback", state: "START", context: { n: 2 }, errorCode: "NO_CHECKER_SAVEPOINT" },
  ] };
  for (const path of Object.values(await runThreePaths(world, commands, { n: 2 }))) {
    assert.deepEqual(path, expected);
  }
  const sendWorld: WorldSpecInput = {
    version: "kadmos.world.v0", name: "DirectiveProbe",
    states: [{ id: "START", initial: true }, { id: "DONE" }],
    context: { n: { type: "integer", default: 2 } }, invariants: [],
    transitions: [{ id: "SEND", from: "START", to: "DONE", guard: true,
      directive: "SEND", effects: [] }],
  };
  const wrongDirective: Observed = {
    kind: "step", state: "START", context: { n: 2 },
    verdict: {
      allowed: false, previousState: "START", currentState: "START",
      context: { n: 2 }, directiveAllowed: null,
      violation: {
        code: "UNAUTHORIZED_DIRECTIVE", message: "Directive does not match declared transition",
        shortestCounterexampleTrace: [
          { step: 1, state: "START", action: "SEND", proposedDirective: "WRONG",
            eventPayload: { id: 7 } },
        ],
      },
    },
  };
  const wrong = await runThreePaths(sendWorld, [
    { kind: "step", request: { transitionId: "SEND", proposedDirective: "WRONG",
      eventPayload: { id: 7 } } },
  ]);
  for (const path of Object.values(wrong)) assert.deepEqual(path, { observations: [wrongDirective] });
  ```
- [x] **Step 3: Run RED/GREEN deliberately.** Run `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build && node --test dist/tests/test_world_semantics_conformance.test.js`. First capture any failing case as a real mismatch; fix only this spec's admission/rollback contract in the owning earlier task. Rerun until all three paths match the independent expected sequences. Run `node bin/kadmos.js test conformance/fixtures/order_settlement.world.yaml --runs 30 --seed 20261008`. Preserve existing `FuzzOptions`, `FuzzReport`, CLI flags, seeded reproducibility and report shape; do not silently redefine random traces as proof.
- [x] **Step 4: Commit.** `git add tests/world_three_path_runner.ts tests/test_world_semantics_conformance.test.ts` plus `src/fuzzer.ts tests/test_fuzzer.test.ts` only if actually changed, then `git commit -m "test: pin three-path checker outcomes"`.

### Task 5: Documentation, regeneration, packaging, and final evidence

**Files:** Modify `docs/world-semantics-v0.md`, `README.md`, `skills/kadmos/SKILL.md`; modify `tests/test_public_fabric_example.test.ts` if adding the displayed Python failure example; regenerate checked-in projection files only by CLI; create `docs/verification/2026-10-08-generator-admission-and-rollback.md`.

**Interfaces:** Public docs describe `kadmos.compiler.k02.v1`, canonical directive admission, explicit empty collections, nullable constructor/reset seed semantics, Python read-only public views, all three rollback APIs, physical-failure sequence and empirical conformance limits. Projection generation uses `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run build` then `node bin/kadmos.js compile <world-file> --out <projection-directory> --lang all`, with paths matched to each example/scaffold.

- [x] **Step 1: Update documentation from passing behavior.** Remove the three now-stale known-defect items from `docs/world-semantics-v0.md`; state omitted/YAML-empty/null directive normalization, empty-string rejection, explicit empty collections, constructor seed/reset null semantics, no invariant tautology, savepoint lifecycle, Python read-only public views and introspection limit, Python rollback method, and checker-only physical limits. Update README and copied skill consistently. If adding a Python physical-failure snippet, have `tests/test_public_fabric_example.test.ts` extract and execute that exact fence against emitted Python with a failed callback, rollback, propagated original error, and subsequent accepted step; otherwise state the Python usage in prose without an untested runnable fence.
- [x] **Step 2: Regenerate remaining projections.** Task 3 already regenerates `examples/job-queue-benchmark/spec` so its worker test can pass. Inventory `rg --files examples src/adapters | rg '(ports\.(d\.ts|py)|world_checker\.(ts|py)|world\.yaml)$'`. For each other checked-in projection whose generating World is present, run the documented `kadmos compile` command using the compiler, then compare generated files with `git diff`; no hand edits. Leave unrelated fixtures alone. Run adapter/worker tests after regeneration.
- [x] **Step 3: Run local acceptance.** With frozen dependencies and needed loopback/network escalation, run `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run verify`, `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm run test:fuzz` with seed recorded, `PATH=/private/tmp/kadmos-pnpm-bin:$PATH pnpm pack --dry-run`, `git diff --check`, and `git status --short`. `verify` includes the packed clean-consumer starter/MCP test and BullMQ tests. Run strict emitted TS/Python import probes separately for the edge Worlds; list locally available Python versions, and leave missing 3.10–3.13 checks to the required CI matrix.
- [x] **Step 4: Record precise evidence and pin.** In the verification document record actual execution dates, commands, exits, test counts, seed/trace count, pack inventory, platform versions, compiler contract marker, manifest version, generated projection paths, and exact implementation commit SHA after the code commit. The `kadmos.compiler.k02.v1` marker is a human-readable contract identifier, not an immutable source pin. State that CI 24-job and physical Grok final review remain pending until the coordinator executes them. Harmonia's later pin is the final reviewed/integrated immutable source SHA, to be updated by the coordinator after review; never invent it in advance.
- [x] **Step 5: Commit and hand off.** `git add` only scoped docs/tests/CLI-regenerated files; `git commit -m "docs: record generator contract and verification"`; inspect `git status --short --branch` and `git log -1 --oneline`. Send the coordinator branch, base, commits, exact local evidence and pending 24-job/final-review gates. Do not push or open a public PR.

## Self-review before execution

- [x] Confirm all spec sections map to Tasks 1–5 and every Review Focus item has an owning regression.
- [x] Check the exact method names: `rollbackLastStep` in both TS paths, `rollback_last_step` in Python; no alias substituted.
- [x] Check admission import graph: `world_admission.ts` has no compiler import; both generators and checker import it; compiler re-export is compatibility only.
- [x] Scan for incomplete instructions (`TBD`, `TODO`, vague test/implementation steps) and resolve them before preflight.
- [x] Confirm no step mutates generated seams manually or claims finite tests prove bisimulation.
