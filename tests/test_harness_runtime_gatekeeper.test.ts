import assert from "node:assert/strict";
import test from "node:test";

import { createWorldChecker } from "../src/world_checker.js";
import type { IWorldChecker, StepVerdict } from "../src/types/ports.js";
import type { WorldSpec } from "../src/types/world.js";

// Independent typed oracle
const world: WorldSpec = {
  version: "kadmos.world.v0",
  name: "OrderSettlementWorld",
  states: [
    { id: "CREATED", initial: true },
    { id: "PAYMENT_PENDING" },
    { id: "PAID" },
    { id: "FULFILLED", terminal: true },
    { id: "CANCELLED", terminal: true },
  ],
  context: {
    order_amount: { type: "integer", unit: "cents", min: 1, max: 100000000, default: 5000 },
    escrow_balance: { type: "integer", unit: "cents", default: 0, min: 0, max: 100000000 },
    refunded_amount: { type: "integer", unit: "cents", default: 0, min: 0, max: 100000000 },
    settled_amount: { type: "integer", unit: "cents", default: 0, min: 0, max: 100000000 },
  },
  invariants: [
    { id: "INV-01-CONSERVATION-OF-VALUE", predicate: "escrow_balance + refunded_amount + settled_amount <= order_amount" },
    { id: "INV-02-NO-NEGATIVE-BALANCES", predicate: "escrow_balance >= 0 && refunded_amount >= 0 && settled_amount >= 0" },
    { id: "INV-03-FULFILLED-SETTLEMENT", predicate: "state == 'FULFILLED' => (settled_amount == order_amount && escrow_balance == 0)" },
  ],
  transitions: [
    { id: "INITIATE_PAYMENT", from: "CREATED", to: "PAYMENT_PENDING", guard: "order_amount > 0", directive: "DISPATCH_PAYMENT_GATEWAY", effects: [] },
    { id: "CONFIRM_PAYMENT", from: "PAYMENT_PENDING", to: "PAID", guard: "event.captured_amount == order_amount", directive: null, effects: ["escrow_balance = order_amount"] },
    { id: "DISPATCH_GOODS", from: "PAID", to: "FULFILLED", guard: "escrow_balance == order_amount", directive: "INVOKE_LOGISTICS_DISPATCH", effects: ["settled_amount = escrow_balance", "escrow_balance = 0"] },
    { id: "CANCEL_AND_REFUND", from: "PAID", to: "CANCELLED", guard: "escrow_balance == order_amount", directive: "DISPATCH_REFUND", effects: ["refunded_amount = escrow_balance", "escrow_balance = 0"] },
    { id: "ABORT_UNPAID", from: "CREATED", to: "CANCELLED", guard: true, directive: null, effects: [] },
  ],
};

function checker(): IWorldChecker {
  return createWorldChecker(world, { order_amount: 5000 });
}

test("A: valid payment and fulfillment path allows each step and directive", () => {
  const gate = checker();
  const initiate = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  assert.equal(initiate.allowed, true);
  assert.equal(initiate.previousState, "CREATED");
  assert.equal(initiate.currentState, "PAYMENT_PENDING");
  assert.equal(initiate.directiveAllowed, "DISPATCH_PAYMENT_GATEWAY");

  const confirm = gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } });
  assert.equal(confirm.allowed, true);
  assert.equal(confirm.currentState, "PAID");
  assert.equal(confirm.context.escrow_balance, 5000);
  assert.equal(confirm.directiveAllowed, null);

  const dispatch = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  assert.equal(dispatch.allowed, true);
  assert.equal(dispatch.currentState, "FULFILLED");
  assert.equal(dispatch.directiveAllowed, "INVOKE_LOGISTICS_DISPATCH");
  assert.equal(gate.getState(), "FULFILLED");
  assert.equal(gate.getContext().settled_amount, 5000);
  assert.equal(gate.getContext().escrow_balance, 0);
});

function dispatchThroughGate(gate: IWorldChecker, calls: string[]): StepVerdict {
  const verdict = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  if (verdict.allowed && verdict.directiveAllowed === "INVOKE_LOGISTICS_DISPATCH") {
    calls.push("logistics RPC");
  }
  return verdict;
}

test("B: dispatch from CREATED is blocked before the logistics side effect with sound blame", () => {
  const gate = checker();
  const calls: string[] = [];
  const verdict = dispatchThroughGate(gate, calls);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violation?.code, "INVALID_TRANSITION");
  assert.equal(verdict.violation?.violatedInvariant, undefined);
  assert.equal(verdict.directiveAllowed, null);
  assert.equal(verdict.currentState, "CREATED");
  assert.equal(gate.getState(), "CREATED");
  assert.deepEqual(calls, []);
});

test("B: dispatch from PAYMENT_PENDING is blocked before the logistics side effect with sound blame", () => {
  const gate = checker();
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  const calls: string[] = [];
  const verdict = dispatchThroughGate(gate, calls);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violation?.code, "INVALID_TRANSITION");
  assert.equal(verdict.violation?.violatedInvariant, undefined);
  assert.equal(verdict.directiveAllowed, null);
  assert.equal(verdict.currentState, "PAYMENT_PENDING");
  assert.equal(gate.getState(), "PAYMENT_PENDING");
  assert.deepEqual(calls, []);
});

test("C: an undeclared transition fails closed without mutating state or context", () => {
  const gate = checker();
  const before = gate.getContext();
  const verdict = gate.step({ transitionId: "SHIP_WITHOUT_PAYMENT", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.directiveAllowed, null);
  assert.equal(verdict.currentState, "CREATED");
  assert.deepEqual(gate.getContext(), before);
  assert.deepEqual(verdict.violation?.shortestCounterexampleTrace, [
    { step: 1, state: "CREATED", action: "SHIP_WITHOUT_PAYMENT", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" },
  ]);
});

test("D: violation contains the exact shortest ordered prefix and rejected attempt", () => {
  const gate = checker();
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  const verdict = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.violation?.shortestCounterexampleTrace, [
    { step: 1, state: "CREATED", action: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" },
    { step: 2, state: "PAYMENT_PENDING", action: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" },
  ]);
});

test("a rejected attempt cannot pollute a later shortest counterexample", () => {
  const gate = checker();
  gate.step({ transitionId: "SHIP_WITHOUT_PAYMENT" });
  const verdict = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  assert.deepEqual(verdict.violation?.shortestCounterexampleTrace, [
    { step: 1, state: "CREATED", action: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" },
  ]);
});

test("wrong payment capture is denied without increasing escrow", () => {
  const gate = checker();
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  const verdict = gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 4999 } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.directiveAllowed, null);
  assert.equal(gate.getState(), "PAYMENT_PENDING");
  assert.equal(gate.getContext().escrow_balance, 0);
});

test("a valid transition cannot authorize an undeclared directive", () => {
  const gate = checker();
  const verdict = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.directiveAllowed, null);
  assert.equal(gate.getState(), "CREATED");
});

test("a side-effect transition requires its directive to be proposed", () => {
  const gate = checker();
  const verdict = gate.step({ transitionId: "INITIATE_PAYMENT" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.directiveAllowed, null);
  assert.equal(gate.getState(), "CREATED");
});
