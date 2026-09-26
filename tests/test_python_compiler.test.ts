import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileWorldSpecPython, parseWorldSpec } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";

const yaml = readFileSync(new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url), "utf8");
const world = parseWorldSpec(yaml);
const run = (args: string[], cwd?: string) => spawnSync("python3", args, { cwd, encoding: "utf8" });

test("Python compiler emits importable, syntax-valid, dependency-free gatekeeper", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-"));
  try {
    const { portsPy, worldCheckerPy } = compileWorldSpecPython(world);
    assert.match(portsPy, /class IWorldChecker\(Protocol\)/);
    assert.match(portsPy, /WorldState = Literal\[/);
    assert.doesNotMatch(worldCheckerPy, /\b(?:eval|exec)\s*\(/);
    writeFileSync(join(dir, "ports.py"), portsPy);
    writeFileSync(join(dir, "world_checker.py"), worldCheckerPy);
    const syntax = run(["-m", "py_compile", "ports.py", "world_checker.py"], dir);
    assert.equal(syntax.status, 0, syntax.stderr);
    const script = `from world_checker import WorldChecker, sanitize_world_payload, evaluate_world
import json
c = WorldChecker()
results = []
for request in [
    {'transitionId':'DISPATCH_GOODS'},
    {'transitionId':'INITIATE_PAYMENT'},
    {'transitionId':'INITIATE_PAYMENT','proposedDirective':'DISPATCH_PAYMENT_GATEWAY'},
    {'transitionId':'CONFIRM_PAYMENT','eventPayload':{'captured_amount':4999}},
    {'transitionId':'CONFIRM_PAYMENT','eventPayload':{'captured_amount':5000}},
    {'transitionId':'DISPATCH_GOODS','proposedDirective':'INVOKE_LOGISTICS_DISPATCH'},
]:
    results.append(c.step(request))
assert results[0]['violation']['code'] == 'INVALID_TRANSITION'
assert len(results[0]['violation']['shortestCounterexampleTrace']) == 1
assert results[1]['violation']['code'] == 'UNAUTHORIZED_DIRECTIVE'
assert results[3]['violation']['code'] == 'GUARD_FAILED'
assert results[4]['allowed'] and results[5]['allowed']
assert c.get_state() == 'FULFILLED' and c.get_context()['settled_amount'] == 5000
try:
    c.reset({'order_amount':0})
    assert False
except ValueError as e:
    assert str(e).startswith('INVALID_BOUNDS:')
assert c.get_state() == 'FULFILLED'
c.reset()
c._busy = True
try:
    c.step({'transitionId':'INITIATE_PAYMENT'})
    assert False
except RuntimeError as e:
    assert str(e).startswith('REENTRANCY_DETECTED:')
c._busy = False
class Hostile:
    @property
    def value(self):
        raise RuntimeError('accessed')
for bad in [lambda: None, Hostile(), {'callback': lambda: None}]:
    verdict = c.step({'transitionId':'INITIATE_PAYMENT','eventPayload':bad,'proposedDirective':'DISPATCH_PAYMENT_GATEWAY'})
    assert verdict['violation']['code'] == 'SECURITY_VIOLATION'
assert c.get_state() == 'CREATED'
assert evaluate_world('1 + 2 * 3 == 7 && !false', {}) is True
assert evaluate_world('event.nested.value == 3', {'event': {'nested': {'value': 3}}}) is True
for expression in ['1 && true', 'true + 1', 'true > 0']:
    try:
        evaluate_world(expression, {})
        assert False
    except ValueError:
        pass
print(json.dumps(results))`;
    writeFileSync(join(dir, "check.py"), script);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
    const actual = JSON.parse(py.stdout);
    const ts = createWorldChecker(world);
    const requests = [
      { transitionId: "DISPATCH_GOODS" },
      { transitionId: "INITIATE_PAYMENT" },
      { transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" },
      { transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 4999 } },
      { transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } },
      { transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" },
    ];
    const expected = requests.map(request => ts.step(request));
    for (let i = 0; i < expected.length; i++) {
      assert.equal(actual[i].allowed, expected[i]!.allowed);
      assert.equal(actual[i].currentState, expected[i]!.currentState);
      assert.deepEqual(actual[i].context, expected[i]!.context);
      assert.equal(actual[i].directiveAllowed, expected[i]!.directiveAllowed);
      assert.equal(actual[i].violation?.code, expected[i]!.violation?.code);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI --lang all emits all four projections", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-all-"));
  try {
    const input = join(dir, "world.yaml");
    writeFileSync(input, yaml);
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", dir, "--lang", "all"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["ports.d.ts", "world_checker.ts", "ports.py", "world_checker.py"]) assert.ok(readFileSync(join(dir, name), "utf8").length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python gatekeeper rejects bound and invariant failures without committing effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-fail-"));
  try {
    const spec = {
      version: "kadmos.world.v0" as const,
      name: "RollbackWorld",
      states: [{ id: "START", initial: true }, { id: "DONE", terminal: true }],
      context: { amount: { type: "integer" as const, min: 0, max: 10, default: 5 } },
      invariants: [{ id: "INV-POSITIVE", predicate: "state == 'DONE' => amount > 0" }],
      transitions: [
        { id: "BOUND", from: "START", to: "DONE", guard: true, directive: null, effects: ["amount = 11"] },
        { id: "INVARIANT", from: "START", to: "DONE", guard: true, directive: null, effects: ["amount = 0"] },
        { id: "SUCCESS", from: "START", to: "DONE", guard: true, directive: null, effects: ["amount = 7"] },
      ],
    };
    const projection = compileWorldSpecPython(spec);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `from world_checker import WorldChecker\nc = WorldChecker()\nfor action, code in [('BOUND', 'INVALID_BOUNDS'), ('INVARIANT', 'INVARIANT_FAILED')]:\n    result = c.step({'transitionId': action})\n    assert result['violation']['code'] == code\n    assert len(result['violation']['shortestCounterexampleTrace']) == 1\n    assert c.get_state() == 'START' and c.get_context() == {'amount': 5}\nassert c.step({'transitionId':'SUCCESS'})['allowed']\nassert c.get_context() == {'amount': 7}\ntry:\n    c.reset({'amount': 11})\n    assert False\nexcept ValueError as error:\n    assert str(error).startswith('INVALID_BOUNDS:')\nassert c.get_state() == 'DONE' and c.get_context() == {'amount': 7}\n`);
    const result = run(["check.py"], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI language selection writes only requested projections", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-lang-"));
  try {
    const input = join(dir, "world.yaml");
    writeFileSync(input, yaml);
    for (const [language, expected] of [["python", ["ports.py", "world_checker.py"]], ["ts", ["ports.d.ts", "world_checker.ts"]]] as const) {
      const out = join(dir, language);
      const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", out, "--lang", language], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      for (const name of expected) assert.ok(readFileSync(join(out, name), "utf8").length);
      const excluded = language === "python" ? "ports.d.ts" : "ports.py";
      assert.throws(() => readFileSync(join(out, excluded), "utf8"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
