import assert from "node:assert/strict";
import test from "node:test";

import { createWorldChecker } from "../src/world_checker.js";
import type { WorldSpec } from "../src/types/world.js";
import { evaluate } from "../src/world_expression.js";

const securityWorld: WorldSpec = {
  version: "kadmos.world.v0",
  name: "SecurityTestWorld",
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
    { id: "ABORT_UNPAID", from: "CREATED", to: "CANCELLED", guard: true, directive: null, effects: [] },
  ],
};

test("P0-3 security: accessor getter in eventPayload is intercepted as a security violation", () => {
  const gate = createWorldChecker(securityWorld, { order_amount: 5000 });
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });

  let getterExecuted = false;
  const maliciousPayload = {
    get captured_amount(): number {
      getterExecuted = true;
      gate.reset({ order_amount: 5000 });
      return 5000;
    },
  };

  const verdict = gate.step({
    transitionId: "CONFIRM_PAYMENT",
    eventPayload: maliciousPayload as unknown as Record<string, unknown>,
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violation?.code, "SECURITY_VIOLATION");
  assert.equal(getterExecuted, false, "Getter should NEVER be invoked by sanitizer");
  assert.equal(gate.getState(), "PAYMENT_PENDING", "State must remain PAYMENT_PENDING without reentrant mutation");
});

test("P0-1 soundness: terminal state FULFILLED satisfies all declared invariants", () => {
  const gate = createWorldChecker(securityWorld, { order_amount: 5000 });
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } });
  const fulfill = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });

  assert.equal(fulfill.allowed, true);
  assert.equal(gate.getState(), "FULFILLED");
  const ctx = gate.getContext();
  assert.equal(ctx.settled_amount, 5000);
  assert.equal(ctx.escrow_balance, 0);

  const finalEnv = { ...ctx, state: gate.getState(), event: {} };
  for (const inv of securityWorld.invariants) {
    const res = evaluate(inv.predicate, finalEnv);
    assert.equal(res, true, `Invariant '${inv.id}' must be true in FULFILLED`);
  }
});

test("P1-3 sort check: truthy non-boolean string fails closed as GUARD_FAILED", () => {
  const stringGuardWorld: WorldSpec = {
    ...securityWorld,
    transitions: [
      { id: "NON_BOOL", from: "CREATED", to: "PAYMENT_PENDING", guard: "'truthy_string'", directive: null, effects: [] },
    ],
  };
  const gate = createWorldChecker(stringGuardWorld, { order_amount: 5000 });
  const verdict = gate.step({ transitionId: "NON_BOOL" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violation?.code, "GUARD_FAILED");
  assert.equal(gate.getState(), "CREATED");
});

test("P1-4 immutability: mutating rawSpec after createWorldChecker does not affect gatekeeper", () => {
  const mutableSpec: WorldSpec = structuredClone(securityWorld);
  const gate = createWorldChecker(mutableSpec, { order_amount: 5000 });

  // Caller attempts in-memory attack to allow illegal transition from CREATED
  (mutableSpec.transitions as any)[2]!.from = "CREATED";

  const verdict = gate.step({
    transitionId: "DISPATCH_GOODS",
    proposedDirective: "INVOKE_LOGISTICS_DISPATCH",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violation?.code, "INVALID_TRANSITION");
  assert.equal(gate.getState(), "CREATED");
});

test("P1-7 initial bounds: reset with illegal bounds throws INVALID_BOUNDS", () => {
  const gate = createWorldChecker(securityWorld, { order_amount: 5000 });
  assert.throws(() => gate.reset({ order_amount: 0 }), /INVALID_BOUNDS/);
  assert.throws(() => gate.reset({ order_amount: -10 }), /INVALID_BOUNDS/);
});
