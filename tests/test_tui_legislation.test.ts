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
import { createWorldChecker } from "../src/world_checker.js";

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
  const dilemmas = synthesizeDilemmas({ source: "heuristic", inputContent: "cancel payment timeout RPC retry refund webhook", worldSpec: base, worldYaml: "", portsDts: "", worldCandidates: [], fabricCandidates: [] });
  assert.equal(dilemmas.length, 3);
  let world = base;
  for (const item of dilemmas) world = applyLegislationPatch(world, item.optionA.patch);
  assert.ok(world.states.length > base.states.length);
});

test("Option A closes direct payment capture and routes cancellation through arbitration", () => {
  const first = synthesizeDilemmas({ source: "heuristic", inputContent: "cancel payment", worldSpec: base, worldYaml: "", portsDts: "", worldCandidates: [], fabricCandidates: [] })[0]!;
  const world = applyLegislationPatch(base, first.optionA.patch);
  assert.equal(world.transitions.some((item) => item.from === "CREATED" && item.directive === "DISPATCH_PAYMENT"), false);
  const checker = createWorldChecker(world);
  assert.equal(checker.step({ transitionId: "DISPATCH_PAYMENT", proposedDirective: "DISPATCH_PAYMENT" }).allowed, false);
  assert.equal(checker.step({ transitionId: "ENTER_CANCELLATION_ARBITRATION" }).allowed, false);
  assert.ok(world.transitions.some((item) => item.from === "ARBITRATION" && item.to === "REFUNDED"));
  assert.equal(checker.step({ transitionId: "RECORD_ORDER_AMOUNT", eventPayload: { amount: 100 } }).allowed, true);
  assert.equal(checker.step({ transitionId: "MOVE_CREATED_TO_PAYMENT_PENDING" }).allowed, true);
  assert.equal(checker.step({ transitionId: "ENTER_CANCELLATION_ARBITRATION" }).allowed, true);
  assert.equal(checker.step({ transitionId: "CAPTURE_AFTER_ARBITRATION", proposedDirective: "DISPATCH_PAYMENT", eventPayload: { amount: 100 } }).currentState, "SETTLED");
  assert.equal(checker.getContext().settled_amount, 100);
  assert.equal(checker.step({ transitionId: "REFUND_AFTER_ARBITRATION", proposedDirective: "DISPATCH_REFUND" }).allowed, false);
});

test("Option A bounds uncertain payment and provides an unknown-outcome exit", () => {
  const second = synthesizeDilemmas({ source: "heuristic", inputContent: "timeout payment retry", worldSpec: base, worldYaml: "", portsDts: "", worldCandidates: [], fabricCandidates: [] })[0]!;
  const world = applyLegislationPatch(base, second.optionA.patch);
  const payment = world.transitions.find((item) => item.id === "DISPATCH_PAYMENT")!;
  assert.equal(payment.guard, "settlement_nonce == 0");
  assert.equal(payment.to, "OUTCOME_UNKNOWN");
  const checker = createWorldChecker(world);
  assert.equal(checker.step({ transitionId: "DISPATCH_PAYMENT", proposedDirective: "DISPATCH_PAYMENT" }).allowed, true);
  assert.equal(checker.step({ transitionId: "RESOLVE_UNKNOWN_AS_FAILED" }).currentState, "FAILED");
});

test("Option A conservation law rejects an over-refund after amount effects", () => {
  const third = synthesizeDilemmas({ source: "heuristic", inputContent: "refund retry", worldSpec: base, worldYaml: "", portsDts: "", worldCandidates: [], fabricCandidates: [] })[0]!;
  const world = applyLegislationPatch(base, third.optionA.patch);
  const checker = createWorldChecker(world);
  assert.equal(checker.step({ transitionId: "RECORD_ORDER_AMOUNT", eventPayload: { amount: 100 } }).allowed, true);
  checker.reset({ order_amount: 100, settled_amount: 70 });
  const verdict = checker.step({ transitionId: "RECORD_REFUND_AMOUNT", eventPayload: { amount: 40 } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violation?.code, "INVARIANT_FAILED");
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
  assert.ok(input.listenerCount("data") > 0);
});

test("redraw failure rejects and restores raw mode", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: true; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  let writes = 0;
  const output = new PassThrough();
  output.write = ((chunk: string) => { if (++writes > 7) throw new Error("display failed"); return true; }) as typeof output.write;
  const pending = runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], input, output });
  input.write("1");
  await assert.rejects(pending, /display failed/);
  assert.equal(input.isRaw, false);
});

test("two wizard sessions reuse one input stream", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: true; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  for (let index = 0; index < 2; index++) {
    const pending = runLegislationWizard({ worldSpec: base, dilemmas: [dilemma], input, output: new PassThrough() });
    input.write("\r");
    assert.equal((await pending).decisions[0]?.choice, "A");
    assert.equal(input.isRaw, false);
  }
});

test("wizard strips hostile terminal controls from rendered content", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: true; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  const pending = runLegislationWizard({ worldSpec: { ...base, states: [{ id: "BAD\x1b[2J", initial: true }] }, dilemmas: [{ ...dilemma, title: "evil\x1b[31m" }], input, output });
  input.write("q");
  await assert.rejects(pending);
  assert.doesNotMatch(rendered, /BAD\x1b\[2J|evil\x1b\[31m/);
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

test("legislate --out creates a missing parent directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-legislation-"));
  try {
    const input = join(directory, "requirements.txt");
    const out = join(directory, "missing", "nested", "world.spec.yaml");
    writeFileSync(input, "Order status CREATED to PAYMENT_PENDING. Payment capture and cancel may race.");
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin", "kadmos.js"), "legislate", input, "--accept-all-a", "--out", out], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(parseWorldSpec(readFileSync(out, "utf8")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
