import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createWorldChecker } from "../src/world_checker.js";
import { compileWorldSpec } from "../src/world_compiler.js";
import type { IWorldChecker } from "../src/types/ports.js";
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

test("reserved payload keys return security verdicts without changing state", async () => {
  const projection = compileWorldSpec(securityWorld);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-reserved-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const build = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    for (const makeGate of [() => createWorldChecker(securityWorld), () => new WorldChecker() as IWorldChecker]) {
      const gate = makeGate();
      for (const key of ["__proto__", "constructor", "prototype"]) {
        const payload = JSON.parse(key === "constructor" ? '{"constructor":1}' : `{"${key}":{"captured_amount":5000}}`) as Record<string, unknown>;
        const verdict = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY", eventPayload: payload });
        assert.equal(verdict.allowed, false, key);
        assert.equal(verdict.violation?.code, "SECURITY_VIOLATION", key);
        assert.equal(verdict.currentState, "CREATED", key);
        assert.equal(gate.getState(), "CREATED", key);
      }
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let level = 0; level < 1200; level++) {
        const child: Record<string, unknown> = {};
        cursor.child = child;
        cursor = child;
      }
      const verdict = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY", eventPayload: deep });
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.violation?.code, "SECURITY_VIOLATION");
      assert.match(verdict.violation?.message ?? "", /(?:depth|node count) exceeded/);
      assert.equal(verdict.currentState, "CREATED");
      assert.equal(gate.getState(), "CREATED");
      for (const payload of [new Date(), new Map(), new Number(1), new Proxy({}, { getPrototypeOf: () => Date.prototype }), new Proxy({}, {})]) {
        const rejected = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY", eventPayload: payload as Record<string, unknown> });
        assert.equal(rejected.allowed, false);
        assert.equal(rejected.violation?.code, "SECURITY_VIOLATION");
        assert.equal(rejected.currentState, "CREATED");
        assert.equal(rejected.directiveAllowed, null);
        assert.equal(gate.getState(), "CREATED");
      }
      const hostile = { transitionId: { toString() { hostile.proposedDirective = "DISPATCH_PAYMENT_GATEWAY"; return "INITIATE_PAYMENT"; } }, proposedDirective: "WRONG" };
      const coerced = gate.step(hostile as unknown as Parameters<IWorldChecker["step"]>[0]);
      assert.equal(coerced.allowed, false);
      assert.equal(coerced.violation?.code, "SECURITY_VIOLATION");
      assert.equal(hostile.proposedDirective, "WRONG");
      assert.equal(gate.getState(), "CREATED");
      for (const malformed of [null, [], { get transitionId() { throw new Error("read transitionId"); } },
        { transitionId: "INITIATE_PAYMENT", get proposedDirective() { throw new Error("read proposedDirective"); } }]) {
        const rejected = gate.step(malformed as unknown as Parameters<IWorldChecker["step"]>[0]);
        assert.equal(rejected.violation?.code, "SECURITY_VIOLATION");
        assert.equal(gate.getState(), "CREATED");
      }
      const shared = {};
      const diamond = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY", eventPayload: { left: shared, right: shared } });
      assert.equal(diamond.violation?.code, "SECURITY_VIOLATION");
      assert.match(diamond.violation?.message ?? "", /cyclic or shared object graph/);
      assert.equal(gate.getState(), "CREATED");
      const initiated = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
      assert.equal(initiated.allowed, true);
      let payloadGetterCalled = false;
      const request = { transitionId: "CONFIRM_PAYMENT", get eventPayload() {
        payloadGetterCalled = true;
        (gate as unknown as { state: string; context: Record<string, number>; history: unknown[] }).state = "PAID";
        (gate as unknown as { state: string; context: Record<string, number>; history: unknown[] }).context = { escrow_balance: 5000 };
        (gate as unknown as { state: string; context: Record<string, number>; history: unknown[] }).history = [];
        return { captured_amount: 5000 };
      } };
      const getterVerdict = gate.step(request);
      assert.equal(getterVerdict.violation?.code, "SECURITY_VIOLATION");
      assert.equal(payloadGetterCalled, false);
      assert.equal(gate.getState(), "PAYMENT_PENDING");
      assert.equal(gate.getContext().escrow_balance, 0);
      assert.equal(getterVerdict.violation?.shortestCounterexampleTrace.length, 2);
      let toStringCalled = false;
      const hostileId = { toString() {
        toStringCalled = true;
        (gate as unknown as { state: string }).state = "PAID";
        return "CONFIRM_PAYMENT";
      } };
      const hostileVerdict = gate.step({ transitionId: hostileId as unknown as string, eventPayload: { captured_amount: 5000 } });
      assert.equal(hostileVerdict.violation?.code, "SECURITY_VIOLATION");
      assert.equal(toStringCalled, false);
      assert.equal(hostileVerdict.violation?.shortestCounterexampleTrace.at(-1)?.action, "<invalid>");
      assert.equal(gate.getState(), "PAYMENT_PENDING");
      assert.equal(gate.getContext().escrow_balance, 0);
      (gate as unknown as { state: string; context: Record<string, number>; history: unknown[] }).state = "PAID";
      (gate as unknown as { state: string; context: Record<string, number>; history: unknown[] }).context = { escrow_balance: 5000 };
      (gate as unknown as { state: string; context: Record<string, number>; history: unknown[] }).history = [];
      assert.equal(gate.getState(), "PAYMENT_PENDING");
      assert.equal(gate.getContext().escrow_balance, 0);
      const proxyVerdict = gate.step(new Proxy({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } }, {
        get() { (gate as unknown as { state: string }).state = "PAID"; throw Error("proxy read"); },
        getOwnPropertyDescriptor() { (gate as unknown as { state: string }).state = "PAID"; throw Error("proxy descriptor"); },
      }));
      assert.equal(proxyVerdict.violation?.code, "SECURITY_VIOLATION");
      assert.equal(gate.getState(), "PAYMENT_PENDING");
      assert.equal(gate.getContext().escrow_balance, 0);
      const confirmWithoutCapture = gate.step({ transitionId: "CONFIRM_PAYMENT" });
      assert.equal(confirmWithoutCapture.allowed, false);
      assert.equal(gate.getState(), "PAYMENT_PENDING");
      const firstFailure = gate.step({ transitionId: "BAD" });
      const trace = firstFailure.violation!.shortestCounterexampleTrace;
      try { (trace[0] as { action: string }).action = "CORRUPTED"; } catch { /* frozen trace is expected */ }
      const nextFailure = gate.step({ transitionId: "BAD" });
      assert.equal(nextFailure.violation?.shortestCounterexampleTrace[0]?.action, "INITIATE_PAYMENT");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("event property evaluation ignores inherited object methods", async () => {
  assert.equal(evaluate("event.toString == event.valueOf", { event: {} }), true);
  const spec: WorldSpec = { ...securityWorld, transitions: [
    { id: "CHECK", from: "CREATED", to: "PAYMENT_PENDING", guard: "event.toString == event.valueOf", directive: null, effects: [] },
  ] };
  const projection = compileWorldSpec(spec);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-own-property-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const build = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    for (const gate of [createWorldChecker(spec), new WorldChecker() as IWorldChecker]) {
      const verdict = gate.step({ transitionId: "CHECK", eventPayload: {} });
      assert.equal(verdict.allowed, true);
      assert.equal(gate.getState(), "PAYMENT_PENDING");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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

test("P0-3 reset atomicity (interpreted): bad reset preserves PAID state and blocks second payment initiate", () => {
  const gate = createWorldChecker(securityWorld, { order_amount: 5000 });
  gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } });

  assert.equal(gate.getState(), "PAID");
  assert.equal(gate.getContext().escrow_balance, 5000);

  // Attempt bad reset with invalid bounds
  assert.throws(() => gate.reset({ order_amount: 0 }), /INVALID_BOUNDS/);

  // Must remain in PAID state with intact escrow
  assert.equal(gate.getState(), "PAID", "State must remain PAID after aborted reset");
  assert.equal(gate.getContext().escrow_balance, 5000, "Escrow balance must remain 5000");

  // Second payment initiate from PAID must be refused as INVALID_TRANSITION
  const secondInitiate = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  assert.equal(secondInitiate.allowed, false);
  assert.equal(secondInitiate.violation?.code, "INVALID_TRANSITION");
  assert.equal(gate.getState(), "PAID");
});

test("P0-3 reset atomicity (compiled): bad reset preserves PAID state and blocks second payment initiate", async () => {
  const projection = compileWorldSpec(securityWorld);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-sec-test-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);

    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    const gate: IWorldChecker = new WorldChecker();
    gate.reset({ order_amount: 5000 });

    gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
    gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } });

    assert.equal(gate.getState(), "PAID");
    assert.equal(gate.getContext().escrow_balance, 5000);

    // Bad reset
    assert.throws(() => gate.reset({ order_amount: 0 }), /INVALID_BOUNDS/);

    // State remains PAID with 5000 escrow
    assert.equal(gate.getState(), "PAID");
    assert.equal(gate.getContext().escrow_balance, 5000);

    // Second initiate fails
    const secondInitiate = gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
    assert.equal(secondInitiate.allowed, false);
    assert.equal(secondInitiate.violation?.code, "INVALID_TRANSITION");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("P2 logical operators: require boolean operands without coercion on both branches", async () => {
  // Interpreter tests
  assert.throws(() => evaluate("1 && 1", {}), /expected boolean/i);
  assert.throws(() => evaluate("false && 1", {}), /expected boolean/i);
  assert.throws(() => evaluate("true || 1", {}), /expected boolean/i);
  assert.throws(() => evaluate("false => 1", {}), /expected boolean/i);
  assert.throws(() => evaluate("!1", {}), /expected boolean/i);
  assert.throws(() => evaluate("order_amount && true", { order_amount: 5000 }), /expected boolean/i);

  // Valid booleans work
  assert.equal(evaluate("true && true", {}), true);
  assert.equal(evaluate("false && true", {}), false);
  assert.equal(evaluate("false || true", {}), true);
  assert.equal(evaluate("false => true", {}), true);
  assert.equal(evaluate("!false", {}), true);

  // Test on compiled checker via transition guard
  const booleanGuardWorld: WorldSpec = {
    ...securityWorld,
    transitions: [
      { id: "TEST_OR", from: "CREATED", to: "PAYMENT_PENDING", guard: "true || 1", directive: null, effects: [] },
      { id: "TEST_IMPL", from: "CREATED", to: "PAYMENT_PENDING", guard: "false => 1", directive: null, effects: [] },
    ],
  };
  const projection = compileWorldSpec(booleanGuardWorld);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-bool-test-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);

    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    const gate: IWorldChecker = new WorldChecker();
    assert.equal(gate.step({ transitionId: "TEST_OR" }).allowed, false);
    assert.equal(gate.step({ transitionId: "TEST_IMPL" }).allowed, false);
    assert.equal(gate.getState(), "CREATED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("P1-1 initial invariant check: compiled checker constructor throws if default fails invariant", async () => {
  const failingInvariantWorld: WorldSpec = {
    ...securityWorld,
    invariants: [
      { id: "INV-FAIL-ON-BOOT", predicate: "order_amount == 0" }, // Impossible since default is 5000
    ],
  };
  const projection = compileWorldSpec(failingInvariantWorld);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-inv-boot-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);

    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    assert.throws(() => new WorldChecker(), /INITIAL_INVARIANT_FAILED: INV-FAIL-ON-BOOT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
