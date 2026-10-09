import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { WorldSpec } from "../src/types/world.js";
import { compileWorldSpec, compileWorldSpecPython } from "../src/world_compiler.js";

type Checker = {
  getState(): string;
  getContext(): Record<string, number | string>;
  step(request: unknown): { allowed: boolean; currentState: string; context: Record<string, number | string>; directiveAllowed: string | null; violation?: { code: string; shortestCounterexampleTrace: readonly unknown[] } };
  reset(context?: Record<string, unknown>): void;
  rollbackLastStep(): void;
};

async function runGenerated<T>(world: WorldSpec, check: (CheckerType: new () => Checker, python: (script: string, expectedFailure?: RegExp) => unknown) => T | Promise<T>, expectedCompileError?: RegExp): Promise<T> {
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
    if (expectedCompileError) {
      assert.notEqual(tsc.status, 0, "omitted World directive currently fails emitted TS typecheck");
      assert.match(`${tsc.stdout}\n${tsc.stderr}`, expectedCompileError);
    } else {
      assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
    }
    const { WorldChecker } = await import(pathToFileURL(join(dir, "world_checker.js")).href);
    const python = (script: string, expectedFailure?: RegExp): unknown => {
      const executable = process.platform === "win32" ? "python" : "python3";
      const result = spawnSync(executable, ["-B", "-c", script], { cwd: dir, encoding: "utf8" });
      if (expectedFailure) {
        assert.notEqual(result.status, 0, "expected generated Python import to fail");
        assert.match(result.stderr, expectedFailure);
        return null;
      }
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return JSON.parse(result.stdout) as unknown;
    };
    return await check(WorldChecker as new () => Checker, python);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      refusal: "ILLEGAL_TRANSITION", trace: 2, state: "DONE", reset_error: "INVALID_BOUNDS", public_rollback: false,
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
    assert.equal(gate.step({ transitionId: "APPLY", eventPayload: { ok: false, value: 2 } }).violation?.code, "GUARD_FAILED");
    assert.equal(gate.step({ transitionId: 7 }).violation?.code, "SECURITY_VIOLATION");
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const payload = Object.defineProperty({ ok: true, value: 3 }, key, { value: 1, enumerable: true });
      assert.equal(gate.step({ transitionId: "APPLY", eventPayload: payload }).violation?.code, "SECURITY_VIOLATION");
    }
    assert.throws(() => gate.reset({ a: true }), /INVALID_BOUNDS/);
    assert.equal(gate.step({ transitionId: "APPLY", eventPayload: { ok: true, value: 4 } }).allowed, true);
    assert.deepEqual(python(`import json
from world_checker import WorldChecker
c = WorldChecker()
codes = [c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":v}})["violation"]["code"] for v in [True,"3",3.5,9007199254740992]]
codes.append(c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":11}})["violation"]["code"])
codes.append(c.step({"transitionId":"APPLY","eventPayload":{"ok":False,"value":2}})["violation"]["code"])
codes.append(c.step({"transitionId":7})["violation"]["code"])
codes.extend(c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":3,k:1}})["violation"]["code"] for k in ["__proto__","constructor","prototype"])
try:
    c.reset({"a":True})
except ValueError as e:
    reset_error = str(e).split(":")[0]
yes = c.step({"transitionId":"APPLY","eventPayload":{"ok":True,"value":4}})
print(json.dumps({"codes":codes,"reset_error":reset_error,"allowed":yes["allowed"],"context":yes["context"]}))`), {
      codes: ["INVALID_EFFECT", "INVALID_EFFECT", "INVALID_EFFECT", "INVALID_EFFECT", "INVALID_BOUNDS", "GUARD_FAILED", "SECURITY_VIOLATION", "SECURITY_VIOLATION", "SECURITY_VIOLATION", "SECURITY_VIOLATION"],
      reset_error: "INVALID_BOUNDS", allowed: true, context: { a: 4 },
    });
  });
});

test("omitted World directive differs from an omitted request directive", async () => {
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
    assert.equal(gate.step({ transitionId: "GO" }).violation?.code, "UNAUTHORIZED_DIRECTIVE");
    assert.equal(gate.getState(), "START");
    assert.equal(gate.step({ transitionId: "SEND" }).violation?.code, "UNAUTHORIZED_DIRECTIVE");
    assert.equal(gate.step({ transitionId: "SEND", proposedDirective: "SEND" }).allowed, true);
    assert.equal(python("from world_checker import WorldChecker", /SyntaxError: invalid syntax/), null);
  }, /Property 'directive' does not exist/);
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
      { id: "INFINITE_EFFECT", from: "START", to: "DONE", guard: true, directive: null, effects: ["a = 1 / 0"] },
    ],
  };
  await runGenerated(world, (WorldChecker, python) => {
    const step = (id: string, payload?: object) => new WorldChecker().step({ transitionId: id, ...(payload ? { eventPayload: payload } : {}) });
    assert.equal(step("NULL_PROPERTY", { flag: false }).allowed, true);
    assert.equal(step("INFINITE_EQUALITY").allowed, true);
    assert.equal(step("INFINITE_ORDER").violation?.code, "GUARD_FAILED");
    assert.equal(step("INFINITE_EFFECT").violation?.code, "INVALID_EFFECT");
    assert.deepEqual(python(`import json
from world_checker import WorldChecker
def step(name, payload=None):
    request = {"transitionId":name}
    if payload is not None: request["eventPayload"] = payload
    return WorldChecker().step(request)
print(json.dumps([step("NULL_PROPERTY", {"flag":False})["allowed"],step("INFINITE_EQUALITY")["allowed"],step("INFINITE_ORDER")["violation"]["code"],step("INFINITE_EFFECT")["violation"]["code"]]))`), [true, true, "GUARD_FAILED", "INVALID_EFFECT"]);
  });
});
