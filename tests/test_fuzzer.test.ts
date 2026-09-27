import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mulberry32, runDifferentialFuzzing } from "../src/fuzzer.js";
import { compileWorldSpecPython, parseWorldSpec } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";
import type { StepVerdict, TransitionStepRequest } from "../src/types/ports.js";

const file = new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url);
const world = parseWorldSpec(readFileSync(file, "utf8"));

test("seed high bits change the generated sequence", () => {
  const sequence = (seed: number) => Array.from({ length: 8 }, mulberry32(seed));
  assert.notDeepEqual(sequence(1), sequence(2 ** 32 + 1));
  assert.notEqual(mulberry32(0)(), mulberry32(2 ** 32 + 1)());
  assert.notEqual(mulberry32(1)(), mulberry32(2 ** 32 + 1)());
  for (const [left, right] of [
    [0x9e3779b9, 2 ** 32],
    [Math.imul(2, 0x9e3779b9) >>> 0, 2 * 2 ** 32],
    [0, 2 ** 32 + 1],
  ] as const) assert.notDeepEqual(sequence(left), sequence(right), `seeds ${left} and ${right} collided`);
});

test("Python and TypeScript reject reserved payload keys and invalid directives identically", () => {
  const requests = [
    { transitionId: "INITIATE_PAYMENT", eventPayload: { ["__proto__"]: 1 } },
    { transitionId: "INITIATE_PAYMENT", proposedDirective: 1 },
  ];
  const ts = requests.map((request) => createWorldChecker(world).step(request as TransitionStepRequest));
  const dir = mkdtempSync(join(tmpdir(), "kadmos-fuzz-parity-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    const py = spawnSync("python3", ["-B", "-c", "import json,sys; from world_checker import WorldChecker; print(json.dumps([WorldChecker().step(r) for r in json.load(sys.stdin)]))"], { cwd: dir, input: JSON.stringify(requests), encoding: "utf8" });
    assert.equal(py.status, 0, py.stderr);
    const verdicts = JSON.parse(py.stdout) as StepVerdict[];
    for (let i = 0; i < requests.length; i++) {
      assert.equal(verdicts[i]?.violation?.code, ts[i]?.violation?.code);
      assert.equal(verdicts[i]?.violation?.message, ts[i]?.violation?.message);
      assert.deepEqual(verdicts[i]?.violation?.shortestCounterexampleTrace, ts[i]?.violation?.shortestCounterexampleTrace);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oracle reports differences in violation messages and every trace field", async () => {
  const changes: Array<[string, (verdict: any) => void]> = [
    ["violation.message", (v) => { v.violation!.message = "mutated"; }],
    ["trace[0].step", (v) => { v.violation!.shortestCounterexampleTrace[0]!.step = 999; }],
    ["trace[0].state", (v) => { v.violation!.shortestCounterexampleTrace[0]!.state = "MUTANT"; }],
    ["trace[0].action", (v) => { v.violation!.shortestCounterexampleTrace[0]!.action = "MUTANT"; }],
    ["trace[0].proposedDirective", (v) => { v.violation!.shortestCounterexampleTrace[0]!.proposedDirective = "MUTANT"; }],
    ["trace[0].eventPayload", (v) => { v.violation!.shortestCounterexampleTrace[0]!.eventPayload = { mutated: true }; }],
  ];
  for (const [expected, mutate] of changes) {
    const report = await runDifferentialFuzzing(world, { runs: 1, stepsPerRun: 20, seed: 7,
      pythonRunner: async (_requests, verdicts) => {
        const copy = structuredClone(verdicts);
        const rejected = copy[0]?.find((verdict) => !verdict.allowed);
        assert.ok(rejected);
        mutate(rejected);
        return copy;
      },
    });
    assert.ok(report.divergences[0]);
    assert.ok(report.divergences[0].reason.startsWith(expected), report.divergences[0].reason);
  }
});

test("same seed yields exactly the same generated requests", async () => {
  const sequences: TransitionStepRequest[][][] = [];
  const capture = async (runs: TransitionStepRequest[][], verdicts: StepVerdict[][]) => {
    sequences.push(structuredClone(runs));
    return verdicts;
  };
  await runDifferentialFuzzing(world, { runs: 4, stepsPerRun: 12, seed: 12345, pythonRunner: capture });
  await runDifferentialFuzzing(world, { runs: 4, stepsPerRun: 12, seed: 12345, pythonRunner: capture });
  assert.deepEqual(sequences[0], sequences[1]);
  assert.equal(sequences[0]?.length, 4);
  assert.equal(sequences[0]?.[0]?.length, 12);
});

test("order settlement stays bisimilar across 30 seeded runs", async () => {
  const report = await runDifferentialFuzzing(world, { runs: 30, stepsPerRun: 20, seed: 12345 });
  assert.equal(report.passed, true, JSON.stringify(report.divergences.slice(0, 3), null, 2));
  assert.equal(report.totalSteps, 600);
  assert.deepEqual(report.divergences, []);
  assert.equal(report.stateCoverage.ratio, 1);
  assert.equal(report.transitionCoverage.ratio, 1);
});

test("mutated Python verdict reports the exact run, step, request and reason", async () => {
  const report = await runDifferentialFuzzing(world, {
    runs: 1, stepsPerRun: 2, seed: 7,
    pythonRunner: async (_runs, verdicts) => {
      const copy = structuredClone(verdicts);
      copy[0]![0] = { ...copy[0]![0]!, currentState: "MUTANT" };
      return copy;
    },
  });
  assert.equal(report.passed, false);
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0]?.run, 1);
  assert.equal(report.divergences[0]?.step, 1);
  assert.equal(report.divergences[0]?.pyVerdict?.currentState, "MUTANT");
  assert.ok(report.divergences[0]?.request);
  assert.match(report.divergences[0]?.reason ?? "", /currentState/);
});

test("CLI test prints coverage and exits successfully", () => {
  const result = spawnSync(process.execPath, ["bin/kadmos.js", "test", file.pathname, "--runs", "30", "--steps", "20", "--seed", "12345", "--coverage"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bisimulation Verdict: 100% EQUIVALENCE \(0 divergences\)/);
  assert.match(result.stdout, /States: 100% \(5\/5\)/);
  assert.match(result.stdout, /Transitions: 100% \(5\/5\)/);
});
