import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileWorldSpec, compileWorldSpecPython, parseWorldSpec } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";
import { runDifferentialFuzzing } from "../src/fuzzer.js";

const fixture = join(process.cwd(), "conformance/fixtures/job_lifecycle.world.yaml");
const source = readFileSync(fixture, "utf8");
const spec = parseWorldSpec(source);
const step = (gate: ReturnType<typeof createWorldChecker>, transitionId: string, token?: string, reason?: string) => {
  const transition = spec.transitions.find((item) => item.id === transitionId)!;
  return gate.step({ transitionId, proposedDirective: transition.directive, eventPayload: { token, reason, result_digest: "digest" } });
};

test("JobWorld parses and compiles the complete six-state contract", () => {
  assert.deepEqual(spec.states.map((state) => state.id), ["WAITING", "ACTIVE", "DELAYED_RETRY", "COMPLETED", "FAILED", "REVOKED"]);
  assert.deepEqual(spec.states.filter((state) => state.terminal).map((state) => state.id), ["COMPLETED", "FAILED", "REVOKED"]);
  assert.equal(spec.transitions.length, 10);
  assert.deepEqual(spec.invariants.map((invariant) => invariant.id), ["INV-01-RETRY-BOUND", "INV-02-LOCK-TOKEN-CONSISTENCY", "INV-03-TERMINAL-LOCK-EMPTY", "INV-04-NON-NEGATIVE-RETRIES"]);
  const compiled = compileWorldSpec(spec);
  assert.match(compiled.portsDts, /export type WorldState/);
  assert.match(compiled.worldCheckerTs, /REPORT_RETRYABLE_FAILURE/);
  assert.match(compiled.worldCheckerTs, /Transition \'\$\{snapshotAction\}\' is not legal from state \'\$\{snapshotState\}\'/);
  for (const message of ["Invalid effect assignment target", "Effect expression has wrong type", "Effect evaluation failed"]) assert.ok(compiled.worldCheckerTs.includes(message));
});

test("compiled TS, runtime, and Python use identical guard, bound, and invariant errors", () => {
  const cases = [
    { kind: "guard", code: "GUARD_FAILED", message: "Guard expression evaluation failed" },
    { kind: "bound", code: "INVALID_BOUNDS", message: "Context bound failed on 'lock_epoch'" },
    { kind: "invariant", code: "INVARIANT_FAILED", message: "Invariant violation: 'INV-PARITY'" },
  ] as const;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "kadmos-parity-"));
  try {
    for (const { kind, code, message } of cases) {
      const modified = structuredClone(spec);
      const transition = modified.transitions.find((item) => item.id === "ACQUIRE_LOCK")!;
      if (kind === "guard") (transition as { guard: string | boolean }).guard = "request.token * 3 > 0";
      if (kind === "bound") (modified.context.lock_epoch as { max?: number }).max = 0;
      if (kind === "invariant") (modified.invariants as { id: string; predicate: string }[]).push({ id: "INV-PARITY", predicate: "state != 'ACTIVE'" });
      const request = { transitionId: "ACQUIRE_LOCK", proposedDirective: "DISPATCH_PAYLOAD", eventPayload: { token: "worker-a" } };
      const runtime = createWorldChecker(modified).step(request);
      assert.equal(runtime.violation?.code, code);
      assert.equal(runtime.violation?.message, message);
      const projection = compileWorldSpec(modified);
      const generated = projection.worldCheckerTs;
      assert.ok(generated.includes(kind === "guard" ? `"${message}"` : kind === "bound" ? "Context bound failed on '${boundError}'" : "Invariant violation: '${violatedInv}'"));
      writeFileSync(join(dir, "ports.d.ts"), projection.portsDts);
      writeFileSync(join(dir, "world_checker.ts"), generated);
      const compile = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "--ignoreConfig", "--target", "es2022", "--module", "commonjs", "--types", "node", "--typeRoots", join(process.cwd(), "node_modules/@types"), "--outDir", join(dir, "js"), join(dir, "world_checker.ts")], { encoding: "utf8" });
      assert.equal(compile.status, 0, compile.stderr || compile.stdout);
      const tsRun = spawnSync(process.execPath, ["-e", "const {WorldChecker}=require('./js/world_checker.js'); console.log(JSON.stringify(new WorldChecker().step(JSON.parse(process.argv[1]))))", JSON.stringify(request)], { cwd: dir, encoding: "utf8" });
      assert.equal(tsRun.status, 0, tsRun.stderr);
      const tsVerdict = JSON.parse(tsRun.stdout) as { violation: { code: string; message: string } };
      assert.deepEqual({ code: tsVerdict.violation.code, message: tsVerdict.violation.message }, { code, message });
      const python = compileWorldSpecPython(modified);
      writeFileSync(join(dir, "ports.py"), python.portsPy);
      writeFileSync(join(dir, "world_checker.py"), python.worldCheckerPy);
      const run = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "-c", "import json,sys; from world_checker import WorldChecker; print(json.dumps(WorldChecker().step(json.load(sys.stdin))))"], { cwd: dir, input: JSON.stringify(request), encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const verdict = JSON.parse(run.stdout) as { violation: { code: string; message: string } };
      assert.deepEqual({ code: verdict.violation.code, message: verdict.violation.message }, { code, message });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("kadmos graph emits Mermaid with states and directives", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "graph", fixture, "--format", "mermaid"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^stateDiagram-v2/);
  for (const state of spec.states) assert.match(result.stdout, new RegExp(`\\b${state.id}\\b`));
  for (const directive of new Set(spec.transitions.map((transition) => transition.directive))) assert.match(result.stdout, new RegExp(directive!));
});

test("kadmos compile --lang all emits TypeScript and Python projections", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "kadmos-jobworld-"));
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", fixture, "--out", join(dir, "generated"), "--lang", "all"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(dir, "generated")).sort(), ["ports.d.ts", "ports.py", "world_checker.py", "world_checker.ts"]);
    for (const file of readdirSync(join(dir, "generated"))) assert.ok(readFileSync(join(dir, "generated", file), "utf8").length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("zombie Worker A cannot settle when Worker B owns the current token", () => {
  const gate = createWorldChecker(spec);
  assert.equal(step(gate, "ACQUIRE_LOCK", "worker_A").allowed, true);
  const recovered = gate.step({ transitionId: "RECOVER_STALE_LEASE", proposedDirective: "EVICT_STALE_WORKER", eventPayload: { supervisor_token: "supervisor-token" } });
  assert.equal(recovered.allowed, true);
  assert.equal(recovered.currentState, "WAITING");
  assert.equal(step(gate, "ACQUIRE_LOCK", "worker_B").allowed, true);
  assert.equal(gate.getContext().lock_epoch, 3);
  const before = gate.getContext();
  const stale = step(gate, "REPORT_SUCCESS", "worker_A");
  assert.equal(stale.allowed, false);
  assert.equal(stale.violation?.code, "GUARD_FAILED");
  assert.equal(stale.directiveAllowed, null);
  assert.deepEqual(gate.getContext(), before);
  assert.equal(gate.getState(), "ACTIVE");
  assert.equal(step(gate, "REPORT_SUCCESS", "worker_B").currentState, "COMPLETED");
});

test("retry bound rejects another retry and routes exhausted work to dead letter", () => {
  const gate = createWorldChecker(spec);
  for (let retry = 1; retry <= 3; retry++) {
    assert.equal(step(gate, "ACQUIRE_LOCK", `worker_${retry}`).allowed, true);
    const verdict = step(gate, "REPORT_RETRYABLE_FAILURE", `worker_${retry}`, "503");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.context.retries, retry);
    assert.equal(verdict.directiveAllowed, "SCHEDULE_BACKOFF");
    assert.equal(step(gate, "RETRY_DELAY_ELAPSED").allowed, true);
  }
  assert.equal(step(gate, "ACQUIRE_LOCK", "worker_4").allowed, true);
  const rejected = step(gate, "REPORT_RETRYABLE_FAILURE", "worker_4", "503");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.violation?.code, "GUARD_FAILED");
  assert.equal(gate.getContext().retries, 3);
  assert.equal(gate.getState(), "ACTIVE");
  const exhausted = step(gate, "RETRY_EXHAUSTED", "worker_4", "503");
  assert.equal(exhausted.allowed, true);
  assert.equal(exhausted.currentState, "FAILED");
  assert.equal(exhausted.directiveAllowed, "TRIGGER_DEAD_LETTER_ALERT");
});

for (const terminal of ["COMPLETED", "FAILED", "REVOKED"] as const) {
  test(`${terminal} rejects every outgoing transition`, () => {
    const gate = createWorldChecker(spec);
    if (terminal === "COMPLETED") {
      step(gate, "ACQUIRE_LOCK", "worker");
      assert.equal(step(gate, "REPORT_SUCCESS", "worker").allowed, true);
    } else if (terminal === "FAILED") {
      step(gate, "ACQUIRE_LOCK", "worker");
      assert.equal(step(gate, "REPORT_FATAL_FAILURE", "worker", "fatal").allowed, true);
    } else assert.equal(step(gate, "CANCEL_FROM_WAITING").allowed, true);
    const before = gate.getContext();
    for (const transition of spec.transitions) {
      const verdict = step(gate, transition.id, "worker");
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.violation?.code, "ILLEGAL_TRANSITION");
      assert.equal(verdict.directiveAllowed, null);
      assert.equal(gate.getState(), terminal);
      assert.deepEqual(gate.getContext(), before);
    }
  });
}

test("JobWorld passes cross-language differential fuzzing with zero divergences", async () => {
  const report = await runDifferentialFuzzing(spec, { runs: 100, stepsPerRun: 40, seed: 105 });
  assert.equal(report.passed, true);
  assert.equal(report.divergences.length, 0);
  assert.equal(report.stateCoverage.ratio, 1, JSON.stringify(report.stateCoverage));
  assert.equal(report.transitionCoverage.ratio, 1, JSON.stringify(report.transitionCoverage));
});

test("ACTIVE requires a nonempty worker token or supervisor token for exits", () => {
  const gate = createWorldChecker(spec);
  assert.equal(step(gate, "ACQUIRE_LOCK", "").allowed, false);
  assert.equal(step(gate, "ACQUIRE_LOCK", "worker").allowed, true);
  const cancel = gate.step({ transitionId: "CANCEL_FROM_ACTIVE", proposedDirective: "NOTIFY_CANCELLATION", eventPayload: {} });
  assert.equal(cancel.allowed, false);
  const recover = gate.step({ transitionId: "RECOVER_STALE_LEASE", proposedDirective: "EVICT_STALE_WORKER", eventPayload: { supervisor_token: "" } });
  assert.equal(recover.allowed, false);
  assert.equal(gate.getState(), "ACTIVE");
});
