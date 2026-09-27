import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileWorldSpec, parseWorldSpec } from "../src/world_compiler.js";
import type { WorldSpec } from "../src/types/world.js";

const fixture = readFileSync(
  new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url),
  "utf8",
);

test("parses and validates the complete order settlement World IR", () => {
  const world = parseWorldSpec(fixture);
  assert.equal(world.version, "kadmos.world.v0");
  assert.equal(world.name, "OrderSettlementWorld");
  assert.deepEqual(world.states.map(({ id }) => id), [
    "CREATED", "PAYMENT_PENDING", "PAID", "FULFILLED", "CANCELLED",
  ]);
  assert.deepEqual(world.states.filter(({ initial }) => initial).map(({ id }) => id), ["CREATED"]);
  assert.deepEqual(world.states.filter(({ terminal }) => terminal).map(({ id }) => id), ["FULFILLED", "CANCELLED"]);
  assert.deepEqual(Object.keys(world.context), ["order_amount", "escrow_balance", "refunded_amount", "settled_amount"]);
  assert.deepEqual(world.context.order_amount, { type: "integer", unit: "cents", min: 1, max: 100000000, default: 5000 });
  assert.deepEqual(world.invariants.map(({ id }) => id), [
    "INV-01-CONSERVATION-OF-VALUE",
    "INV-02-NO-NEGATIVE-BALANCES",
    "INV-03-FULFILLED-SETTLEMENT",
  ]);
  assert.deepEqual(world.transitions.map(({ id, from, to }) => [id, from, to]), [
    ["INITIATE_PAYMENT", "CREATED", "PAYMENT_PENDING"],
    ["CONFIRM_PAYMENT", "PAYMENT_PENDING", "PAID"],
    ["DISPATCH_GOODS", "PAID", "FULFILLED"],
    ["CANCEL_AND_REFUND", "PAID", "CANCELLED"],
    ["ABORT_UNPAID", "CREATED", "CANCELLED"],
  ]);
});

test("rejects a negative lower bound with a schema error", () => {
  const source = fixture.replace("min: 1", "min: -1");
  assert.throws(() => parseWorldSpec(source), /(?:INVALID_BOUNDS|negative|minimum)/i);
});

test("rejects malformed YAML with a parse error", () => {
  const source = fixture.replace("states:\n", "states: [\n");
  assert.throws(() => parseWorldSpec(source), /(?:YAML|syntax)/i);
});

test("rejects a missing initial state", () => {
  const source = fixture.replace("    initial: true\n", "");
  assert.throws(() => parseWorldSpec(source), /(?:INITIAL_STATE|initial)/i);
});

test("rejects an inverted numeric range", () => {
  const source = fixture.replace("max: 100000000", "max: 0");
  assert.throws(() => parseWorldSpec(source), /(?:INVALID_BOUNDS|maximum|range)/i);
});

test("rejects a negative maximum when no minimum is specified", () => {
  const source = fixture.replace("min: 1\n    max: 100000000", "max: -5");
  assert.throws(() => parseWorldSpec(source), /(?:INVALID_BOUNDS|maximum|negative)/i);
});

test("rejects a transition into an undeclared state", () => {
  const source = fixture.replace("to: PAYMENT_PENDING", "to: GHOST_STATE");
  assert.throws(() => parseWorldSpec(source), /(?:UNDECLARED_STATE|GHOST_STATE)/i);
});

test("rejects a cycle that exits a terminal state", () => {
  const source = fixture.replace(
    "transitions:\n",
    "transitions:\n  - id: RESURRECT\n    from: FULFILLED\n    to: CREATED\n    guard: true\n    directive: null\n    effects: []\n",
  );
  assert.throws(() => parseWorldSpec(source), /(?:TERMINAL_STATE|FULFILLED)/i);
});

test("rejects duplicate transition IDs", () => {
  const source = fixture.replace(
    "transitions:\n",
    "transitions:\n  - id: INITIATE_PAYMENT\n    from: CREATED\n    to: CANCELLED\n    guard: true\n    directive: null\n    effects: []\n",
  );
  assert.throws(() => parseWorldSpec(source), /DUPLICATE_TRANSITION_ID/i);
});

test("rejects an undeclared predicate identifier rather than evaluating it", () => {
  const source = fixture.replace("escrow_balance >= 0", "phantom_balance >= 0");
  assert.throws(() => parseWorldSpec(source), /(?:UNDECLARED_IDENTIFIER|phantom_balance)/i);
});

test("projects typecheckable ports.d.ts and world_checker.ts", () => {
  const projection = compileWorldSpec(parseWorldSpec(fixture));
  assert.match(projection.portsDts, /export type WorldState\s*=/);
  assert.match(projection.portsDts, /export type WorldDirective\s*=/);
  assert.match(projection.portsDts, /export interface IWorldChecker/);
  assert.match(projection.portsDts, /export interface StepVerdict/);
  assert.match(projection.worldCheckerTs, /(?:class|function)\s+WorldChecker/);

  const directory = mkdtempSync(join(tmpdir(), "kadmos-projection-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const tsc = join(process.cwd(), "node_modules", ".bin", "tsc");
    const result = spawnSync(tsc, [
      "--ignoreConfig",
      "--strict", "--noEmit", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiler projection is independently testable from the YAML parser", () => {
  const smallWorld: WorldSpec = {
    version: "kadmos.world.v0",
    name: "SmallWorld",
    states: [{ id: "START", initial: true }, { id: "DONE", terminal: true }],
    context: { amount: { type: "integer", min: 1, max: 10, default: 5 } },
    invariants: [{ id: "INV-AMOUNT", predicate: "amount > 0" }],
    transitions: [{ id: "FINISH", from: "START", to: "DONE", guard: true, directive: "SEND", effects: [] }],
  };
  const projection = compileWorldSpec(smallWorld);
  assert.match(projection.portsDts, /START/);
  assert.match(projection.portsDts, /DONE/);
  assert.match(projection.portsDts, /SEND/);
  assert.match(projection.worldCheckerTs, /FINISH/);
});

test("generated checker enforces payment guard, applies effects, and validates terminal state and reset bounds", async () => {
  const projection = compileWorldSpec(parseWorldSpec(fixture));
  const directory = mkdtempSync(join(tmpdir(), "kadmos-runtime-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    const gate = new WorldChecker();
    gate.reset({ order_amount: 5000 });

    // Step 1: Initiate
    assert.equal(gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" }).allowed, true);

    // Step 2: Failed confirm
    assert.equal(gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 4999 } }).allowed, false);
    assert.equal(gate.getContext().escrow_balance, 0);

    // Step 2: Successful confirm
    assert.equal(gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } }).allowed, true);
    assert.equal(gate.getContext().escrow_balance, 5000);

    // Step 3: Fulfill
    const fulfill = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
    assert.equal(fulfill.allowed, true);
    assert.equal(gate.getState(), "FULFILLED");
    assert.equal(gate.getContext().settled_amount, 5000);
    assert.equal(gate.getContext().escrow_balance, 0);

    // Validate that reset with illegal bounds throws
    assert.throws(() => gate.reset({ order_amount: 0 }), /INVALID_BOUNDS/);
    assert.throws(() => gate.reset({ order_amount: -5 }), /INVALID_BOUNDS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
