import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compileWorldSpec, compileWorldSpecPython, parseWorldSpec } from "./world_compiler.js";

export interface ScaffoldOptions {
  readonly template?: "default" | "order-settlement" | "circuit-breaker";
  readonly lang?: "ts" | "python" | "all";
  readonly force?: boolean;
}

export interface ScaffoldResult {
  readonly directory: string;
  readonly files: readonly string[];
}

const orderWorld = `version: "kadmos.world.v0"
name: "OrderSettlementWorld"
description: "Governed order payment and settlement"
states:
  - id: CREATED
    initial: true
    description: "Order accepted"
  - id: PAYMENT_PENDING
    description: "Awaiting payment capture"
  - id: PAID
    description: "Funds held in escrow"
  - id: SETTLED
    terminal: true
    description: "Funds settled"
  - id: CANCELLED
    terminal: true
    description: "Order cancelled"
context:
  order_amount:
    type: integer
    unit: "cents"
    min: 1
    max: 100000000
    default: 5000
  escrow_balance:
    type: integer
    unit: "cents"
    min: 0
    max: 100000000
    default: 0
  settled_amount:
    type: integer
    unit: "cents"
    min: 0
    max: 100000000
    default: 0
invariants:
  - id: VALUE_CONSERVATION
    description: "Escrow and settled funds never exceed the order amount"
    predicate: "escrow_balance + settled_amount <= order_amount"
  - id: SETTLEMENT_COMPLETE
    description: "A settled order has no remaining escrow"
    predicate: "state == 'SETTLED' => (settled_amount == order_amount && escrow_balance == 0)"
transitions:
  - id: INITIATE_PAYMENT
    from: CREATED
    to: PAYMENT_PENDING
    guard: "order_amount > 0"
    directive: "DISPATCH_PAYMENT_GATEWAY"
    effects: []
  - id: CONFIRM_PAYMENT
    from: PAYMENT_PENDING
    to: PAID
    guard: "event.captured_amount == order_amount"
    directive: null
    effects:
      - "escrow_balance = order_amount"
  - id: SETTLE_ORDER
    from: PAID
    to: SETTLED
    guard: "escrow_balance == order_amount"
    directive: "DISPATCH_SETTLEMENT"
    effects:
      - "settled_amount = escrow_balance"
      - "escrow_balance = 0"
  - id: CANCEL_UNPAID
    from: CREATED
    to: CANCELLED
    guard: true
    directive: null
    effects: []
`;

const circuitWorld = `version: "kadmos.world.v0"
name: "CircuitBreakerWorld"
description: "Governed task worker circuit breaker"
states:
  - id: CLOSED
    initial: true
    description: "Worker accepts requests"
  - id: OPEN
    description: "Worker rejects requests after a failure"
  - id: HALF_OPEN
    description: "Worker probes recovery"
  - id: STOPPED
    terminal: true
    description: "Worker permanently stopped"
context:
  failure_count:
    type: integer
    min: 0
    max: 10
    default: 0
invariants:
  - id: FAILURE_BUDGET
    description: "Failure count remains within the declared budget"
    predicate: "failure_count >= 0 && failure_count <= 10"
transitions:
  - id: TRIP
    from: CLOSED
    to: OPEN
    guard: true
    directive: null
    effects:
      - "failure_count = failure_count + 1"
  - id: PROBE
    from: OPEN
    to: HALF_OPEN
    guard: true
    directive: "RUN_HEALTH_PROBE"
    effects: []
  - id: RECOVER
    from: HALF_OPEN
    to: CLOSED
    guard: true
    directive: null
    effects:
      - "failure_count = 0"
  - id: STOP
    from: OPEN
    to: STOPPED
    guard: true
    directive: null
    effects: []
`;

function sample(template: NonNullable<ScaffoldOptions["template"]>): { transitionId: string; directive: string | null; state: string } {
  return template === "circuit-breaker" ? { transitionId: "TRIP", directive: null, state: "OPEN" } : { transitionId: "INITIATE_PAYMENT", directive: "DISPATCH_PAYMENT_GATEWAY", state: "PAYMENT_PENDING" };
}

export async function initKadmosProject(targetDir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const template = options.template ?? "default";
  const lang = options.lang ?? "all";
  if (!["default", "order-settlement", "circuit-breaker"].includes(template)) throw new Error(`Unknown template: ${template}`);
  if (!["ts", "python", "all"].includes(lang)) throw new Error(`Unknown language: ${lang}`);
  const directory = resolve(targetDir);
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  const linkedTarget = existing?.isSymbolicLink() ?? false;
  if (existing && !existing.isDirectory() && !(linkedTarget && options.force)) throw new Error(`Target is not a directory: ${directory}`);
  if (existing?.isDirectory() && readdirSync(directory).length && !options.force) throw new Error(`Target directory is not empty: ${directory} (use --force to overwrite generated files)`);
  mkdirSync(dirname(directory), { recursive: true });
  const temporary = mkdtempSync(join(dirname(directory), `.${basename(directory)}.init-`));
  const staged = join(temporary, "project");
  const previous = join(temporary, "previous");
  const yaml = template === "circuit-breaker" ? circuitWorld : orderWorld;
  const world = parseWorldSpec(yaml);
  const example = sample(template);
  const files: string[] = [];
  const clearLinkedParents = (path: string): boolean => {
    let parent = staged;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
        unlinkSync(parent);
        return true;
      }
    }
    return false;
  };
  const write = (path: string, content: string): void => {
    const destination = join(staged, path);
    clearLinkedParents(path);
    mkdirSync(dirname(destination), { recursive: true });
    if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(destination);
    writeFileSync(destination, content);
    files.push(path);
  };
  try {
    if (existing && !linkedTarget) cpSync(directory, staged, { recursive: true });
    else mkdirSync(staged);
    const obsolete = lang === "all" ? [] : lang === "ts"
      ? ["src/world/ports.py", "src/world/world_checker.py", "src/worker.py", "tests/test_gatekeeper.py"]
      : ["src/world/ports.d.ts", "src/world/world_checker.ts", "src/worker.ts", "tests/test_gatekeeper.test.ts", "tsconfig.json"];
    for (const path of obsolete) {
      if (clearLinkedParents(path)) continue;
      const destination = join(staged, path);
      if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(destination);
      else rmSync(destination, { force: true });
    }
    write("world.yaml", yaml);
    if (lang === "ts" || lang === "all") {
      const compiled = compileWorldSpec(world);
      write("src/world/ports.d.ts", compiled.portsDts);
      write("src/world/world_checker.ts", compiled.worldCheckerTs);
      write("src/worker.ts", `import { WorldChecker } from "./world/world_checker.js";

export function runWorker() {
  const checker = new WorldChecker();
  const verdict = checker.step({ transitionId: ${JSON.stringify(example.transitionId)}, proposedDirective: ${JSON.stringify(example.directive)} });
  if (!verdict.allowed) throw new Error(verdict.violation?.message ?? "World rejected worker step");
  return verdict;
}
`);
      write("tests/test_gatekeeper.test.ts", `import assert from "node:assert/strict";
import test from "node:test";
import { runWorker } from "../src/worker.js";

test("worker obeys the compiled World gatekeeper", () => {
  const verdict = runWorker();
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.currentState, ${JSON.stringify(example.state)});
});
`);
    }
    if (lang === "python" || lang === "all") {
      const compiled = compileWorldSpecPython(world);
      write("src/world/ports.py", compiled.portsPy);
      write("src/world/world_checker.py", compiled.worldCheckerPy);
      write("src/worker.py", `from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "world"))
from world_checker import WorldChecker


def run_worker():
    checker = WorldChecker()
    verdict = checker.step({"transitionId": ${JSON.stringify(example.transitionId)}, "proposedDirective": ${example.directive === null ? "None" : JSON.stringify(example.directive)}})
    if not verdict["allowed"]:
        raise RuntimeError(verdict.get("violation", {}).get("message", "World rejected worker step"))
    return verdict
`);
      write("tests/test_gatekeeper.py", `import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from worker import run_worker


class GatekeeperTest(unittest.TestCase):
    def test_worker_obeys_world(self):
        verdict = run_worker()
        self.assertTrue(verdict["allowed"])
        self.assertEqual(verdict["currentState"], ${JSON.stringify(example.state)})
`);
    }
    write("package.json", `${JSON.stringify({ name: basename(directory).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "kadmos-app", private: true, type: "module", scripts: { compile: "kadmos compile world.yaml --out src/world --lang " + lang, test: "kadmos test world.yaml --runs 30", graph: "kadmos graph world.yaml --format html --out state_machine.html", ...(lang !== "python" ? { "test:worker": "tsc && node --test dist/tests/test_gatekeeper.test.js" } : {}) }, dependencies: { kadmos: "latest" }, ...(lang !== "python" ? { devDependencies: { typescript: "^7.0.2", "@types/node": "^26.5.1" } } : {}) }, null, 2)}\n`);
    if (lang !== "python") write("tsconfig.json", `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist", rootDir: ".", types: ["node"] }, include: ["src/**/*.ts", "tests/**/*.ts"] }, null, 2)}\n`);
    write(".gitignore", "node_modules/\n__pycache__/\ndist/\n*.pyc\nstate_machine.html\n");
    write(".github/workflows/ci.yml", `name: Kadmos CI
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: pnpm/action-setup@v4
        with:
          version: '11'
      - run: pnpm install --no-frozen-lockfile
      - run: pnpm test
${lang !== "python" ? "      - run: pnpm run test:worker\n" : ""}${lang !== "ts" ? "      - run: python3 -m unittest discover -s tests\n" : ""}`);
    write("README.md", `# ${world.name}

Kadmos separates **World** policy from **Fabric** implementation. \`world.yaml\` declares allowed states, transitions, bounded context, and invariants. The worker in \`src/\` is Fabric: it requests each step through the compiled gatekeeper and executes only allowed directives.

## Quickstart

\`\`\`sh
pnpm install
pnpm run compile
pnpm test
pnpm run graph
${lang !== "python" ? "pnpm run test:worker\n" : ""}${lang !== "ts" ? "python3 -m unittest discover -s tests\n" : ""}\`\`\`

Open \`state_machine.html\` to inspect the graph. Edit \`world.yaml\` and run \`pnpm run compile\` before changing worker logic.
`);
    if (existing) renameSync(directory, previous);
    try { renameSync(staged, directory); }
    catch (error) { if (existing) renameSync(previous, directory); throw error; }
    return { directory, files };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
