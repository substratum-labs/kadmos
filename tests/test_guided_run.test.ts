import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { inferBoundary, serializeWorldSpec } from "../src/boundary_inference.js";
import { MockDeterministicProvider } from "../src/agent/provider.js";
import { runKadmosAgent } from "../src/agent/runner.js";
import { parseWorldSpec } from "../src/world_compiler.js";

const ambiguousPrd = "Order status CREATED to PAYMENT_PENDING. Payment capture and cancel may race after timeout; retry refund webhook. Escrow balance and order amount.";

function fixture(content = ambiguousPrd) {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-guided-"));
  const prdPath = join(directory, "order.prd.txt");
  const outDir = join(directory, "evidence");
  writeFileSync(prdPath, content);
  return { directory, prdPath, outDir };
}

test("guided dry run without --world embeds the inferred and legislated World", async () => {
  const f = fixture();
  try {
    const prompt = await runCli(["run", "--prd", f.prdPath, "--provider", "mock", "--accept-all-a", "--dry-run", "--out", f.outDir]);
    const persisted = parseWorldSpec(readFileSync(join(f.outDir, "world.spec.yaml"), "utf8"));
    assert.match(prompt, /WORLD SPEC:/);
    assert.match(prompt, /order_prd/);
    assert.match(prompt, /ARBITRATION/);
    assert.match(prompt, /INV-REFUND-CONSERVATION/);
    assert.ok(persisted.states.some((state) => state.id === "ARBITRATION"));
    assert.equal(existsSync(join(f.outDir, "fabric.ts")), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("guided --accept-all-a adds the legislative state and invariant to a custom World output", async () => {
  const f = fixture();
  try {
    const worldOut = join(f.directory, "nested", "legislated.yaml");
    await runCli(["run", "--prd", f.prdPath, "--provider", "mock", "--accept-all-a", "--dry-run", "--world-out", worldOut]);
    const world = parseWorldSpec(readFileSync(worldOut, "utf8"));
    assert.ok(world.states.some((state) => state.id === "ARBITRATION"));
    assert.ok(world.invariants.some((rule) => rule.id === "INV-REFUND-CONSERVATION"));
    assert.ok(world.transitions.some((transition) => transition.id === "RECORD_UNCERTAIN_OUTCOME"));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("guided --accept-all-b preserves the inferred minimalist World", async () => {
  const f = fixture();
  try {
    await runCli(["run", "--prd", f.prdPath, "--provider", "mock", "--accept-all-b", "--dry-run", "--out", f.outDir]);
    const actual = parseWorldSpec(readFileSync(join(f.outDir, "world.spec.yaml"), "utf8"));
    const baseline = inferBoundary(ambiguousPrd, { name: "order.prd" }).worldSpec;
    assert.deepEqual(actual, baseline);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("guided run rejects unresolved choices in a non-interactive environment before writing YAML", async () => {
  const f = fixture();
  try {
    await assert.rejects(Promise.resolve().then(() => runCli(["run", "--prd", f.prdPath, "--provider", "mock", "--non-interactive", "--dry-run", "--out", f.outDir])), /Cannot prompt for legislative choices.*--accept-all-a or --accept-all-b/);
    assert.equal(existsSync(join(f.outDir, "world.spec.yaml")), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("runner accepts an in-memory World and writes the full evidence bundle plus YAML", async () => {
  const f = fixture("Order status CREATED to COMPLETED.");
  try {
    const inferred = inferBoundary(readFileSync(f.prdPath, "utf8"), { name: "GuidedOrder" }).worldSpec;
    const worldSpec = parseWorldSpec(serializeWorldSpec({
      ...inferred,
      states: inferred.states.map((state) => state.id === "COMPLETED" ? { ...state, terminal: true } : state),
    }));
    const steps = [{ transitionId: "MOVE_CREATED_TO_COMPLETED" }];
    const candidate = `\`\`\`json\n${JSON.stringify({ steps })}\n\`\`\`\n\`\`\`typescript\nimport type { IWorldChecker } from "./ports.js"; export class OrderService { constructor(private checker: IWorldChecker) {} run() { this.checker.step({ transitionId: "MOVE_CREATED_TO_COMPLETED" }); } }\n\`\`\``;
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpec, outDir: f.outDir, provider: new MockDeterministicProvider([candidate]) });
    assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
    for (const name of ["fabric.ts", "journey.json", "ports.d.ts", "evidence.json", "world.spec.yaml"]) assert.ok(existsSync(join(f.outDir, name)), name);
    assert.deepEqual(parseWorldSpec(readFileSync(join(f.outDir, "world.spec.yaml"), "utf8")), worldSpec);
    assert.equal(JSON.parse(readFileSync(join(f.outDir, "evidence.json"), "utf8")).finalState, "COMPLETED");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
