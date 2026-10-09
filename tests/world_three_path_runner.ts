import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as nodeTypes } from "node:util";
import { pathToFileURL } from "node:url";
import type { WorldSpecInput } from "../src/types/world.js";
import { compileWorldSpec, compileWorldSpecPython } from "../src/world_compiler.js";
import { createWorldChecker } from "../src/world_checker.js";

export type ThreePathCommand =
  | { kind: "step"; request: unknown }
  | { kind: "reset"; context?: unknown }
  | { kind: "rollback" }
  | { kind: "getState" }
  | { kind: "getContext" };

export interface NormalizedRecord {
  step: number;
  state: string;
  action: string;
  eventPayload?: Readonly<Record<string, unknown>>;
  proposedDirective?: string | null;
}
export interface NormalizedViolation {
  code: string;
  message: string;
  violatedInvariant?: string;
  shortestCounterexampleTrace: readonly NormalizedRecord[];
}
export interface NormalizedVerdict {
  allowed: boolean;
  previousState: string;
  currentState: string;
  context: Readonly<Record<string, number | string>>;
  directiveAllowed: string | null;
  violation?: NormalizedViolation;
}
export interface Observed {
  kind: ThreePathCommand["kind"];
  state: string;
  context: Readonly<Record<string, number | string>>;
  verdict?: NormalizedVerdict;
  errorCode?: string;
}
export interface PathOutcome {
  constructionError?: string;
  observations: readonly Observed[];
}
export interface ThreePathOutcome {
  interpreted: PathOutcome;
  emittedTs: PathOutcome;
  emittedPy: PathOutcome;
}

const stableErrors = /^(INVALID_BOUNDS|INITIAL_INVARIANT_FAILED|NO_CHECKER_SAVEPOINT|REENTRANCY_DETECTED)(?::|$)/;
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = stableErrors.exec(message);
  if (!match) throw error;
  return match[1]!;
}

function assertJson(value: unknown, active: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || nodeTypes.isProxy(value) || active.has(value)) throw new Error("RUNNER_INPUT_NOT_JSON");
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("RUNNER_INPUT_NOT_JSON");
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === "length") continue;
      if (!("value" in descriptor)) throw new Error("RUNNER_INPUT_NOT_JSON");
      assertJson(descriptor.value, active);
    }
  } finally { active.delete(value); }
}

interface CheckerLike {
  getState(): string;
  getContext(): Readonly<Record<string, number | string>>;
  step(request: never): unknown;
  reset(context?: never): void;
  rollbackLastStep(): void;
}

function runTs(make: () => CheckerLike, commands: readonly ThreePathCommand[]): PathOutcome {
  let checker: CheckerLike;
  try { checker = make(); } catch (error) { return { constructionError: errorCode(error), observations: [] }; }
  const observations: Observed[] = [];
  for (const command of commands) {
    let verdict: unknown;
    let code: string | undefined;
    try {
      if (command.kind === "step") verdict = checker.step(command.request as never);
      else if (command.kind === "reset") {
        if (Object.hasOwn(command, "context")) checker.reset(command.context as never);
        else checker.reset();
      } else if (command.kind === "rollback") checker.rollbackLastStep();
      else if (command.kind === "getState") checker.getState();
      else checker.getContext();
    } catch (error) { code = errorCode(error); }
    const observed: Observed = { kind: command.kind, state: checker.getState(), context: checker.getContext() };
    if (verdict !== undefined) observed.verdict = JSON.parse(JSON.stringify(verdict)) as NormalizedVerdict;
    if (code !== undefined) observed.errorCode = code;
    observations.push(observed);
  }
  return { observations };
}

const pythonRunner = `import json
import re
import sys
from world_checker import WorldChecker

PREFIX = re.compile(r"^(INVALID_BOUNDS|INITIAL_INVARIANT_FAILED|NO_CHECKER_SAVEPOINT|REENTRANCY_DETECTED)(?::|$)")
def code(error):
    match = PREFIX.match(str(error))
    if match is None:
        raise error
    return match.group(1)

data = json.load(sys.stdin)
try:
    checker = WorldChecker(data.get("initialContext"))
except Exception as error:
    json.dump({"constructionError": code(error), "observations": []}, sys.stdout, allow_nan=False)
    sys.exit(0)

observations = []
for command in data["commands"]:
    verdict = None
    error_code = None
    try:
        if command["kind"] == "step":
            verdict = checker.step(command["request"])
        elif command["kind"] == "reset":
            if "context" in command:
                checker.reset(command["context"])
            else:
                checker.reset()
        elif command["kind"] == "rollback":
            checker.rollback_last_step()
        elif command["kind"] == "getState":
            checker.get_state()
        elif command["kind"] == "getContext":
            checker.get_context()
        else:
            raise RuntimeError("RUNNER_UNKNOWN_COMMAND")
    except Exception as error:
        error_code = code(error)
    item = {"kind": command["kind"], "state": checker.get_state(), "context": checker.get_context()}
    if verdict is not None:
        item["verdict"] = verdict
    if error_code is not None:
        item["errorCode"] = error_code
    observations.append(item)
json.dump({"observations": observations}, sys.stdout, allow_nan=False)
`;

export async function runThreePaths(
  world: WorldSpecInput,
  commands: readonly ThreePathCommand[],
  initialContext?: unknown,
): Promise<ThreePathOutcome> {
  const input = initialContext === undefined ? { commands } : { commands, initialContext };
  assertJson(input);
  const ts = compileWorldSpec(world);
  const py = compileWorldSpecPython(world);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-three-path-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "ports.d.ts"), ts.portsDts);
    writeFileSync(join(directory, "world_checker.ts"), ts.worldCheckerTs);
    writeFileSync(join(directory, "ports.py"), py.portsPy);
    writeFileSync(join(directory, "world_checker.py"), py.worldCheckerPy);
    writeFileSync(join(directory, "runner.py"), pythonRunner);
    const tsc = spawnSync(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", join(process.cwd(), "node_modules/@types"), "--types", "node", join(directory, "ports.d.ts"), join(directory, "world_checker.ts")], { encoding: "utf8" });
    if (tsc.error || tsc.status !== 0) throw new Error(`EMITTED_TS_COMPILE: ${tsc.error?.message ?? `${tsc.stdout}\n${tsc.stderr}`}`);
    const { WorldChecker } = await import(pathToFileURL(join(directory, "world_checker.js")).href) as { WorldChecker: new (context?: unknown) => CheckerLike };
    const interpreted = runTs(() => createWorldChecker(world, initialContext as never), commands);
    const emittedTs = runTs(() => new WorldChecker(initialContext), commands);
    const processResult = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "runner.py"], { cwd: directory, input: JSON.stringify(input), encoding: "utf8" });
    if (processResult.error || processResult.status !== 0) throw new Error(`EMITTED_PYTHON_RUN: ${processResult.error?.message ?? processResult.stderr}`);
    const emittedPy = JSON.parse(processResult.stdout) as PathOutcome;
    return { interpreted, emittedTs, emittedPy };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
