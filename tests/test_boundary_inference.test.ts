import assert from "node:assert/strict";
import test from "node:test";
import { inferBoundary } from "../src/boundary_inference.js";
import { synthesizeDilemmas } from "../src/dilemma_synthesis.js";
import { parseWorldSpec } from "../src/world_compiler.js";

test("PRD monetary and lifecycle signals become a parseable candidate World", () => {
  const result = inferBoundary("Order status moves from CREATED to PAYMENT_PENDING to PAID or CANCELLED. Escrow balance and refund amount must never be negative. Payment capture and cancel can happen concurrently. Retry HTTP requests after timeout.", { name: "OrderWorld" });
  assert.equal(result.worldSpec.name, "OrderWorld");
  assert.ok(result.worldCandidates.some((item) => item.category === "monetary" && /balance/i.test(item.evidence)));
  assert.ok(result.worldCandidates.some((item) => item.category === "lifecycle"));
  assert.ok(result.fabricCandidates.some((item) => item.category === "network"));
  assert.ok(result.fabricCandidates.some((item) => item.category === "retry"));
  assert.ok(result.worldSpec.transitions.some((item) => item.from === "CREATED" && item.to === "PAYMENT_PENDING"));
  assert.deepEqual(parseWorldSpec(result.worldYaml), result.worldSpec);
  assert.match(result.portsDts, /export type WorldState/);
});

test("code classifies guards and side effects separately from transport policy", () => {
  const result = inferBoundary("if (status === 'PAID') { assert(balance >= 0); await payment.charge(amount); } await fetch(url); cache.set(key, value); setTimeout(retry, 1000);");
  assert.ok(result.worldCandidates.some((item) => item.category === "safety"));
  assert.ok(result.worldCandidates.some((item) => item.category === "side_effect"));
  assert.ok(result.fabricCandidates.some((item) => item.category === "cache"));
  assert.ok(result.fabricCandidates.some((item) => item.category === "timeout"));
  assert.ok(result.worldSpec.context.balance);
  assert.deepEqual(parseWorldSpec(result.worldYaml), result.worldSpec);
});

test("dilemmas expose ordered hazardous traces and explicit legislative alternatives", () => {
  const result = inferBoundary("Order status is PAYMENT_PENDING. Concurrent cancel and payment capture webhook may race. A timeout may occur while payment RPC is in flight; retry payment.");
  const dilemmas = synthesizeDilemmas(result);
  assert.ok(dilemmas.length >= 2 && dilemmas.length <= 3);
  for (const dilemma of dilemmas) {
    assert.match(dilemma.id, /^DIL-\d{3}$/);
    assert.ok(dilemma.worstCaseTrace.length >= 3);
    assert.match(dilemma.optionA, /World|guard/i);
    assert.match(dilemma.optionB, /Fabric|retry/i);
  }
  assert.ok(dilemmas.some((item) => /cancel/i.test(item.title)));
  assert.ok(dilemmas.some((item) => /timeout/i.test(item.title)));
});

test("empty input stays a valid draft without invented business rules", () => {
  const result = inferBoundary("");
  assert.equal(result.worldCandidates.length, 0);
  assert.equal(result.worldSpec.invariants.length, 0);
  assert.deepEqual(parseWorldSpec(result.worldYaml), result.worldSpec);
  assert.deepEqual(synthesizeDilemmas(result), []);
});
