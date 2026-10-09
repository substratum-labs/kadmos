import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { WorldSpec } from "../src/types/world.js";
import { compileWorldSpec, compileWorldSpecPython } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";
import { runThreePaths, type ThreePathCommand, type ThreePathOutcome } from "./world_three_path_runner.js";

type Checker = {
  getState(): string;
  getContext(): Record<string, number | string>;
  step(request: unknown): { allowed: boolean; currentState: string; context: Record<string, number | string>; directiveAllowed: string | null; violation?: { code: string; shortestCounterexampleTrace: readonly unknown[] } };
  reset(context?: Record<string, unknown> | null): void;
  rollbackLastStep(): void;
};

async function runGenerated<T>(world: WorldSpec, check: (CheckerType: new (context?: Record<string, unknown> | null) => Checker, python: (script: string) => unknown) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-semantics-"));
  try {
    const ts = compileWorldSpec(world);
    const py = compileWorldSpecPython(world);
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "ports.d.ts"), ts.portsDts);
    writeFileSync(join(dir, "world_checker.ts"), ts.worldCheckerTs);
    writeFileSync(join(dir, "ports.py"), py.portsPy);
    writeFileSync(join(dir, "world_checker.py"), py.worldCheckerPy);
    const tsc = spawnSync(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"),
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--typeRoots", join(process.cwd(), "node_modules/@types"),
      "--types", "node", join(dir, "ports.d.ts"), join(dir, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
    const { WorldChecker } = await import(pathToFileURL(join(dir, "world_checker.js")).href);
    const python = (script: string): unknown => {
      const executable = process.platform === "win32" ? "python" : "python3";
      const result = spawnSync(executable, ["-B", "-c", script], { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return JSON.parse(result.stdout) as unknown;
    };
    return await check(WorldChecker as new (context?: Record<string, unknown> | null) => Checker, python);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("three checker constructors and resets preserve resolved seed and one savepoint", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "ResetSeed", states: [{ id: "START", initial: true }],
    context: { n: { type: "integer", default: 0, min: 0, max: 10 } }, invariants: [],
    transitions: [{ id: "INC", from: "START", to: "START", guard: true, directive: null, effects: ["n = n + 1"] }],
  };
  const exercise = (gate: Checker): void => {
    assert.deepEqual(gate.getContext(), { n: 2 });
    assert.throws(() => gate.rollbackLastStep(), /NO_CHECKER_SAVEPOINT/);
    assert.equal(gate.step({ transitionId: "INC" }).context.n, 3);
    const refused = gate.step({ transitionId: "BAD" });
    assert.equal(refused.violation?.code, "INVALID_TRANSITION");
    assert.equal(refused.violation?.shortestCounterexampleTrace.length, 2);
    assert.throws(() => gate.reset({ n: "bad" }), /INVALID_BOUNDS/);
    assert.equal(gate.getContext().n, 3);
    gate.rollbackLastStep();
    assert.equal(gate.getContext().n, 2);
    assert.throws(() => gate.rollbackLastStep(), /NO_CHECKER_SAVEPOINT/);
    assert.equal(gate.step({ transitionId: "INC" }).allowed, true);
    gate.reset({ n: 4 });
    assert.equal(gate.getContext().n, 4);
    gate.reset({});
    assert.equal(gate.getContext().n, 0);
    gate.reset();
    assert.equal(gate.getContext().n, 2);
    gate.reset(null);
    assert.equal(gate.getContext().n, 2);
    assert.throws(() => gate.rollbackLastStep(), /NO_CHECKER_SAVEPOINT/);
  };
  exercise(createWorldChecker(world, { n: 2 }) as Checker);
  await runGenerated(world, (WorldChecker, python) => {
    exercise(new WorldChecker({ n: 2 }));
    assert.deepEqual(python("import json\nfrom world_checker import WorldChecker\nc=WorldChecker({'n':2})\nvalues=[c.get_context()['n']]\ntry: c.rollback_last_step()\nexcept RuntimeError as e: values.append(str(e))\nc.step({'transitionId':'INC'})\ntry: c.reset({'n':'bad'})\nexcept ValueError as e: values.append(str(e).split(':')[0])\nvalues.append(c.get_context()['n'])\nc.rollback_last_step(); values.append(c.get_context()['n'])\nc.step({'transitionId':'INC'}); c.reset({'n':4}); values.append(c.get_context()['n'])\nc.reset({}); values.append(c.get_context()['n'])\nc.reset(); values.append(c.get_context()['n'])\nc.reset(None); values.append(c.get_context()['n'])\nprint(json.dumps(values))"), [2, "NO_CHECKER_SAVEPOINT", "INVALID_BOUNDS", 3, 2, 4, 0, 2, 2]);
  });
});

test("constructor and reset reject malformed top-level contexts without consuming undo", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "ContextAdmission", states: [{ id: "START", initial: true }],
    context: { n: { type: "integer", default: 0, min: 0, max: 10 } }, invariants: [],
    transitions: [{ id: "INC", from: "START", to: "START", guard: true, directive: null, effects: ["n = n + 1"] }],
  };
  const probes = [true, 1, "bad", [], new Date(), new Proxy({}, {})];
  const exercise = (construct: (arg?: unknown) => Checker) => {
    for (const bad of probes) assert.throws(() => construct(bad), /INVALID_BOUNDS/);
    assert.deepEqual(construct(null).getContext(), { n: 0 });
    const gate = construct({ n: 2 });
    gate.step({ transitionId: "INC" });
    for (const bad of probes) {
      assert.throws(() => gate.reset(bad as never), /INVALID_BOUNDS/);
      assert.equal(gate.getContext().n, 3);
    }
    let reads = 0;
    const accessor = Object.defineProperty({}, "n", { get() { reads++; return 4; }, enumerable: true });
    assert.throws(() => gate.reset(accessor), /INVALID_BOUNDS/);
    assert.equal(reads, 0);
    gate.rollbackLastStep();
    assert.equal(gate.getContext().n, 2);
  };
  exercise((arg) => createWorldChecker(world, arg as never) as Checker);
  await runGenerated(world, (WorldChecker, python) => {
    exercise((arg) => new WorldChecker(arg as never));
    assert.deepEqual(python("import json\nfrom world_checker import WorldChecker\ncodes=[]\nfor bad in [True,1,'bad',[],{'n':True}]:\n  try: WorldChecker(bad)\n  except ValueError as e: codes.append(str(e).split(':')[0])\nc=WorldChecker({'n':2}); c.step({'transitionId':'INC'})\nfor bad in [True,1,'bad',[],{'n':True}]:\n  try: c.reset(bad)\n  except ValueError as e: codes.append(str(e).split(':')[0])\nclass Sub(dict): pass\ntry: c.reset(Sub())\nexcept ValueError as e: codes.append(str(e).split(':')[0])\nc.rollback_last_step(); print(json.dumps([codes,c.get_context()['n']]))"), [Array(11).fill("INVALID_BOUNDS"), 2]);
    assert.deepEqual(python("import json\nfrom world_checker import WorldChecker\nc=WorldChecker({'n':2}); c.step({'transitionId':'INC'})\na=c.context; a['n']=9\nh=c.history; h.clear()\nblocked=[]\nfor name,value in [('state','FORGED'),('context',{}),('history',[])]:\n  try: setattr(c,name,value)\n  except AttributeError: blocked.append(name)\nbefore=[c.state,c.context['n'],len(c.history)]\nc.rollback_last_step()\nprint(json.dumps([blocked,before,[c.state,c.context['n'],len(c.history)]]))"), [["state", "context", "history"], ["START", 3, 1], ["START", 2, 0]]);
  });
});

test("three-path runner compares constructor seed and reset lifecycle to literal outcomes", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "ThreePathReset", states: [{ id: "START", initial: true }],
    context: { n: { type: "integer", default: 0 } }, invariants: [],
    transitions: [{ id: "INC", from: "START", to: "START", guard: true, directive: null, effects: ["n = n + 1"] }],
  };
  const commands: ThreePathCommand[] = [
    { kind: "step", request: { transitionId: "INC" } },
    { kind: "reset", context: { n: 4 } }, { kind: "reset", context: {} },
    { kind: "reset" }, { kind: "reset", context: null }, { kind: "rollback" },
  ];
  const expected: ThreePathOutcome["interpreted"] = { observations: [
    { kind: "step", state: "START", context: { n: 3 }, verdict: { allowed: true, previousState: "START", currentState: "START", context: { n: 3 }, directiveAllowed: null } },
    { kind: "reset", state: "START", context: { n: 4 } },
    { kind: "reset", state: "START", context: { n: 0 } },
    { kind: "reset", state: "START", context: { n: 2 } },
    { kind: "reset", state: "START", context: { n: 2 } },
    { kind: "rollback", state: "START", context: { n: 2 }, errorCode: "NO_CHECKER_SAVEPOINT" },
  ] };
  const outcome = await runThreePaths(world, commands, { n: 2 });
  assert.deepEqual(outcome.interpreted, expected);
  assert.deepEqual(outcome.emittedTs, expected);
  assert.deepEqual(outcome.emittedPy, expected);
});

test("three paths match literal ordered diagnostics and rollback history", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "TraceOracle", states: [{ id: "START", initial: true }],
    context: { n: { type: "integer", default: 2, min: 0, max: 10 } }, invariants: [],
    transitions: [
      { id: "INC", from: "START", to: "START", guard: true, directive: null, effects: ["n = n + 1"] },
      { id: "SEND", from: "START", to: "START", guard: true, directive: "SEND", effects: [] },
    ],
  };
  const acceptedRecord = { step: 1, state: "START", action: "INC", eventPayload: { tag: "x" }, proposedDirective: null };
  const outcome = await runThreePaths(world, [
    { kind: "step", request: { transitionId: "INC", eventPayload: { tag: "x" }, proposedDirective: null } },
    { kind: "step", request: { transitionId: "SEND", proposedDirective: "WRONG" } },
    { kind: "reset", context: { n: "bad" } },
    { kind: "rollback" },
    { kind: "step", request: { transitionId: "UNKNOWN" } },
  ], { n: 2 });
  const expected: ThreePathOutcome["interpreted"] = { observations: [
    { kind: "step", state: "START", context: { n: 3 }, verdict: { allowed: true, previousState: "START", currentState: "START", context: { n: 3 }, directiveAllowed: null } },
    { kind: "step", state: "START", context: { n: 3 }, verdict: { allowed: false, previousState: "START", currentState: "START", context: { n: 3 }, directiveAllowed: null, violation: { code: "UNAUTHORIZED_DIRECTIVE", message: "Directive does not match declared transition", shortestCounterexampleTrace: [acceptedRecord, { step: 2, state: "START", action: "SEND", proposedDirective: "WRONG" }] } } },
    { kind: "reset", state: "START", context: { n: 3 }, errorCode: "INVALID_BOUNDS" },
    { kind: "rollback", state: "START", context: { n: 2 } },
    { kind: "step", state: "START", context: { n: 2 }, verdict: { allowed: false, previousState: "START", currentState: "START", context: { n: 2 }, directiveAllowed: null, violation: { code: "INVALID_TRANSITION", message: "Transition 'UNKNOWN' is not legal from state 'START'", shortestCounterexampleTrace: [{ step: 1, state: "START", action: "UNKNOWN" }] } } },
  ] };
  assert.deepEqual(outcome.interpreted, expected);
  assert.deepEqual(outcome.emittedTs, expected);
  assert.deepEqual(outcome.emittedPy, expected);
});

test("three paths match literal guard, bounds, invariant, directive, and sequential-effect outcomes", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "StageOracle",
    states: [{ id: "START", initial: true }, { id: "DONE", terminal: true }],
    context: { a: { type: "integer", default: 2, max: 5 }, b: { type: "integer", default: 0, max: 10 } },
    invariants: [{ id: "ORDER", predicate: "b <= a + 1" }],
    transitions: [
      { id: "MOVE", from: "START", to: "DONE", guard: true, directive: null, effects: ["a = a + 1", "b = a + 1"] },
      { id: "SEND", from: "START", to: "DONE", guard: true, directive: "SEND", effects: [] },
      { id: "GUARD", from: "START", to: "DONE", guard: "event.ok == true", directive: null, effects: [] },
      { id: "BOUNDS", from: "START", to: "DONE", guard: true, directive: null, effects: ["a = 6"] },
      { id: "INV", from: "START", to: "DONE", guard: true, directive: null, effects: ["b = 9"] },
    ],
  };
  const prior = { a: 2, b: 0 };
  const check = async (request: Record<string, unknown>, expected: ThreePathOutcome["interpreted"]) => {
    const outcome = await runThreePaths(world, [{ kind: "step", request }]);
    assert.deepEqual(outcome.interpreted, expected);
    assert.deepEqual(outcome.emittedTs, expected);
    assert.deepEqual(outcome.emittedPy, expected);
  };
  await check({ transitionId: "MOVE" }, { observations: [{ kind: "step", state: "DONE", context: { a: 3, b: 4 }, verdict: { allowed: true, previousState: "START", currentState: "DONE", context: { a: 3, b: 4 }, directiveAllowed: null } }] });
  await check({ transitionId: "SEND", proposedDirective: "SEND" }, { observations: [{ kind: "step", state: "DONE", context: prior, verdict: { allowed: true, previousState: "START", currentState: "DONE", context: prior, directiveAllowed: "SEND" } }] });
  for (const [request, code, message, invariant] of [
    [{ transitionId: "SEND" }, "UNAUTHORIZED_DIRECTIVE", "Directive does not match declared transition", undefined],
    [{ transitionId: "GUARD" }, "GUARD_FAILED", "Guard condition failed", undefined],
    [{ transitionId: "BOUNDS" }, "INVALID_BOUNDS", "Context bound failed on 'a'", undefined],
    [{ transitionId: "INV" }, "INVARIANT_FAILED", "Invariant violation: 'ORDER'", "ORDER"],
  ] as const) {
    const violation = { code, message, ...(invariant === undefined ? {} : { violatedInvariant: invariant }), shortestCounterexampleTrace: [{ step: 1, state: "START", action: request.transitionId }] };
    await check(request, { observations: [{ kind: "step", state: "START", context: prior, verdict: { allowed: false, previousState: "START", currentState: "START", context: prior, directiveAllowed: null, violation } }] });
  }
});

test("three-path runner preserves invalid constructor and empty-World outcomes", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "EmptyOracle", states: [{ id: "START", initial: true }],
    context: {}, invariants: [], transitions: [],
  };
  const expected: ThreePathOutcome["interpreted"] = { observations: [
    { kind: "step", state: "START", context: {}, verdict: { allowed: false, previousState: "START", currentState: "START", context: {}, directiveAllowed: null, violation: { code: "INVALID_TRANSITION", message: "Transition 'UNKNOWN' is not legal from state 'START'", shortestCounterexampleTrace: [{ step: 1, state: "START", action: "UNKNOWN" }] } } },
  ] };
  const good = await runThreePaths(world, [{ kind: "step", request: { transitionId: "UNKNOWN" } }]);
  assert.deepEqual(good.interpreted, expected);
  assert.deepEqual(good.emittedTs, expected);
  assert.deepEqual(good.emittedPy, expected);
  for (const bad of [true, 1, "bad", [], { n: true }]) {
    const outcome = await runThreePaths(world, [], bad);
    const refused = { constructionError: "INVALID_BOUNDS", observations: [] };
    assert.deepEqual(outcome.interpreted, refused);
    assert.deepEqual(outcome.emittedTs, refused);
    assert.deepEqual(outcome.emittedPy, refused);
  }
});

const sequentialWorld: WorldSpec = {
  version: "kadmos.world.v0", name: "SequentialEffects",
  states: [{ id: "START", initial: true }, { id: "DONE", terminal: true }, { id: "SENT", terminal: true }],
  context: {
    a: { type: "integer", min: 0, max: 10, default: 2 },
    b: { type: "integer", min: 0, max: 10, default: 0 },
    label: { type: "string", default: "start" },
  },
  invariants: [{ id: "ORDER", predicate: "b <= a + 1" }],
  transitions: [
    { id: "MOVE", from: "START", to: "DONE", guard: true, directive: null, effects: ["a = a + 1", "b = a + 1", "label = state"] },
    { id: "SEND", from: "START", to: "SENT", guard: true, directive: "SEND", effects: [] },
  ],
};

test("emitted checkers apply ordered effects and keep accepted history after refusal", async () => {
  await runGenerated(sequentialWorld, (WorldChecker, python) => {
    const gate = new WorldChecker();
    const accepted = gate.step({ transitionId: "MOVE" });
    assert.equal(accepted.allowed, true);
    assert.deepEqual(accepted.context, { a: 3, b: 4, label: "DONE" });
    assert.equal(accepted.directiveAllowed, null);
    const refused = gate.step({ transitionId: "MOVE" });
    assert.equal(refused.violation?.code, "ILLEGAL_TRANSITION");
    assert.equal(refused.violation.shortestCounterexampleTrace.length, 2);
    assert.equal(gate.getState(), "DONE");
    assert.throws(() => gate.reset({ a: 11 }), /INVALID_BOUNDS/);
    assert.equal(gate.getState(), "DONE");
    gate.rollbackLastStep();
    assert.equal(gate.getState(), "START");
    assert.deepEqual(gate.getContext(), { a: 2, b: 0, label: "start" });
    assert.throws(() => gate.rollbackLastStep(), /NO_CHECKER_SAVEPOINT/);
    assert.deepEqual(python(`import json
from world_checker import WorldChecker
c = WorldChecker()
yes = c.step({"transitionId":"MOVE"})
no = c.step({"transitionId":"MOVE"})
try:
    c.reset({"a":11})
except ValueError as e:
    reset_error = str(e).split(":")[0]
print(json.dumps({"allowed":yes["allowed"],"context":yes["context"],"directive":yes["directiveAllowed"],"refusal":no["violation"]["code"],"trace":len(no["violation"]["shortestCounterexampleTrace"]),"state":c.get_state(),"reset_error":reset_error,"public_rollback":hasattr(c,"rollback_last_step")}))`), {
      allowed: true, context: { a: 3, b: 4, label: "DONE" }, directive: null,
      refusal: "ILLEGAL_TRANSITION", trace: 2, state: "DONE", reset_error: "INVALID_BOUNDS", public_rollback: true,
    });
  });
});

const admissionWorld: WorldSpec = {
  version: "kadmos.world.v0", name: "Admission",
  states: [{ id: "START", initial: true }, { id: "DONE", terminal: true }],
  context: { a: { type: "integer", min: 0, max: 10, default: 0 } },
  invariants: [{ id: "NONNEGATIVE", predicate: "a >= 0" }],
  transitions: [{ id: "APPLY", from: "START", to: "DONE", guard: "event.ok == true", directive: null, effects: ["a = event.value"] }],
};

test("payload primitives are copied while integer effects and reset enforce type and bounds", async () => {
  await runGenerated(admissionWorld, (WorldChecker, python) => {
    const gate = new WorldChecker();
    for (const value of [true, "3", 3.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = gate.step({ transitionId: "APPLY", eventPayload: { ok: true, value } });
      assert.equal(result.violation?.code, "INVALID_EFFECT");
      assert.equal(gate.getState(), "START");
    }
    assert.equal(gate.step({ transitionId: "APPLY", eventPayload: { ok: true, value: 11 } }).violation?.code, "INVALID_BOUNDS");
    assert.equal(gate.step({ transitionId: "APPLY", eventPayload: { ok: true, value: -1 } }).violation?.code, "INVALID_BOUNDS");
    assert.equal(gate.step({ transitionId: "APPLY", eventPayload: { ok: false, value: 2 } }).violation?.code, "GUARD_FAILED");
    assert.equal(gate.step({ transitionId: 7 }).violation?.code, "SECURITY_VIOLATION");
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const payload = Object.defineProperty({ ok: true, value: 3 }, key, { value: 1, enumerable: true });
      assert.equal(gate.step({ transitionId: "APPLY", eventPayload: payload }).violation?.code, "SECURITY_VIOLATION");
    }
    assert.throws(() => gate.reset({ a: true }), /INVALID_BOUNDS/);
    assert.throws(() => gate.reset({ a: -1 }), /INVALID_BOUNDS/);
    assert.equal(gate.step({ transitionId: "APPLY", eventPayload: { ok: true, value: 4 } }).allowed, true);
    assert.deepEqual(python(`import json
from world_checker import WorldChecker
c = WorldChecker()
codes = [c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":v}})["violation"]["code"] for v in [True,"3",3.5,9007199254740992]]
codes.append(c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":11}})["violation"]["code"])
codes.append(c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":-1}})["violation"]["code"])
codes.append(c.step({"transitionId":"APPLY","eventPayload":{"ok":False,"value":2}})["violation"]["code"])
codes.append(c.step({"transitionId":7})["violation"]["code"])
codes.extend(c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":3,k:1}})["violation"]["code"] for k in ["__proto__","constructor","prototype"])
try:
    c.reset({"a":True})
except ValueError as e:
    reset_error = str(e).split(":")[0]
try:
    c.reset({"a":-1})
except ValueError as e:
    min_error = str(e).split(":")[0]
yes = c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":4}})
print(json.dumps({"codes":codes,"reset_error":reset_error,"min_error":min_error,"allowed":yes["allowed"],"context":yes["context"]}))`), {
      codes: ["INVALID_EFFECT", "INVALID_EFFECT", "INVALID_EFFECT", "INVALID_EFFECT", "INVALID_BOUNDS", "INVALID_BOUNDS", "GUARD_FAILED", "SECURITY_VIOLATION", "SECURITY_VIOLATION", "SECURITY_VIOLATION", "SECURITY_VIOLATION"],
      reset_error: "INVALID_BOUNDS", min_error: "INVALID_BOUNDS", allowed: true, context: { a: 4 },
    });
  });
});

test("omitted World directive is canonical null while named directives remain strict", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "OmittedWorldDirective",
    states: [{ id: "START", initial: true }, { id: "DONE" }, { id: "SENT" }],
    context: {}, invariants: [{ id: "KNOWN_STATE", predicate: "state == 'START' || state == 'DONE' || state == 'SENT'" }],
    transitions: [
      { id: "GO", from: "START", to: "DONE", guard: true, effects: [] } as unknown as WorldSpec["transitions"][number],
      { id: "SEND", from: "START", to: "SENT", guard: true, directive: "SEND", effects: [] },
    ],
  };
  await runGenerated(world, (WorldChecker, python) => {
    const gate = new WorldChecker();
    assert.equal(gate.step({ transitionId: "GO" }).allowed, true);
    assert.equal(gate.getState(), "DONE");
    gate.reset();
    assert.equal(gate.step({ transitionId: "SEND" }).violation?.code, "UNAUTHORIZED_DIRECTIVE");
    assert.equal(gate.step({ transitionId: "SEND", proposedDirective: "SEND" }).allowed, true);
    assert.deepEqual(python("import json\nfrom world_checker import WorldChecker\nc=WorldChecker()\na=c.step({'transitionId':'GO'})\nc.reset()\nb=c.step({'transitionId':'SEND'})\nd=c.step({'transitionId':'SEND','proposedDirective':'SEND'})\nprint(json.dumps([a['allowed'],b['violation']['code'],d['allowed']]))"), [true, "UNAUTHORIZED_DIRECTIVE", true]);
  });
});

test("generated expressions distinguish null property access and nonfinite operations", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "ExpressionEdges",
    states: [{ id: "START", initial: true }, { id: "DONE" }],
    context: { a: { type: "integer", default: 0, min: 0, max: 10 } }, invariants: [{ id: "NONNEGATIVE", predicate: "a >= 0" }],
    transitions: [
      { id: "NULL_PROPERTY", from: "START", to: "DONE", guard: "event.flag.x == null", directive: null, effects: [] },
      { id: "INFINITE_EQUALITY", from: "START", to: "DONE", guard: "1 / 0 == 1 / 0", directive: null, effects: [] },
      { id: "INFINITE_ORDER", from: "START", to: "DONE", guard: "1 / 0 > 1", directive: null, effects: [] },
      { id: "EAGER_OR", from: "START", to: "DONE", guard: "true || (1 / 0 > 1)", directive: null, effects: [] },
      { id: "INFINITE_EFFECT", from: "START", to: "DONE", guard: true, directive: null, effects: ["a = 1 / 0"] },
    ],
  };
  await runGenerated(world, (WorldChecker, python) => {
    const step = (id: string, payload?: object) => new WorldChecker().step({ transitionId: id, ...(payload ? { eventPayload: payload } : {}) });
    assert.equal(step("NULL_PROPERTY", { flag: false }).allowed, true);
    assert.equal(step("INFINITE_EQUALITY").allowed, true);
    assert.equal(step("INFINITE_ORDER").violation?.code, "GUARD_FAILED");
    assert.equal(step("EAGER_OR").violation?.code, "GUARD_FAILED");
    assert.equal(step("INFINITE_EFFECT").violation?.code, "INVALID_EFFECT");
    assert.deepEqual(python(`import json
from world_checker import WorldChecker
def step(name, payload=None):
    request = {"transitionId":name}
    if payload is not None: request["eventPayload"] = payload
    return WorldChecker().step(request)
print(json.dumps([step("NULL_PROPERTY", {"flag":False})["allowed"],step("INFINITE_EQUALITY")["allowed"],step("INFINITE_ORDER")["violation"]["code"],step("EAGER_OR")["violation"]["code"],step("INFINITE_EFFECT")["violation"]["code"]]))`), [true, true, "GUARD_FAILED", "GUARD_FAILED", "INVALID_EFFECT"]);
  });
});
