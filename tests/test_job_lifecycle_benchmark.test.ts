import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileWorldSpec, parseWorldSpec } from "../src/world_compiler.js";
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
  assert.equal(spec.transitions.length, 9);
  assert.deepEqual(spec.invariants.map((invariant) => invariant.id), ["INV-01-RETRY-BOUND", "INV-02-LOCK-TOKEN-CONSISTENCY", "INV-03-NON-NEGATIVE-RETRIES"]);
  const compiled = compileWorldSpec(spec);
  assert.match(compiled.portsDts, /export type WorldState/);
  assert.match(compiled.worldCheckerTs, /REPORT_RETRYABLE_FAILURE/);
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
  const gate = createWorldChecker(spec, { lock_epoch: 1 }); // Supervisor snapshot after Worker A lease expiry.
  assert.equal(step(gate, "ACQUIRE_LOCK", "worker_B").allowed, true);
  assert.equal(gate.getContext().lock_epoch, 2);
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
  const report = await runDifferentialFuzzing(spec, { runs: 10, stepsPerRun: 25, seed: 42 });
  assert.equal(report.passed, true);
  assert.equal(report.divergences.length, 0);
});
