import assert from "node:assert/strict";
import test from "node:test";
import { inferBoundary } from "../src/boundary_inference.js";
import { MockDeterministicProvider } from "../src/agent/provider.js";
import type { LlmCompletionRequest } from "../src/agent/provider.js";
import { parseWorldSpec } from "../src/world_compiler.js";

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
    states: [{ id: "CREATED", initial: true }, { id: "PAID", terminal: true }],
    context: { captured: { type: "integer", min: 0, max: 1000, default: 0 } },
    invariants: [{ id: "INV_CAPTURE", predicate: "captured <= escrow_balance", description: "Capture cannot exceed escrow" }],
    transitions: [{ id: "CAPTURE", from: "CREATED", to: "PAID", guard: "escrow_balance >= 1", directive: "DISPATCH_PAYMENT", effects: ["captured = escrow_balance"] }],
  };
  const result = await inferBoundary(prd, { provider: new MockDeterministicProvider([JSON.stringify(extraction)]) });
  assert.ok(result.worldSpec.states.some((state) => state.id === "PAID" && state.terminal));
  assert.equal(result.source, "hybrid");
  assert.equal(result.worldSpec.context.captured?.max, 1000);
  assert.ok(result.worldSpec.invariants.some((invariant) => invariant.predicate === "captured <= escrow_balance"));
  assert.ok(result.worldSpec.transitions.some((transition) => transition.id === "CAPTURE" && transition.effects.includes("captured = escrow_balance")));
  assert.match(result.portsDts, /"PAID"/);
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
