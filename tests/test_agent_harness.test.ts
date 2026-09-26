import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWorldChecker, MockDeterministicProvider, parseWorldSpec, synthesizeCegisPrompt } from "../src/index.js";
import type { TransitionStepRequest } from "../src/index.js";

const world = parseWorldSpec(readFileSync(new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url), "utf8"));
const request = (messages: { role: "user"; content: string }[] = []) => ({ systemPrompt: "Build order service", messages });

test("scripted provider returns each turn in order and fails when exhausted", async () => {
  const provider = new MockDeterministicProvider(["illegal", "repaired"]);
  assert.equal((await provider.complete(request())).content, "illegal");
  assert.equal((await provider.complete(request([{ role: "user", content: "repair" }]))).content, "repaired");
  await assert.rejects(provider.complete(request()), /exhausted/i);
});

test("invalid transition prompt includes actual shortest trace and legal prerequisite route", () => {
  const gate = createWorldChecker(world);
  const verdict = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  const prompt = synthesizeCegisPrompt(verdict, world);
  assert.match(prompt, /ILLEGAL_TRANSITION/);
  assert.match(prompt, /State=`CREATED`, Action=`DISPATCH_GOODS`/);
  assert.match(prompt, /DENIED \(Fail-Closed, zero mutation\)/);
  assert.match(prompt, /INITIATE_PAYMENT[\s\S]*CONFIRM_PAYMENT[\s\S]*DISPATCH_GOODS/);
  assert.match(prompt, /captured_amount.*order_amount/);
  assert.match(prompt, /escrow_balance == order_amount/);
  assert.match(prompt, /```typescript/);
  assert.equal(gate.getState(), "CREATED");
});

test("invariant failure prompt names the exact predicate and violating effect", () => {
  const broken = {
    ...world,
    transitions: world.transitions.map((transition) => transition.id === "DISPATCH_GOODS"
      ? { ...transition, effects: ["settled_amount = escrow_balance"] }
      : transition),
  };
  const gate = createWorldChecker(broken);
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } });
  const verdict = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  assert.equal(verdict.violation?.code, "INVARIANT_FAILED");
  const prompt = synthesizeCegisPrompt(verdict, broken);
  assert.match(prompt, /INVARIANT_VIOLATED/);
  assert.match(prompt, /INV-01-CONSERVATION-OF-VALUE/);
  assert.match(prompt, /escrow_balance \+ refunded_amount \+ settled_amount <= order_amount/);
  assert.match(prompt, /settled_amount = escrow_balance/);
  assert.match(prompt, /Step 1[\s\S]*Step 2[\s\S]*Step 3/);
  assert.equal(gate.getState(), "PAID");
  assert.equal(gate.getContext().escrow_balance, 5000);
});

test("failed guard prompt identifies required payload algebra", () => {
  const gate = createWorldChecker(world);
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  const verdict = gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 4999 } });
  const prompt = synthesizeCegisPrompt(verdict, world);
  assert.match(prompt, /GUARD_FAILED/);
  assert.match(prompt, /event\.captured_amount == order_amount/);
  assert.match(prompt, /4999/);
  assert.equal(gate.getState(), "PAYMENT_PENDING");
});

test("reentrancy refusal instructs serialization", () => {
  const prompt = synthesizeCegisPrompt({
    allowed: false,
    previousState: "CREATED",
    currentState: "CREATED",
    context: { order_amount: 5000 },
    directiveAllowed: null,
    violation: { code: "REENTRANCY_DENIED", message: "nested step", shortestCounterexampleTrace: [] },
  }, world);
  assert.match(prompt, /REENTRANCY_DENIED/);
  assert.match(prompt, /Move the nested action after the current step returns/);
});

test("refusal prompt drives a scripted repair through the real checker", async () => {
  const plans: Record<string, readonly TransitionStepRequest[]> = {
    shortcut: [{ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" }],
    repaired: [
      { transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" },
      { transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } },
      { transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" },
    ],
  };
  const provider = new MockDeterministicProvider(["shortcut", "repaired"]);
  const gate = createWorldChecker(world);
  const first = await provider.complete(request());
  const refused = gate.step(plans[first.content]![0]!);
  assert.equal(refused.allowed, false);
  const prompt = synthesizeCegisPrompt(refused, world);
  const second = await provider.complete(request([{ role: "user", content: prompt }]));
  for (const step of plans[second.content]!) assert.equal(gate.step(step).allowed, true);
  assert.equal(gate.getState(), "FULFILLED");
  assert.equal(gate.getContext().settled_amount, 5000);
});

test("three-strike harness stops after max turns with no authorized side effect", async () => {
  const provider = new MockDeterministicProvider(["shortcut", "shortcut", "shortcut", "repaired"]);
  const gate = createWorldChecker(world);
  const messages: { role: "user"; content: string }[] = [];
  let turns = 0;
  let accepted = false;
  for (; turns < 3; turns++) {
    const completion = await provider.complete(request(messages));
    const candidate = completion.content === "shortcut"
      ? { transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" }
      : { transitionId: "ABORT_UNPAID" };
    const verdict = gate.step(candidate);
    if (verdict.allowed) { accepted = true; break; }
    messages.push({ role: "user", content: synthesizeCegisPrompt(verdict, world) });
  }
  assert.equal(accepted, false);
  assert.equal(turns, 3);
  assert.equal(gate.getState(), "CREATED");
  assert.equal(gate.getContext().escrow_balance, 0);
  assert.equal(messages.length, 3);
});
