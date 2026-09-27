import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepVerdict, TransitionStepRequest } from "./types/ports.js";
import type { TransitionDef, WorldSpec } from "./types/world.js";
import { compileWorldSpecPython } from "./python_compiler.js";
import { createWorldChecker } from "./world_checker.js";

export interface FuzzOptions {
  runs?: number;
  stepsPerRun?: number;
  seed?: number;
  verbose?: boolean;
  /** Replaces the Python batch runner for controlled differential tests. */
  pythonRunner?: (requests: TransitionStepRequest[][], tsVerdicts: StepVerdict[][]) => Promise<StepVerdict[][]>;
}

export interface FuzzReport {
  totalRuns: number;
  totalSteps: number;
  passed: boolean;
  divergences: Array<{ run: number; step: number; request: TransitionStepRequest; tsVerdict: StepVerdict; pyVerdict: StepVerdict | undefined; reason: string }>;
  stateCoverage: { visited: string[]; total: string[]; ratio: number };
  transitionCoverage: { visited: string[]; total: string[]; ratio: number };
}

function mixWord(h1: number, k1: number): number {
  k1 = Math.imul(k1, 0xcc9e2d51);
  k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
  k1 = Math.imul(k1, 0x1b873593);
  h1 = (h1 ^ k1) >>> 0;
  h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
  return (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
}

function fmix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function mulberry32(seed: number): () => number {
  const low = seed >>> 0;
  const high = Math.floor(seed / 0x100000000) >>> 0;
  let h = 0;
  h = mixWord(h, low);
  h = mixWord(h, high);
  h = (h ^ 8) >>> 0;
  let state = fmix32(h);
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomItem<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function eventPayload(transition: TransitionDef, context: Readonly<Record<string, number | string>>, random: () => number): Record<string, unknown> {
  const expressions = [transition.guard, ...transition.effects].filter((value): value is string => typeof value === "string");
  const payload: Record<string, unknown> = {};
  for (const expression of expressions) {
    for (const match of expression.matchAll(/\bevent\.([A-Za-z_][A-Za-z_0-9]*)\b/g)) {
      const key = match[1]!;
      const equality = new RegExp(`event\\.${key}\\s*==\\s*([A-Za-z_][A-Za-z_0-9]*)|([A-Za-z_][A-Za-z_0-9]*)\\s*==\\s*event\\.${key}`).exec(expression);
      const contextKey = equality?.[1] ?? equality?.[2];
      payload[key] = contextKey && Object.hasOwn(context, contextKey) ? context[contextKey] : Math.floor(random() * 10);
    }
  }
  return payload;
}

function generateRequest(spec: WorldSpec, state: string, context: Readonly<Record<string, number | string>>, random: () => number): TransitionStepRequest {
  const legal = spec.transitions.filter((transition) => transition.from === state);
  if (legal.length && random() < 0.7) {
    const transition = randomItem(legal, random);
    const payload = eventPayload(transition, context, random);
    if (random() < 0.2) {
      const key = Object.keys(payload)[0];
      if (key) payload[key] = randomItem([-1, 1.5, Number.MAX_SAFE_INTEGER], random);
      else payload[Object.keys(spec.context)[0] ?? "invalid"] = -1;
    }
    const directiveChoice = random();
    return {
      transitionId: transition.id,
      eventPayload: payload,
      proposedDirective: directiveChoice < 0.8 ? transition.directive : directiveChoice < 0.9 ? null : "__WRONG_DIRECTIVE__",
    };
  }
  const foreign = spec.transitions.filter((transition) => transition.from !== state);
  const transitionId = foreign.length && random() < 0.5 ? randomItem(foreign, random).id : `__UNKNOWN_${Math.floor(random() * 1000)}__`;
  const hostileKey = randomItem(["__proto__", "constructor", "negative", "fraction", "oversized"], random);
  const payload: Record<string, unknown> = { [hostileKey]: hostileKey === "fraction" ? 1.5 : hostileKey === "oversized" ? Number.MAX_SAFE_INTEGER + 1 : -1 };
  return { transitionId, eventPayload: payload, proposedDirective: random() < 0.5 ? null : "__WRONG_DIRECTIVE__" };
}

const PYTHON_RUNNER = `import json
import sys
from world_checker import WorldChecker

runs = json.load(sys.stdin)
result = []
for requests in runs:
    checker = WorldChecker()
    result.append([checker.step(request) for request in requests])
json.dump(result, sys.stdout, allow_nan=False)
`;

function runPython(spec: WorldSpec, requests: TransitionStepRequest[][]): StepVerdict[][] {
  const projection = compileWorldSpecPython(spec);
  const directory = mkdtempSync(join(tmpdir(), "kadmos-fuzz-"));
  try {
    writeFileSync(join(directory, "ports.py"), projection.portsPy);
    writeFileSync(join(directory, "world_checker.py"), projection.worldCheckerPy);
    writeFileSync(join(directory, "runner.py"), PYTHON_RUNNER);
    const process = spawnSync("python3", ["-B", "runner.py"], {
      cwd: directory, input: JSON.stringify(requests), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    if (process.error || process.status !== 0) throw new Error(`Python fuzzer runner failed: ${process.error?.message ?? process.stderr}`);
    return JSON.parse(process.stdout) as StepVerdict[][];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verdictDifference(ts: StepVerdict, py: StepVerdict | undefined): string | undefined {
  if (!py || typeof py !== "object") return "missing Python verdict";
  for (const field of ["allowed", "previousState", "currentState", "directiveAllowed"] as const) {
    if (ts[field] !== py[field]) return `${field}: TS=${JSON.stringify(ts[field])}, Python=${JSON.stringify(py[field])}`;
  }
  if (py.context === null || typeof py.context !== "object" || Array.isArray(py.context)) return "context: Python verdict has no context object";
  const tsKeys = Object.keys(ts.context).sort();
  const pyKeys = Object.keys(py.context).sort();
  if (JSON.stringify(tsKeys) !== JSON.stringify(pyKeys)) return `context keys: TS=${JSON.stringify(tsKeys)}, Python=${JSON.stringify(pyKeys)}`;
  for (const key of tsKeys) {
    if (ts.context[key] !== py.context[key] || (typeof py.context[key] === "number" && !Number.isSafeInteger(py.context[key]))) {
      return `context.${key}: TS=${ts.context[key]}, Python=${py.context[key]}`;
    }
  }
  if (!ts.allowed) {
    if (ts.violation?.code !== py.violation?.code) return `violation.code: TS=${ts.violation?.code}, Python=${py.violation?.code}`;
    if (ts.violation?.message !== py.violation?.message) return `violation.message: TS=${ts.violation?.message}, Python=${py.violation?.message}`;
    if (ts.violation?.violatedInvariant !== py.violation?.violatedInvariant) return `violation.violatedInvariant: TS=${ts.violation?.violatedInvariant}, Python=${py.violation?.violatedInvariant}`;
    const tsTrace = ts.violation?.shortestCounterexampleTrace ?? [];
    const pyTrace = py.violation?.shortestCounterexampleTrace ?? [];
    if (tsTrace.length !== pyTrace.length) return `violation.trace.length: TS=${tsTrace.length}, Python=${pyTrace.length}`;
    for (let i = 0; i < tsTrace.length; i++) {
      const t = tsTrace[i]!;
      const p = pyTrace[i]!;
      if (t.step !== p.step) return `trace[${i}].step: TS=${t.step}, Python=${p.step}`;
      if (t.state !== p.state) return `trace[${i}].state: TS=${t.state}, Python=${p.state}`;
      if (t.action !== p.action) return `trace[${i}].action: TS=${t.action}, Python=${p.action}`;
      if ((t.proposedDirective ?? null) !== (p.proposedDirective ?? null)) return `trace[${i}].proposedDirective: TS=${t.proposedDirective}, Python=${p.proposedDirective}`;
      if (JSON.stringify(t.eventPayload ?? {}) !== JSON.stringify(p.eventPayload ?? {})) return `trace[${i}].eventPayload mismatch`;
    }
  }
  return undefined;
}

export async function runDifferentialFuzzing(spec: WorldSpec, options: FuzzOptions = {}): Promise<FuzzReport> {
  const runs = options.runs ?? 50;
  const steps = options.stepsPerRun ?? 20;
  const seed = options.seed ?? Date.now();
  if (![runs, steps, seed].every(Number.isSafeInteger) || runs < 1 || steps < 1) throw new Error("Fuzz options require positive integer runs and steps, and an integer seed");
  const random = mulberry32(seed);
  const requests: TransitionStepRequest[][] = [];
  const tsVerdicts: StepVerdict[][] = [];
  const visitedStates = new Set<string>();
  const visitedTransitions = new Set<string>();
  for (let run = 0; run < runs; run++) {
    const checker = createWorldChecker(spec);
    const runRequests: TransitionStepRequest[] = [];
    const runVerdicts: StepVerdict[] = [];
    visitedStates.add(checker.getState());
    for (let step = 0; step < steps; step++) {
      const request = generateRequest(spec, checker.getState(), checker.getContext(), random);
      const verdict = checker.step(request);
      runRequests.push(request);
      runVerdicts.push(verdict);
      if (verdict.allowed) {
        visitedStates.add(verdict.currentState);
        visitedTransitions.add(request.transitionId);
      }
    }
    requests.push(runRequests);
    tsVerdicts.push(runVerdicts);
  }
  const pyVerdicts = options.pythonRunner ? await options.pythonRunner(requests, tsVerdicts) : runPython(spec, requests);
  const divergences: FuzzReport["divergences"] = [];
  for (let run = 0; run < runs; run++) for (let step = 0; step < steps; step++) {
    const tsVerdict = tsVerdicts[run]![step]!;
    const pyVerdict = pyVerdicts[run]?.[step];
    const reason = verdictDifference(tsVerdict, pyVerdict);
    if (reason) divergences.push({ run: run + 1, step: step + 1, request: requests[run]![step]!, tsVerdict, pyVerdict, reason });
  }
  const totalStates = spec.states.map((state) => state.id);
  const totalTransitions = spec.transitions.map((transition) => transition.id);
  return {
    totalRuns: runs, totalSteps: runs * steps, passed: divergences.length === 0, divergences,
    stateCoverage: { visited: totalStates.filter((id) => visitedStates.has(id)), total: totalStates, ratio: totalStates.length ? visitedStates.size / totalStates.length : 1 },
    transitionCoverage: { visited: totalTransitions.filter((id) => visitedTransitions.has(id)), total: totalTransitions, ratio: totalTransitions.length ? visitedTransitions.size / totalTransitions.length : 1 },
  };
}
