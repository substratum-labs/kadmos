import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { inferBoundary } from "../src/boundary_inference.js";
import { applyLegislationPatch, synthesizeDilemmas, type LegislativeDilemma } from "../src/dilemma_synthesis.js";
import { runLegislationWizard } from "../src/tui/wizard.js";
import { parseWorldSpec } from "../src/world_compiler.js";

const base = inferBoundary("Order status CREATED to PAYMENT_PENDING. Payment capture and cancel may race after timeout; retry refund webhook. Escrow balance and order amount.").worldSpec;
const dilemma: LegislativeDilemma = {
  id: "DIL-TEST", title: "Test decision", worstCaseTrace: ["First", "Second"],
  optionA: { description: "World law", patch: { states: [{ id: "ARBITRATION" }] } },
  optionB: { description: "Fabric policy", fabricGuidance: "Deduplicate in Fabric." },
};

test("patch adds all four World entity kinds immutably and deduplicates repeat application", () => {
  const patch = {
    states: [{ id: "ARBITRATION" }],
    context: { settlement_nonce: { type: "integer" as const, min: 0, max: 1, default: 0 } },
    invariants: [{ id: "INV-NONCE", predicate: "settlement_nonce >= 0" }],
    transitions: [{ id: "ENTER_ARBITRATION", from: "PAYMENT_PENDING", to: "ARBITRATION", guard: true, effects: [] }],
  };
  const result = applyLegislationPatch(base, patch);
  assert.equal(base.states.some((state) => state.id === "ARBITRATION"), false);
  assert.equal(result.states.some((state) => state.id === "ARBITRATION"), true);
  assert.equal(result.context.settlement_nonce?.max, 1);
  assert.equal(result.invariants.some((item) => item.id === "INV-NONCE"), true);
  assert.equal(result.transitions.some((item) => item.id === "ENTER_ARBITRATION"), true);
  assert.deepEqual(applyLegislationPatch(result, patch), result);
});

test("patch rejects illegal transition and inverted range without changing source", () => {
  assert.throws(() => applyLegislationPatch(base, { transitions: [{ id: "BAD", from: "GHOST", to: "CREATED", guard: true }] }), /UNDECLARED_STATE/);
  assert.throws(() => applyLegislationPatch(base, { context: { impossible: { type: "integer", min: 3, max: 2 } } }), /INVALID_BOUNDS/);
  assert.equal(Object.hasOwn(base.context, "impossible"), false);
});

test("patch preserves state descriptions and rejects weakened bounds", () => {
  const described = { ...base, states: base.states.map((state) => ({ ...state, description: `State ${state.id}` })) };
  const result = applyLegislationPatch(described, { states: [{ id: "ARBITRATION" }] });
  assert.equal(result.states.find((state) => state.id === "CREATED")?.description, "State CREATED");
  assert.throws(() => applyLegislationPatch(base, { context: { escrow_balance: { type: "integer", min: -1 } } }), /CONFLICTING_BOUNDS/);
  assert.deepEqual(applyLegislationPatch(base, {}), base);
});

test("synthesized A patches remain valid when all are applied in order", () => {
  const dilemmas = synthesizeDilemmas({ inputContent: "cancel payment timeout RPC retry refund webhook", worldSpec: base, worldYaml: "", portsDts: "", worldCandidates: [], fabricCandidates: [] });
  assert.equal(dilemmas.length, 3);
  let world = base;
  for (const item of dilemmas) world = applyLegislationPatch(world, item.optionA.patch);
  assert.ok(world.states.length > base.states.length);
});

test("headless wizard applies all A patches or preserves World for all B", async () => {
  const a = await runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], acceptAllA: true, nonInteractive: true });
  assert.equal(a.worldSpec.states.some((state) => state.id === "ARBITRATION"), true);
  assert.deepEqual(a.decisions, [{ dilemmaId: "DIL-TEST", choice: "A" }]);
  const b = await runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], acceptAllB: true, nonInteractive: true });
  assert.equal(b.worldSpec, base);
  assert.deepEqual(b.decisions, [{ dilemmaId: "DIL-TEST", choice: "B" }]);
  await assert.rejects(runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], nonInteractive: true }), /Cannot prompt for legislative choices in non-interactive mode/);
  await assert.rejects(runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], input: new PassThrough() }), /Cannot prompt for legislative choices in non-interactive mode/);
  assert.deepEqual(await runLegislationWizard({ worldSpec: base, dilemmas: [], nonInteractive: true }), { worldSpec: base, decisions: [] });
});

test("TTY arrows, number keys, and Enter select choices and restore raw mode", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: true; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  const pending = runLegislationWizard({ worldSpec: base, dilemmas: [dilemma, { ...dilemma, id: "DIL-TEST-2" }], input, output });
  input.write("\u001b[B\r1\r");
  const result = await pending;
  assert.deepEqual(result.decisions, [{ dilemmaId: "DIL-TEST", choice: "B" }, { dilemmaId: "DIL-TEST-2", choice: "A" }]);
  assert.equal(result.worldSpec.states.some((state) => state.id === "ARBITRATION"), true);
  assert.equal(input.isRaw, false);
});

test("TTY q aborts without partial result and restores raw mode", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: true; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  const pending = runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], input, output: new PassThrough() });
  input.write("q");
  await assert.rejects(pending, /abort/i);
  assert.equal(input.isRaw, false);
});

test("TTY Ctrl+C aborts and removes wizard listeners", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: true; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  const pending = runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], input, output: new PassThrough() });
  input.write("\u0003");
  await assert.rejects(pending, /abort/i);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(input.listenerCount("data"), 0);
});

test("CLI accept-all-a atomically writes a parseable updated YAML file", () => {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-legislation-"));
  try {
    const input = join(directory, "requirements.txt");
    const out = join(directory, "world.spec.yaml");
    writeFileSync(input, "Order status CREATED to PAYMENT_PENDING. Payment capture and cancel may race after timeout; retry refund webhook. Escrow balance and order amount.");
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin", "kadmos.js"), "legislate", input, "--accept-all-a", "--out", out], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const world = parseWorldSpec(readFileSync(out, "utf8"));
    assert.ok(world.states.some((state) => state.id === "ARBITRATION"));
    assert.deepEqual(readdirSync(directory).sort(), ["requirements.txt", "world.spec.yaml"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
