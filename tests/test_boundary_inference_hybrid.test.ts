import assert from "node:assert/strict";
import test from "node:test";
import { inferBoundary } from "../src/boundary_inference.js";
import { MockDeterministicProvider } from "../src/agent/provider.js";
import type { LlmCompletionRequest } from "../src/agent/provider.js";
import { parseWorldSpec } from "../src/world_compiler.js";
import { synthesizeDilemmas } from "../src/dilemma_synthesis.js";
import { createWorldChecker } from "../src/world_checker.js";
import { runLegislationWizard } from "../src/tui/wizard.js";

const prd = "Order status moves from CREATED to PAID. Escrow balance must never be negative. Payment capture uses a gateway; retry on timeout.";

test("omitted provider retains the synchronous heuristic baseline", () => {
  const result = inferBoundary(prd, { name: "Orders" });
  assert.equal(result.worldSpec.name, "Orders");
  assert.equal(result.source, "heuristic");
  assert.ok(result.worldCandidates.some((candidate) => candidate.category === "monetary"));
  assert.ok(result.fabricCandidates.some((candidate) => candidate.category === "retry"));
  assert.deepEqual(parseWorldSpec(result.worldYaml), result.worldSpec);
});

test("valid semantic extraction adds formal states, context, invariants, and transitions", async () => {
  const extraction = {
    states: [{ id: "CREATED", initial: true }, { id: "PAID" }, { id: "SETTLED", terminal: true }],
    context: { captured: { type: "integer", min: 0, max: 1000, default: 0 } },
    invariants: [{ id: "INV_CAPTURE", predicate: "captured <= escrow_balance", description: "Capture cannot exceed escrow" }],
    transitions: [{ id: "CAPTURE", from: "PAID", to: "SETTLED", guard: "escrow_balance >= 1", directive: "DISPATCH_PAYMENT", effects: ["captured = escrow_balance"] }],
  };
  const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(extraction)]) });
  assert.ok(result.worldSpec.states.some((state) => state.id === "SETTLED" && state.terminal));
  assert.equal(result.source, "hybrid");
  assert.equal(result.worldSpec.context.captured?.max, 1000);
  assert.ok(result.worldSpec.invariants.some((invariant) => invariant.predicate === "captured <= escrow_balance"));
  assert.ok(result.worldSpec.transitions.some((transition) => transition.id === "CAPTURE" && transition.effects.includes("captured = escrow_balance")));
  assert.match(result.portsDts, /"SETTLED"/);
  assert.deepEqual(parseWorldSpec(result.worldYaml), result.worldSpec);
});

test("merge deduplicates local and semantic entities while preserving an initial state", async () => {
  const extraction = {
    states: [{ id: "CREATED" }, { id: "PAID" }, { id: "SETTLED", terminal: true }],
    context: { escrow_balance: { type: "integer", min: 0, max: 500, default: 0 } },
    invariants: [{ id: "INV_EXTRA", predicate: "escrow_balance <= 500" }],
    transitions: [
      { id: "SETTLE", from: "PAID", to: "SETTLED", guard: "escrow_balance >= 0", directive: null },
    ],
  };
  const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(extraction)]) });
  assert.equal(result.worldSpec.states.filter((state) => state.id === "CREATED").length, 1);
  assert.equal(result.worldSpec.states.filter((state) => state.initial).length, 1);
  assert.equal(result.worldSpec.context.escrow_balance?.max, 500);
  assert.equal(result.worldSpec.context.escrow_balance?.unit, "cents");
  assert.equal(result.worldSpec.invariants.filter((invariant) => invariant.predicate === "escrow_balance >= 0").length, 1);
  assert.equal(result.worldSpec.transitions.filter((transition) => transition.from === "CREATED" && transition.to === "PAID" && transition.directive === null).length, 1);
  assert.ok(result.worldSpec.transitions.some((transition) => transition.id === "SETTLE"));
  assert.deepEqual(parseWorldSpec(result.worldYaml), result.worldSpec);
});

test("malformed JSON, invalid schema, and invalid World bounds fall back to identical local output", async () => {
  const baseline = inferBoundary(prd);
  for (const response of [
    "{ broken",
    JSON.stringify({ states: [], context: { amount: { type: "float" } }, invariants: [], transitions: [] }),
    JSON.stringify({ states: [], context: { escrow_balance: { type: "integer", min: 10, max: 5 } }, invariants: [], transitions: [] }),
  ]) {
    const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([response]) });
    assert.deepEqual(result, baseline);
  }
});

test("provider rejection falls back to local output", async () => {
  const baseline = inferBoundary(prd);
  const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([]) });
  assert.deepEqual(result, baseline);
});

test("hybrid inference passes the selected model to the provider", async () => {
  let requestedModel: string | undefined;
  const provider = new MockDeterministicProvider([JSON.stringify({ states: [], context: {}, invariants: [], transitions: [] })]);
  const complete = provider.complete.bind(provider);
  provider.complete = (request: LlmCompletionRequest) => { requestedModel = request.model; return complete(request); };
  await inferBoundary(prd, { provider, model: "review-model" });
  assert.equal(requestedModel, "review-model");
});

test("hybrid extraction rejects clobbered invariant, bounds, transitions, and control IDs", async () => {
  const baseline = inferBoundary(prd);
  const empty = { states: [], context: {}, invariants: [], transitions: [] };
  const attacks = [
    { ...empty, invariants: [{ id: "INV_1_NONNEGATIVE", predicate: "true" }] },
    { ...empty, context: { escrow_balance: { type: "integer", min: 0, default: 0 } } },
    { ...empty, context: { escrow_balance: { type: "integer", min: 0, max: 1000, unit: "dollars", default: 0 } } },
    { ...empty, transitions: [{ id: "MOVE_CREATED_TO_PAID", from: "PAID", to: "CREATED", guard: "true" }] },
    { ...empty, states: [{ id: "PAID\u001b[2J" }] },
  ];
  for (const attack of attacks) assert.deepEqual(await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) }), baseline);
});

test("omitted directive cannot mint escrow on an existing move or authorize refund after Option A", async () => {
  const input = `${prd} Cancellation and refund may race with payment capture.`;
  const baseline = inferBoundary(input);
  const attack = {
    states: [], context: {}, invariants: [],
    transitions: [{ id: "MINT_ESCROW", from: "CREATED", to: "PAID", guard: "true", effects: ["escrow_balance = 100"] }],
  };
  const result = await inferBoundary(input, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) });
  assert.deepEqual(result, baseline);
  const dilemmas = synthesizeDilemmas(result);
  assert.ok(dilemmas.some((item) => item.id === "DIL-001"));
  const legislated = await runLegislationWizard({ worldSpec: result.worldSpec, dilemmas, acceptAllA: true, nonInteractive: true });
  const checker = createWorldChecker(legislated.worldSpec);
  assert.equal(checker.getContext().escrow_balance, 0);
  assert.equal(checker.step({ transitionId: "ENTER_CANCELLATION_ARBITRATION" }).allowed, true);
  assert.equal(checker.step({ transitionId: "REFUND_AFTER_ARBITRATION", proposedDirective: "DISPATCH_REFUND" }).allowed, false);
});

test("a different directive cannot add effects to an existing state edge", async () => {
  const baseline = inferBoundary(prd);
  const attack = {
    states: [], context: {}, invariants: [],
    transitions: [{ id: "MINT_WITH_DIRECTIVE", from: "CREATED", to: "PAID", guard: "true", directive: "DISPATCH_PAYMENT", effects: ["escrow_balance = 100"] }],
  };
  assert.deepEqual(await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) }), baseline);
});

test("a shared state edge cannot inject a refund directive under a different ID", async () => {
  const baseline = inferBoundary(prd);
  const attack = {
    states: [], context: {}, invariants: [],
    transitions: [{ id: "EVIL_REFUND", from: "CREATED", to: "PAID", guard: "true", directive: "DISPATCH_REFUND", effects: [] }],
  };
  assert.deepEqual(await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) }), baseline);
});

test("new transitions cannot assign numeric literals or monetary and local context fields", async () => {
  const baseline = inferBoundary(prd);
  const empty = { states: [{ id: "SETTLED" }], invariants: [] };
  const attacks = [
    { target: "captured", effect: "captured = 100" },
    { target: "order_amount", effect: "order_amount = captured" },
    { target: "escrow_balance", effect: "escrow_balance = captured" },
    { target: "refunded_amount", effect: "refunded_amount = captured" },
    { target: "settled_amount", effect: "settled_amount = captured" },
  ];
  for (const { target, effect } of attacks) {
    const attack = {
      ...empty,
      context: { captured: { type: "integer", min: 0, default: 0 }, ...(target === "escrow_balance" ? {} : { [target]: { type: "integer", min: 0, default: 0 } }) },
      transitions: [{ id: "CAPTURE", from: "PAID", to: "SETTLED", guard: "true", effects: [effect] }],
    };
    assert.deepEqual(await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) }), baseline, effect);
  }
});

test("new context fields cannot start with a nonzero balance when PRD omits amount", async () => {
  const input = prd;
  const baseline = inferBoundary(input);
  const attack = { states: [], context: { order_amount: { type: "integer", min: 0, default: 1_000_000_000 } }, invariants: [], transitions: [] };
  const result = await inferBoundary(input, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) });
  assert.deepEqual(result, baseline);
  assert.equal(result.worldSpec.context.order_amount, undefined);
  assert.equal(result.worldSpec.context.escrow_balance?.default, 0);
});

test("semantic extraction cannot replace the opening escrow balance", async () => {
  const baseline = inferBoundary(prd);
  const attack = { states: [], context: { escrow_balance: { type: "integer", unit: "cents", min: 0, max: 1_000_000_000, default: 1_000_000_000 } }, invariants: [], transitions: [] };
  const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) });
  assert.deepEqual(result, baseline);
  assert.equal(result.worldSpec.context.escrow_balance?.default, 0);
  assert.equal(createWorldChecker(result.worldSpec).getContext().escrow_balance, 0);
});

test("semantic extraction cannot assign a new initial state", async () => {
  const baseline = inferBoundary(prd);
  const attack = { states: [{ id: "HIJACKED", initial: true }], context: {}, invariants: [], transitions: [] };
  const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(attack)]) });
  assert.deepEqual(result, baseline);
  assert.equal(result.worldSpec.states.find((state) => state.initial)?.id, "CREATED");
  assert.equal(createWorldChecker(result.worldSpec).getState(), "CREATED");
});
