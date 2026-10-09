import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { KADMOS_COMPILER_CONTRACT_VERSION, admitWorldSpec, compileWorldSpec, compileWorldSpecPython, parseWorldSpec } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";
import type { WorldSpec } from "../src/types/world.js";

const minimalWorld = {
  version: "kadmos.world.v0", name: "AdmissionProbe",
  states: [{ id: "START", initial: true }, { id: "DONE" }],
  context: {}, invariants: [],
  transitions: [{ id: "GO", from: "START", to: "DONE", guard: true, effects: [] }],
} as const;

test("one admission boundary normalizes only absent World directive", () => {
  const yaml = `version: "kadmos.world.v0"\nname: AdmissionProbe\nstates:\n  - id: START\n    initial: true\n  - id: DONE\ncontext: {}\ninvariants: []\ntransitions:\n  - id: GO\n    from: START\n    to: DONE\n    guard: true\n    effects: []\n`;
  for (const source of [yaml, yaml.replace("    effects: []", "    directive:\n    effects: []"), yaml.replace("    effects: []", "    directive: null\n    effects: []")]) {
    const original = source;
    assert.equal(parseWorldSpec(source).transitions[0]?.directive, null);
    assert.equal(source, original);
  }
  assert.equal(admitWorldSpec(minimalWorld).transitions[0]?.directive, null);
  assert.equal(Object.hasOwn(minimalWorld.transitions[0], "directive"), false);
  assert.equal(createWorldChecker(minimalWorld).step({ transitionId: "GO" }).allowed, true);
  for (const directive of [undefined, "", 7, true, {}, []]) {
    const bad = { ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], directive }] };
    for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
      assert.throws(() => enter(bad as never), /INVALID_WORLD: directive/);
    }
  }
});

test("direct World admission reads no hostile nested getter or proxy trap", () => {
  for (const key of ["directive", "id", "effects"] as const) {
    let reads = 0;
    const transition = Object.defineProperty({ ...minimalWorld.transitions[0] }, key, { get() { reads++; return null; } });
    const hostile = { ...minimalWorld, transitions: [transition] };
    for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
      assert.throws(() => enter(hostile as never), /INVALID_WORLD/);
      assert.equal(reads, 0);
    }
  }
  let traps = 0;
  const transition = new Proxy({ ...minimalWorld.transitions[0] }, { getOwnPropertyDescriptor() { traps++; throw Error("trap"); }, get() { traps++; throw Error("trap"); } });
  for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
    assert.throws(() => enter({ ...minimalWorld, transitions: [transition] } as never), /INVALID_WORLD/);
    assert.equal(traps, 0);
  }
});

test("direct World admission applies existing schema checks before projection", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ ...minimalWorld, states: [{ id: "START" }, { id: "DONE" }] }, /INITIAL_STATE/],
    [{ ...minimalWorld, transitions: [minimalWorld.transitions[0], minimalWorld.transitions[0]] }, /DUPLICATE_TRANSITION_ID/],
    [{ ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], to: "GHOST" }] }, /UNDECLARED_STATE/],
    [{ ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], guard: 4 }] }, /INVALID_WORLD: guard/],
    [{ ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], effects: ["ghost = 1"] }] }, /UNDECLARED_IDENTIFIER/],
    [{ ...minimalWorld, context: { n: { type: "integer", default: 1.5 } } }, /INVALID_BOUNDS/],
    [{ ...minimalWorld, context: undefined }, /INVALID_WORLD: context/],
    [{ ...minimalWorld, invariants: undefined }, /INVALID_WORLD: lists/],
    [{ ...minimalWorld, transitions: undefined }, /INVALID_WORLD: lists/],
  ];
  for (const [model, error] of cases) for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
    assert.throws(() => enter(model as never), error);
  }
  assert.throws(() => parseWorldSpec(7 as never), /INVALID_WORLD: source/);
});

test("programmatic World with data-only own fields retains admission compatibility", () => {
  class Model {
    version = "kadmos.world.v0" as const;
    name = "DataOnlyClass";
    states = [{ id: "START", initial: true }, { id: "DONE" }];
    context = {};
    invariants: never[] = [];
    transitions = [{ id: "GO", from: "START", to: "DONE", guard: true, effects: [] }];
  }
  const input = new Model();
  assert.equal(admitWorldSpec(input).transitions[0]?.directive, null);
  assert.equal(createWorldChecker(input).step({ transitionId: "GO" }).allowed, true);
});

test("shared admission rejects callable model leaves without invoking serialization hooks", () => {
  for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
    let calls = 0;
    const model = { ...minimalWorld, toJSON() { calls++; return minimalWorld; } };
    assert.throws(() => enter(model as never), /INVALID_WORLD/);
    assert.equal(calls, 0);
    for (const bad of [() => "hook", Symbol("hook"), 1n, Infinity, NaN]) {
      assert.throws(() => enter({ ...minimalWorld, metadata: { nested: bad } } as never), /INVALID_WORLD/);
    }
    assert.doesNotThrow(() => enter({ ...minimalWorld, description: undefined } as never));
  }
});

test("shared admission rejects malformed endpoints without caller coercion", () => {
  for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
    let calls = 0;
    const endpoint = { toString() { calls++; return "MISSING"; } };
    const model = { ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], from: endpoint }] };
    assert.throws(() => enter(model as never), /INVALID_WORLD/);
    assert.equal(calls, 0);
    assert.throws(() => enter({ ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], from: {} }] } as never), /INVALID_WORLD: transition endpoint/);
    assert.throws(() => enter({ ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], from: 0 }] } as never), /INVALID_WORLD: transition endpoint/);
  }
  const undeclared = { ...minimalWorld, transitions: [{ ...minimalWorld.transitions[0], from: "MISSING" }] };
  assert.throws(() => admitWorldSpec(undeclared), /UNDECLARED_STATE: MISSING -> DONE/);
  const yaml = `version: "kadmos.world.v0"\nname: EndpointProbe\nstates:\n  - id: S\n    initial: true\ncontext: {}\ninvariants: []\ntransitions:\n  - id: GO\n    from: S\n    to: S\n    guard: true\n    directive: null\n    effects: []\n`;
  assert.throws(() => parseWorldSpec(yaml.replace("from: S", "from: 0")), /INVALID_WORLD: transition endpoint/);
  assert.throws(() => parseWorldSpec(yaml.replace("to: S", "to: false")), /INVALID_WORLD: transition endpoint/);
});

test("shared admission requires nonempty string invariant IDs", () => {
  const yamlBase = `version: "kadmos.world.v0"\nname: InvariantIdProbe\nstates:\n  - id: S\n    initial: true\ncontext: {}\ninvariants:\n  - predicate: "false"\ntransitions: []\n`;
  for (const [invariant, source] of [
    [{ predicate: "false" }, yamlBase],
    [{ id: "", predicate: "false" }, yamlBase.replace('predicate: "false"', 'id: ""\n    predicate: "false"')],
    [{ id: 0, predicate: "false" }, yamlBase.replace('predicate: "false"', 'id: 0\n    predicate: "false"')],
  ] as const) {
    assert.throws(() => parseWorldSpec(source), /INVALID_WORLD: invariant id/);
    const direct = { ...minimalWorld, invariants: [invariant] };
    for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
      assert.throws(() => enter(direct as never), /INVALID_WORLD: invariant id/);
    }
  }
});

test("state initial and terminal markers require Boolean data across all admission paths", () => {
  const entries = [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker] as const;
  for (const bad of ["false", 1, 0, null, {}, []]) {
    const initialModel = { ...minimalWorld, states: [{ id: "START", initial: true }, { id: "DONE", initial: bad }] };
    const terminalModel = { ...minimalWorld, states: [{ id: "START", initial: true, terminal: bad }, { id: "DONE" }] };
    for (const enter of entries) {
      assert.throws(() => enter(initialModel as never), /INVALID_WORLD: state initial/);
      assert.throws(() => enter(terminalModel as never), /INVALID_WORLD: state terminal/);
    }
  }
  const yaml = `version: "kadmos.world.v0"\nname: StateFlagProbe\nstates:\n  - id: START\n    initial: true\n  - id: DONE\ncontext: {}\ninvariants: []\ntransitions:\n  - id: GO\n    from: START\n    to: DONE\n    guard: true\n    directive: null\n    effects: []\n`;
  for (const scalar of ['"false"', "1", "null", "{}", "[]"]) {
    assert.throws(() => parseWorldSpec(yaml.replace("  - id: DONE\n", `  - id: DONE\n    initial: ${scalar}\n`)), /INVALID_WORLD: state initial/);
    assert.throws(() => parseWorldSpec(yaml.replace("    initial: true\n", `    initial: true\n    terminal: ${scalar}\n`)), /INVALID_WORLD: state terminal/);
  }
});

test("Boolean state markers and absent or own undefined flags preserve transition semantics", () => {
  const valid = { ...minimalWorld, states: [{ id: "START", initial: true, terminal: false }, { id: "DONE", initial: false, terminal: true }, { id: "OTHER" }] };
  assert.equal(admitWorldSpec(valid).states.find((state) => state.initial)?.id, "START");
  assert.equal(createWorldChecker(valid).step({ transitionId: "GO" }).allowed, true);
  const optionalUndefined = { ...minimalWorld, states: [{ id: "START", initial: true, terminal: undefined }, { id: "DONE", initial: undefined, terminal: undefined }] };
  for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) assert.doesNotThrow(() => enter(optionalUndefined as never));
  const terminalEdge = { ...minimalWorld, states: [{ id: "START", initial: true, terminal: true }, { id: "DONE" }] };
  for (const enter of [admitWorldSpec, compileWorldSpec, compileWorldSpecPython, createWorldChecker]) {
    assert.throws(() => enter(terminalEdge as never), /TERMINAL_STATE: START/);
  }
  const yaml = `version: "kadmos.world.v0"\nname: ValidFlags\nstates:\n  - id: START\n    initial: true\n    terminal: false\n  - id: DONE\n    initial: false\n    terminal: true\ncontext: {}\ninvariants: []\ntransitions:\n  - id: GO\n    from: START\n    to: DONE\n    guard: true\n    directive: null\n    effects: []\n`;
  assert.equal(createWorldChecker(parseWorldSpec(yaml)).step({ transitionId: "GO" }).allowed, true);
});

test("explicitly empty World compiles strict TS and importable Python without invented invariants", async () => {
  const world: WorldSpec = {
    version: "kadmos.world.v0", name: "EmptyWorld", states: [{ id: "START", initial: true }],
    context: {}, invariants: [], transitions: [],
  };
  const ts = compileWorldSpec(world);
  const py = compileWorldSpecPython(world);
  assert.equal(KADMOS_COMPILER_CONTRACT_VERSION, "kadmos.compiler.k02.v1");
  for (const emitted of [ts.portsDts, ts.worldCheckerTs, py.portsPy, py.worldCheckerPy]) assert.match(emitted, /kadmos\.compiler\.k02\.v1/);
  assert.match(py.portsPy, /WorldDirective = None/);
  assert.doesNotMatch(ts.worldCheckerTs, /"predicate":"true"/);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-empty-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "ports.d.ts"), ts.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), ts.worldCheckerTs);
    writeFileSync(join(directory, "ports.py"), py.portsPy);
    writeFileSync(join(directory, "world_checker.py"), py.worldCheckerPy);
    const tsc = spawnSync(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", join(process.cwd(), "node_modules/@types"), "--types", "node", join(directory, "ports.d.ts"), join(directory, "world_checker.ts")], { encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    assert.equal(new WorldChecker().step({ transitionId: "UNKNOWN" }).violation.code, "INVALID_TRANSITION");
    const python = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "-c", "from ports import WorldDirective; from world_checker import WorldChecker; assert WorldDirective is None; assert WorldChecker().step({'transitionId':'UNKNOWN'})['violation']['code'] == 'INVALID_TRANSITION'"], { cwd: directory, encoding: "utf8" });
    assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const fixture = readFileSync(
  new URL("../../conformance/fixtures/order_settlement.world.yaml", import.meta.url),
  "utf8",
);

test("parses and validates the complete order settlement World IR", () => {
  const world = parseWorldSpec(fixture);
  assert.equal(world.version, "kadmos.world.v0");
  assert.equal(world.name, "OrderSettlementWorld");
  assert.deepEqual(world.states.map(({ id }) => id), [
    "CREATED", "PAYMENT_PENDING", "PAID", "FULFILLED", "CANCELLED",
  ]);
  assert.deepEqual(world.states.filter(({ initial }) => initial).map(({ id }) => id), ["CREATED"]);
  assert.deepEqual(world.states.filter(({ terminal }) => terminal).map(({ id }) => id), ["FULFILLED", "CANCELLED"]);
  assert.deepEqual(Object.keys(world.context), ["order_amount", "escrow_balance", "refunded_amount", "settled_amount"]);
  assert.deepEqual(world.context.order_amount, { type: "integer", unit: "cents", min: 1, max: 100000000, default: 5000 });
  assert.deepEqual(world.invariants.map(({ id }) => id), [
    "INV-01-CONSERVATION-OF-VALUE",
    "INV-02-NO-NEGATIVE-BALANCES",
    "INV-03-FULFILLED-SETTLEMENT",
  ]);
  assert.deepEqual(world.transitions.map(({ id, from, to }) => [id, from, to]), [
    ["INITIATE_PAYMENT", "CREATED", "PAYMENT_PENDING"],
    ["CONFIRM_PAYMENT", "PAYMENT_PENDING", "PAID"],
    ["DISPATCH_GOODS", "PAID", "FULFILLED"],
    ["CANCEL_AND_REFUND", "PAID", "CANCELLED"],
    ["ABORT_UNPAID", "CREATED", "CANCELLED"],
  ]);
});

test("rejects a negative lower bound with a schema error", () => {
  const source = fixture.replace("min: 1", "min: -1");
  assert.throws(() => parseWorldSpec(source), /(?:INVALID_BOUNDS|negative|minimum)/i);
});

test("rejects malformed YAML with a parse error", () => {
  const source = fixture.replace("states:\n", "states: [\n");
  assert.throws(() => parseWorldSpec(source), /(?:YAML|syntax)/i);
});

test("rejects a missing initial state", () => {
  const source = fixture.replace("    initial: true\n", "");
  assert.throws(() => parseWorldSpec(source), /(?:INITIAL_STATE|initial)/i);
});

test("rejects an inverted numeric range", () => {
  const source = fixture.replace("max: 100000000", "max: 0");
  assert.throws(() => parseWorldSpec(source), /(?:INVALID_BOUNDS|maximum|range)/i);
});

test("rejects a negative maximum when no minimum is specified", () => {
  const source = fixture.replace("min: 1\n    max: 100000000", "max: -5");
  assert.throws(() => parseWorldSpec(source), /(?:INVALID_BOUNDS|maximum|negative)/i);
});

test("rejects a transition into an undeclared state", () => {
  const source = fixture.replace("to: PAYMENT_PENDING", "to: GHOST_STATE");
  assert.throws(() => parseWorldSpec(source), /(?:UNDECLARED_STATE|GHOST_STATE)/i);
});

test("rejects a cycle that exits a terminal state", () => {
  const source = fixture.replace(
    "transitions:\n",
    "transitions:\n  - id: RESURRECT\n    from: FULFILLED\n    to: CREATED\n    guard: true\n    directive: null\n    effects: []\n",
  );
  assert.throws(() => parseWorldSpec(source), /(?:TERMINAL_STATE|FULFILLED)/i);
});

test("rejects duplicate transition IDs", () => {
  const source = fixture.replace(
    "transitions:\n",
    "transitions:\n  - id: INITIATE_PAYMENT\n    from: CREATED\n    to: CANCELLED\n    guard: true\n    directive: null\n    effects: []\n",
  );
  assert.throws(() => parseWorldSpec(source), /DUPLICATE_TRANSITION_ID/i);
});

test("rejects an undeclared predicate identifier rather than evaluating it", () => {
  const source = fixture.replace("escrow_balance >= 0", "phantom_balance >= 0");
  assert.throws(() => parseWorldSpec(source), /(?:UNDECLARED_IDENTIFIER|phantom_balance)/i);
});

test("projects typecheckable ports.d.ts and world_checker.ts", () => {
  const projection = compileWorldSpec(parseWorldSpec(fixture));
  assert.match(projection.portsDts, /export type WorldState\s*=/);
  assert.match(projection.portsDts, /export type WorldDirective\s*=/);
  assert.match(projection.portsDts, /export interface IWorldChecker/);
  assert.match(projection.portsDts, /export interface StepVerdict/);
  assert.match(projection.worldCheckerTs, /(?:class|function)\s+WorldChecker/);

  const directory = mkdtempSync(join(tmpdir(), "kadmos-projection-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(process.execPath, [tsc,
      "--ignoreConfig",
      "--strict", "--noEmit", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiler projection is independently testable from the YAML parser", () => {
  const smallWorld: WorldSpec = {
    version: "kadmos.world.v0",
    name: "SmallWorld",
    states: [{ id: "START", initial: true }, { id: "DONE", terminal: true }],
    context: { amount: { type: "integer", min: 1, max: 10, default: 5 } },
    invariants: [{ id: "INV-AMOUNT", predicate: "amount > 0" }],
    transitions: [{ id: "FINISH", from: "START", to: "DONE", guard: true, directive: "SEND", effects: [] }],
  };
  const projection = compileWorldSpec(smallWorld);
  assert.match(projection.portsDts, /START/);
  assert.match(projection.portsDts, /DONE/);
  assert.match(projection.portsDts, /SEND/);
  assert.match(projection.worldCheckerTs, /FINISH/);
});

test("generated checker enforces payment guard, applies effects, and validates terminal state and reset bounds", async () => {
  const projection = compileWorldSpec(parseWorldSpec(fixture));
  const directory = mkdtempSync(join(tmpdir(), "kadmos-runtime-"));
  try {
    writeFileSync(join(directory, "ports.d.ts"), projection.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), projection.worldCheckerTs);
    const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(process.cwd(), "node_modules", "@types"), "--types", "node",
      join(directory, "ports.d.ts"), join(directory, "world_checker.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href);
    const gate = new WorldChecker();
    gate.reset({ order_amount: 5000 });

    // Step 1: Initiate
    assert.equal(gate.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" }).allowed, true);

    // Step 2: Failed confirm
    assert.equal(gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 4999 } }).allowed, false);
    assert.equal(gate.getContext().escrow_balance, 0);

    // Step 2: Successful confirm
    assert.equal(gate.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } }).allowed, true);
    assert.equal(gate.getContext().escrow_balance, 5000);

    // Step 3: Fulfill
    const fulfill = gate.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
    assert.equal(fulfill.allowed, true);
    assert.equal(gate.getState(), "FULFILLED");
    assert.equal(gate.getContext().settled_amount, 5000);
    assert.equal(gate.getContext().escrow_balance, 0);

    // Validate that reset with illegal bounds throws
    assert.throws(() => gate.reset({ order_amount: 0 }), /INVALID_BOUNDS/);
    assert.throws(() => gate.reset({ order_amount: -5 }), /INVALID_BOUNDS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
