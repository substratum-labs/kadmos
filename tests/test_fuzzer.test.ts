import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runDifferentialFuzzing } from "../src/fuzzer.js";
import { parseWorldSpec } from "../src/world_compiler.js";
import type { StepVerdict, TransitionStepRequest } from "../src/types/ports.js";

const file = new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url);
const world = parseWorldSpec(readFileSync(file, "utf8"));

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
