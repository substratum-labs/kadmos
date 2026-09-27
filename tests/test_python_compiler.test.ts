import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileWorldSpecPython, parseWorldSpec } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";
import { evaluate } from "../src/world_expression.js";

const yaml = readFileSync(new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url), "utf8");
const world = parseWorldSpec(yaml);
const run = (args: string[], cwd?: string) => spawnSync("python3", args, { cwd, encoding: "utf8" });

test("Python constructor rejects pair iterables before collision hooks and keeps World tables frozen", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-constructor-collision-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `import copy
import world_checker as module
from world_checker import WorldChecker

class Collision:
    def __init__(self):
        self.calls = 0
    def __hash__(self):
        return hash('order_amount')
    def __eq__(self, other):
        self.calls += 1
        try:
            module._DEFAULTS['order_amount'] = 1
        except TypeError:
            pass
        try:
            module._WORLD['transitions'].append({'id': 'GIFT', 'from': 'CREATED', 'to': 'PAID', 'directive': None, 'guard': True, 'effects': []})
        except AttributeError:
            pass
        return False

key = Collision()
try:
    WorldChecker([(key, 0), ('order_amount', 5000)])
    assert False, 'constructor accepted pair iterable'
except ValueError as error:
    assert 'INVALID_BOUNDS' in str(error), error
assert key.calls == 0

class Custom(dict):
    pass
try:
    WorldChecker(Custom(order_amount=5000))
    assert False, 'constructor accepted custom mapping'
except ValueError as error:
    assert 'INVALID_BOUNDS' in str(error), error

assert module._DEFAULTS['order_amount'] == 5000
assert all(t['id'] != 'GIFT' for t in module._WORLD['transitions'])
try:
    module._DEFAULTS['order_amount'] = 1
    assert False, 'defaults are mutable'
except TypeError:
    pass
try:
    module._WORLD['transitions'].append({'id': 'GIFT'})
    assert False, 'transitions are mutable'
except AttributeError:
    pass
try:
    module._WORLD['context']['order_amount']['default'] = 1
    assert False, 'nested World definition is mutable'
except TypeError:
    pass
checker = WorldChecker()
assert checker.get_state() == 'CREATED'
assert checker.get_context()['order_amount'] == 5000
assert checker.step({'transitionId': 'GIFT'})['violation']['code'] == 'INVALID_TRANSITION'
assert checker.step({'transitionId': 'INITIATE_PAYMENT', 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY'})['allowed']
before = (checker.get_state(), checker.get_context(), copy.deepcopy(checker.history))
reset_key = Collision()
try:
    checker.reset([(reset_key, 0)])
    assert False, 'reset accepted pair iterable'
except ValueError as error:
    assert 'INVALID_BOUNDS' in str(error), error
assert reset_key.calls == 0
assert (checker.get_state(), checker.get_context(), checker.history) == before
assert module._DEFAULTS['order_amount'] == 5000
assert all(t['id'] != 'GIFT' for t in module._WORLD['transitions'])
`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python plain dict collision keys cannot mutate admission, reset, or history", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-collision-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `import copy
import world_checker as module
from world_checker import WorldChecker
c = WorldChecker()
assert c.step({'transitionId': 'INITIATE_PAYMENT', 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY'})['allowed']
before = (c.state, copy.deepcopy(c.context), copy.deepcopy(c.history))
class Collision:
    def __init__(self, target, raises=True):
        self.target, self.raises, self.armed = target, raises, False
        self.calls = 0
    def __hash__(self):
        return hash(self.target)
    def __eq__(self, other):
        if self.armed:
            self.calls += 1
            c.state = 'PAID'
            c.context['escrow_balance'] = 5000
            if self.raises:
                c.history.clear()
            else:
                c.history.append({'step': 999, 'state': 'PAID', 'action': 'DISPATCH_GOODS'})
            if self.raises:
                raise RuntimeError('hostile equality')
        return False
def hostile_request(target, raises=True):
    key = Collision(target, raises)
    request = {key: 'ignored'}
    request.update({'transitionId': 'CONFIRM_PAYMENT', 'proposedDirective': None, 'eventPayload': {'captured_amount': 5000}})
    assert type(request) is dict
    key.armed = True
    return request, key
for target in ('transitionId', 'proposedDirective', 'eventPayload'):
    request, key = hostile_request(target)
    try:
        verdict = c.step(request)
        assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
    except RuntimeError as error:
        assert 'hostile equality' in str(error), error
    assert (c.state, c.context, c.history) == before, target
    assert key.calls == 0, target
    denied = c.step({'transitionId': 'DISPATCH_GOODS', 'proposedDirective': 'INVOKE_LOGISTICS_DISPATCH'})
    assert not denied['allowed'] and (c.state, c.context, c.history) == before
key = Collision('escrow_balance')
initial_context = {key: 1}
initial_context['escrow_balance'] = 5000
key.armed = True
try:
    c.reset(initial_context)
    assert False, 'reset accepted hostile key'
except ValueError as error:
    assert str(error).startswith('INVALID_BOUNDS:'), error
except RuntimeError as error:
    assert 'hostile equality' in str(error), error
assert (c.state, c.context, c.history) == before
assert key.calls == 0
key = Collision('proposedDirective', False)
probe = {key: None}
key.armed = True
original = module.evaluate_world
def mutating_evaluation(expression, environment):
    probe.get('proposedDirective')
    return original(expression, environment)
module.evaluate_world = mutating_evaluation
verdict = c.step({'transitionId': 'CONFIRM_PAYMENT', 'eventPayload': {'captured_amount': 5000}})
module.evaluate_world = original
assert verdict['allowed'], verdict
assert key.calls > 0
assert len(c.history) == len(before[2]) + 1
assert c.history[:-1] == before[2]
assert c.history[-1]['action'] == 'CONFIRM_PAYMENT'
trace = c.step({'transitionId': 'BAD'})['violation']['shortestCounterexampleTrace']
assert trace[:-1] == c.history
`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python rejects hostile request values and restores every machine field", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-hostile-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `import copy
import world_checker as module
c = module.WorldChecker()
assert c.step({'transitionId': 'INITIATE_PAYMENT', 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY'})['allowed']
before = (c.state, copy.deepcopy(c.context), copy.deepcopy(c.history))
class Hostile:
    def __str__(self):
        c.state = 'PAID'
        c.context['escrow_balance'] = 5000
        c.history.clear()
        return 'CONFIRM_PAYMENT'
verdict = c.step({'transitionId': Hostile(), 'eventPayload': {'captured_amount': 5000}})
assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
assert verdict['violation']['shortestCounterexampleTrace'][-1]['action'] == '<invalid>', verdict
assert (c.state, c.context, c.history) == before
class HostileDict(dict):
    def get(self, key, default=None):
        c.state = 'PAID'
        c.context['escrow_balance'] = 5000
        c.history.clear()
        return super().get(key, default)
verdict = c.step(HostileDict(transitionId='CONFIRM_PAYMENT', eventPayload={'captured_amount': 5000}))
assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
assert (c.state, c.context, c.history) == before
original = module.sanitize_world_payload
def mutating_reject(payload):
    c.state = 'PAID'
    c.context['escrow_balance'] = 5000
    c.history.clear()
    raise ValueError('hostile payload')
module.sanitize_world_payload = mutating_reject
verdict = c.step({'transitionId': 'CONFIRM_PAYMENT', 'eventPayload': {'captured_amount': 5000}})
assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
assert (c.state, c.context, c.history) == before
module.sanitize_world_payload = original
verdict = c.step({'transitionId': 'CONFIRM_PAYMENT'})
assert not verdict['allowed'] and (c.state, c.context, c.history) == before
`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python request snapshot, shared graph, and trace isolation fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-snapshot-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `from world_checker import WorldChecker
c = WorldChecker()
class Hostile(dict):
    def get(self, key, default=None):
        if key == 'eventPayload':
            self['proposedDirective'] = 'DISPATCH_PAYMENT_GATEWAY'
        return super().get(key, default)
request = Hostile(transitionId='INITIATE_PAYMENT', proposedDirective='WRONG', eventPayload={})
verdict = c.step(request)
assert not verdict['allowed'] and verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
assert c.get_state() == 'CREATED'
for request in ({'transitionId': object()}, {'transitionId': 'INITIATE_PAYMENT', 'proposedDirective': object()}):
    verdict = c.step(request)
    assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
shared = {}
verdict = c.step({'transitionId': 'INITIATE_PAYMENT', 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY', 'eventPayload': {'left': shared, 'right': shared}})
assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
assert 'cyclic or shared object graph' in verdict['violation']['message']
assert c.step({'transitionId': 'INITIATE_PAYMENT', 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY'})['allowed']
first = c.step({'transitionId': 'BAD'})
first['violation']['shortestCounterexampleTrace'][0]['action'] = 'CORRUPTED'
second = c.step({'transitionId': 'BAD'})
assert second['violation']['shortestCounterexampleTrace'][0]['action'] == 'INITIATE_PAYMENT', second
`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python payload boundary rejects reserved keys and depth, and converts numbers to float64", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-boundary-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `import math
from world_checker import WorldChecker, evaluate_world, sanitize_world_payload
c = WorldChecker()
for key in ('__proto__', 'constructor', 'prototype'):
    verdict = c.step({'transitionId': 'INITIATE_PAYMENT', 'eventPayload': {key: {'captured_amount': 5000}}, 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY'})
    assert verdict['violation']['code'] == 'SECURITY_VIOLATION', (key, verdict)
    assert verdict['currentState'] == 'CREATED' and c.get_state() == 'CREATED'
assert evaluate_world('event.toString == event.valueOf', {'event': {}}) is True
positive = sanitize_world_payload({'value': 10**400})['value']
negative = sanitize_world_payload({'value': -(10**400)})['value']
assert type(positive) is float and math.isinf(positive) and positive > 0
assert type(negative) is float and math.isinf(negative) and negative < 0
assert math.isnan(sanitize_world_payload({'value': float('nan')})['value'])
deep = {}
cursor = deep
for _ in range(1200):
    cursor['child'] = {}
    cursor = cursor['child']
verdict = c.step({'transitionId': 'INITIATE_PAYMENT', 'eventPayload': deep, 'proposedDirective': 'DISPATCH_PAYMENT_GATEWAY'})
assert verdict['violation']['code'] == 'SECURITY_VIOLATION', verdict
assert verdict['currentState'] == 'CREATED' and c.get_state() == 'CREATED'
assert len(verdict['violation']['shortestCounterexampleTrace']) == 1
`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test("CLI compile publishes a complete projection directory and preserves unrelated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-publish-"));
  try {
    const input = join(dir, "world.yaml");
    const out = join(dir, "projection");
    writeFileSync(input, yaml);
    const first = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", out, "--lang", "python"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(out, "notes.txt"), "keep");
    const second = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", out, "--lang", "all"], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(out, "notes.txt"), "utf8"), "keep");
    assert.deepEqual(readdirSync(out).sort(), ["notes.txt", "ports.d.ts", "ports.py", "world_checker.py", "world_checker.ts"]);
    assert.deepEqual(readdirSync(dir).sort(), ["projection", "world.yaml"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI compile replaces projection symlinks and removes projections from the other language", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-publish-clean-"));
  try {
    const input = join(dir, "world.yaml");
    const out = join(dir, "projection");
    const outside = join(dir, "outside.txt");
    writeFileSync(input, yaml);
    writeFileSync(outside, "untouched");
    const compile = (lang: string) => spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", out, "--lang", lang], { encoding: "utf8" });
    assert.equal(compile("all").status, 0);
    writeFileSync(join(out, "notes.txt"), "keep");
    rmSync(join(out, "ports.py"));
    symlinkSync(outside, join(out, "ports.py"));
    rmSync(join(out, "ports.d.ts"));
    symlinkSync(outside, join(out, "ports.d.ts"));
    const python = compile("python");
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(readdirSync(out).sort(), ["notes.txt", "ports.py", "world_checker.py"]);
    assert.equal(lstatSync(join(out, "ports.py")).isSymbolicLink(), false);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    assert.equal(readFileSync(join(out, "notes.txt"), "utf8"), "keep");
    rmSync(join(out, "world_checker.py"));
    symlinkSync(outside, join(out, "world_checker.py"));
    symlinkSync(outside, join(out, "ports.d.ts"));
    const ts = compile("ts");
    assert.equal(ts.status, 0, ts.stderr);
    assert.deepEqual(readdirSync(out).sort(), ["notes.txt", "ports.d.ts", "world_checker.ts"]);
    assert.equal(lstatSync(join(out, "ports.d.ts")).isSymbolicLink(), false);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    assert.ok(existsSync(join(out, "ports.d.ts")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI compile replaces a linked output directory without modifying its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-publish-dir-link-"));
  try {
    const input = join(dir, "world.yaml");
    const project = join(dir, "project");
    const out = join(project, "out");
    const outside = join(dir, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(input, yaml);
    writeFileSync(join(outside, "sentinel.txt"), "untouched");
    writeFileSync(join(outside, "world_checker.ts"), "external TypeScript");
    symlinkSync(outside, out, "dir");
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", out, "--lang", "python"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "untouched");
    assert.equal(readFileSync(join(outside, "world_checker.ts"), "utf8"), "external TypeScript");
    assert.deepEqual(readdirSync(outside).sort(), ["sentinel.txt", "world_checker.ts"]);
    assert.equal(lstatSync(out).isDirectory(), true);
    assert.equal(lstatSync(out).isSymbolicLink(), false);
    assert.deepEqual(readdirSync(out).sort(), ["ports.py", "world_checker.py"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python expression evaluator uses JavaScript double precision for numeric operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-numbers-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    const cases = [
      { expression: "9007199254740993 == 9007199254740992", environment: {}, expected: true },
      { expression: "1/0 == 1/0", environment: {}, expected: true },
      { expression: "amount * amount > 9223372030926249000", environment: { amount: 3037000499 }, expected: false },
      { expression: "0/0 != 0/0", environment: {}, expected: true },
    ];
    writeFileSync(join(dir, "check.py"), `import json\nfrom world_checker import evaluate_world\ncases = json.loads(${JSON.stringify(JSON.stringify(cases))})\nprint(json.dumps([evaluate_world(case['expression'], case['environment']) for case in cases]))\n`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, py.stderr);
    const actual = JSON.parse(py.stdout);
    for (const [index, item] of cases.entries()) {
      assert.equal(evaluate(item.expression, item.environment), item.expected);
      assert.equal(actual[index], item.expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI compile leaves the published directory unchanged if staging fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-stage-fail-"));
  try {
    const input = join(dir, "world.yaml");
    const out = join(dir, "projection");
    writeFileSync(input, yaml);
    mkdirSync(out);
    writeFileSync(join(out, "ports.py"), "old ports");
    mkdirSync(join(out, "world_checker.py"));
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "compile", input, "--out", out, "--lang", "python"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(out, "ports.py"), "utf8"), "old ports");
    assert.deepEqual(readdirSync(dir).sort(), ["projection", "world.yaml"]);
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

test("Python expression and payload handling matches TypeScript fail-closed behavior", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-parity-"));
  try {
    const spec = { ...world, transitions: [
      { id: "OR", from: "CREATED", to: "PAYMENT_PENDING", guard: "true || 1", directive: null, effects: [] },
      { id: "IMPLIES", from: "CREATED", to: "PAYMENT_PENDING", guard: "state == 'NOPE' => 1", directive: null, effects: [] },
      { id: "MISSING", from: "CREATED", to: "PAYMENT_PENDING", guard: "event.override == null", directive: null, effects: [] },
    ] } as typeof world;
    const projection = compileWorldSpecPython(spec);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `import json\nfrom world_checker import WorldChecker, evaluate_world\nerrors = []\nfor expression in ['true || 1', "state == 'NOPE' => 1"]:\n    try:\n        evaluate_world(expression, {'state': 'CREATED'})\n        errors.append('NO_ERROR')\n    except ValueError as error:\n        errors.append(str(error))\nc = WorldChecker({'order_amount': 9999})\nverdicts = [c.step({'transitionId': action}) for action in ['OR', 'IMPLIES', 'MISSING']]\nverdicts.append(c.step({'transitionId': 'MISSING', 'eventPayload': {'tags': [1]}}))\nc.reset()\nprint(json.dumps({'errors': errors, 'missing': evaluate_world('event.override == null', {'event': {}}), 'objects': evaluate_world('event.a != event.b', {'event': {'a': {'x': 1}, 'b': {'x': 1}}}), 'verdicts': verdicts, 'context': c.get_context()}))`);
    const py = run(["check.py"], dir);
    assert.equal(py.status, 0, py.stderr);
    const actual = JSON.parse(py.stdout);
    for (const expression of ["true || 1", "state == 'NOPE' => 1"]) assert.throws(() => evaluate(expression, { state: "CREATED" }), /INVALID_EXPRESSION/);
    assert.deepEqual(actual.errors, ["INVALID_EXPRESSION: expected boolean operand", "INVALID_EXPRESSION: expected boolean operand"]);
    assert.equal(actual.missing, evaluate("event.override == null", { event: {} }));
    assert.equal(actual.objects, evaluate("event.a != event.b", { event: { a: { x: 1 }, b: { x: 1 } } }));
    const ts = createWorldChecker(spec, { order_amount: 9999 });
    const requests = ["OR", "IMPLIES", "MISSING"].map(transitionId => ({ transitionId }));
    const expected = [...requests.map(request => ts.step(request)), ts.step({ transitionId: "MISSING", eventPayload: { tags: [1] } })];
    for (let i = 0; i < expected.length; i++) {
      assert.equal(actual.verdicts[i].violation.code, expected[i]!.violation?.code);
      assert.equal(actual.verdicts[i].allowed, false);
    }
    assert.deepEqual(actual.verdicts.map((verdict: any) => verdict.violation.code), ["GUARD_FAILED", "GUARD_FAILED", "GUARD_FAILED", "SECURITY_VIOLATION"]);
    assert.equal(actual.context.order_amount, 9999);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Python checker propagates reentrancy from guard, effect, and invariant evaluation", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-py-reentrant-"));
  try {
    const projection = compileWorldSpecPython(world);
    writeFileSync(join(dir, "ports.py"), projection.portsPy);
    writeFileSync(join(dir, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(dir, "check.py"), `import world_checker as module\nc = module.WorldChecker()\noriginal = module.evaluate_world\ndef reenter(expression, environment):\n    raise RuntimeError('REENTRANCY_DETECTED: nested call')\nmodule.evaluate_world = reenter\nfor action in [lambda: c.step({'transitionId':'INITIATE_PAYMENT','proposedDirective':'DISPATCH_PAYMENT_GATEWAY'}), lambda: c.reset()]:\n    try:\n        action()\n        assert False\n    except RuntimeError as error:\n        assert 'REENTRANCY_DETECTED' in str(error)\nassert c.get_state() == 'CREATED'\nmodule.evaluate_world = original\nassert c.step({'transitionId':'INITIATE_PAYMENT','proposedDirective':'DISPATCH_PAYMENT_GATEWAY'})['allowed']\ndef reenter_effect(expression, environment):\n    if expression == 'order_amount':\n        raise RuntimeError('REENTRANCY_DETECTED: nested effect')\n    return original(expression, environment)\nmodule.evaluate_world = reenter_effect\ntry:\n    c.step({'transitionId':'CONFIRM_PAYMENT','eventPayload':{'captured_amount':5000}})\n    assert False\nexcept RuntimeError as error:\n    assert 'REENTRANCY_DETECTED' in str(error)\nassert c.get_state() == 'PAYMENT_PENDING'\n`);
    const result = run(["check.py"], dir);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
