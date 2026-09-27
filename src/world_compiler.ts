import type { WorldSpec } from "./types/world.js";
import { identifiers } from "./world_expression.js";
export { compileWorldSpecPython, type PythonWorldProjection } from "./python_compiler.js";

export interface WorldProjection {
  readonly portsDts: string;
  readonly worldCheckerTs: string;
}

interface Line { indent: number; text: string }

function parseYaml(source: string): unknown {
  const lines: Line[] = source.split(/\r?\n/).flatMap((raw) => {
    if (!raw.trim() || raw.trimStart().startsWith("#")) return [];
    if (/\t/.test(raw)) throw new Error("YAML syntax: tabs are not supported");
    return [{ indent: raw.length - raw.trimStart().length, text: raw.trim() }];
  });
  let cursor = 0;
  const scalar = (value: string): unknown => {
    if (value === "[]") return [];
    if (value === "{}") return {};
    if (value.startsWith("[")) throw new Error("YAML syntax: malformed sequence");
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    if (value.startsWith('"')) {
      try { return JSON.parse(value); } catch { throw new Error("YAML syntax: invalid quoted scalar"); }
    }
    if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error("YAML syntax: invalid quoted scalar");
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (!value || /[\[\]{}]/.test(value)) throw new Error("YAML syntax: invalid scalar");
    return value;
  };
  const block = (level: number): unknown => {
    const sequence = lines[cursor]?.text.startsWith("- ") ?? false;
    const result: unknown[] | Record<string, unknown> = sequence ? [] : {};
    while (cursor < lines.length && lines[cursor]!.indent === level) {
      const line = lines[cursor]!;
      if (sequence) {
        if (!line.text.startsWith("- ")) throw new Error("YAML syntax: mixed collection");
        cursor++;
        const first = line.text.slice(2);
        if (/^[\w-]+:\s*/.test(first)) {
          lines.splice(cursor, 0, { indent: level + 2, text: first });
          (result as unknown[]).push(block(level + 2));
        } else if (first) {
          (result as unknown[]).push(scalar(first));
        } else if (lines[cursor] && lines[cursor]!.indent > level) {
          (result as unknown[]).push(block(lines[cursor]!.indent));
        } else throw new Error("YAML syntax: empty item");
      } else {
        const match = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line.text);
        if (!match) throw new Error(`YAML syntax: ${line.text}`);
        const key = match[1]!;
        if (Object.hasOwn(result, key)) throw new Error(`YAML syntax: duplicate key ${key}`);
        cursor++;
        const value = match[2];
        (result as Record<string, unknown>)[key] = value !== undefined ? scalar(value) :
          lines[cursor] && lines[cursor]!.indent > level ? block(lines[cursor]!.indent) : null;
      }
      if (lines[cursor] && lines[cursor]!.indent > level) throw new Error("YAML syntax: indentation");
    }
    return result;
  };
  if (!lines.length) throw new Error("YAML syntax: empty document");
  const result = block(lines[0]!.indent);
  if (cursor !== lines.length) throw new Error("YAML syntax: indentation");
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_WORLD: ${label}`);
  return value as Record<string, unknown>;
}

export function parseWorldSpec(source: string): WorldSpec {
  const raw = object(parseYaml(source), "root");
  if (raw.version !== "kadmos.world.v0") throw new Error("INVALID_VERSION: expected kadmos.world.v0");
  if (typeof raw.name !== "string") throw new Error("INVALID_WORLD: name");
  if (!Array.isArray(raw.states) || !Array.isArray(raw.invariants) || !Array.isArray(raw.transitions)) throw new Error("INVALID_WORLD: lists");
  const context = object(raw.context, "context");
  const states = raw.states.map((item) => object(item, "state"));
  const invariants = raw.invariants.map((item) => object(item, "invariant"));
  const transitions = raw.transitions.map((item) => object(item, "transition"));
  if (states.filter((state) => state.initial === true).length !== 1) throw new Error("INITIAL_STATE: exactly one required");
  const stateIds = new Set(states.map((state) => state.id));
  if (stateIds.size !== states.length || [...stateIds].some((id) => typeof id !== "string")) throw new Error("INVALID_WORLD: duplicate state");

  for (const [name, definition] of Object.entries(context)) {
    const variable = object(definition, name);
    if (variable.type !== "integer" || [variable.min, variable.max, variable.default].some((n) => n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n)))) throw new Error(`INVALID_BOUNDS: ${name}`);
    if (typeof variable.min === "number" && variable.min < 0 || typeof variable.max === "number" && variable.max < (typeof variable.min === "number" ? variable.min : 0)) throw new Error(`INVALID_BOUNDS: ${name}`);
    const defaultValue = typeof variable.default === "number" ? variable.default : 0;
    if (typeof variable.min === "number" && defaultValue < variable.min) throw new Error(`INVALID_BOUNDS: default ${name}`);
    if (typeof variable.max === "number" && defaultValue > variable.max) throw new Error(`INVALID_BOUNDS: default ${name}`);
  }

  const transitionIds = new Set<string>();
  for (const transition of transitions) {
    if (typeof transition.id !== "string" || !transition.id) throw new Error("INVALID_WORLD: transition id");
    if (transitionIds.has(transition.id)) throw new Error(`DUPLICATE_TRANSITION_ID: ${transition.id}`);
    transitionIds.add(transition.id);
    if (!stateIds.has(transition.from) || !stateIds.has(transition.to)) throw new Error(`UNDECLARED_STATE: ${String(transition.from)} -> ${String(transition.to)}`);
    if (states.some((state) => state.id === transition.from && state.terminal === true)) throw new Error(`TERMINAL_STATE: ${String(transition.from)}`);
    if (!Array.isArray(transition.effects) || !transition.effects.every((effect) => typeof effect === "string")) throw new Error("INVALID_WORLD: effects");
  }

  const allowed = new Set([...Object.keys(context), "state", "event"]);
  for (const invariant of invariants) {
    if (typeof invariant.predicate !== "string") throw new Error("INVALID_WORLD: predicate");
    for (const id of identifiers(invariant.predicate)) if (!allowed.has(id)) throw new Error(`UNDECLARED_IDENTIFIER: ${id}`);
  }
  for (const transition of transitions) {
    if (typeof transition.guard !== "string" && typeof transition.guard !== "boolean") throw new Error("INVALID_WORLD: guard");
    if (typeof transition.guard === "string") for (const id of identifiers(transition.guard)) if (!allowed.has(id)) throw new Error(`UNDECLARED_IDENTIFIER: ${id}`);
    for (const effect of transition.effects as string[]) {
      const match = /^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/.exec(effect);
      if (!match || !Object.hasOwn(context, match[1]!)) throw new Error(`UNDECLARED_IDENTIFIER: ${effect}`);
      for (const id of identifiers(match[2]!)) if (!allowed.has(id)) throw new Error(`UNDECLARED_IDENTIFIER: ${id}`);
    }
  }
  return raw as unknown as WorldSpec;
}

export function compileWorldSpec(spec: WorldSpec): WorldProjection {
  const stateUnion = spec.states.map((state) => JSON.stringify(state.id)).join(" | ") || "never";
  const directives = [...new Set(spec.transitions.map((transition) => transition.directive).filter((value): value is string => value !== null))];
  const directiveUnion = directives.map((directive) => JSON.stringify(directive)).join(" | ") || "never";
  const fields = Object.keys(spec.context).map((name) => `  readonly ${JSON.stringify(name)}: number;`).join("\n");
  const portsDts = [
    "// AUTO-GENERATED BY KADMOS.",
    `export type WorldState = ${stateUnion};`,
    `export type WorldDirective = ${directiveUnion};`,
    `export interface WorldContext {\n${fields}\n}`,
    "export interface StepRecord { readonly step: number; readonly state: WorldState; readonly action: string; readonly eventPayload?: Readonly<Record<string, unknown>>; readonly proposedDirective?: WorldDirective | null; }",
    "export interface TransitionStepRequest { readonly transitionId: string; readonly eventPayload?: Readonly<Record<string, unknown>>; readonly proposedDirective?: WorldDirective | null; }",
    "export interface StepVerdict { readonly allowed: boolean; readonly previousState: WorldState; readonly currentState: WorldState; readonly context: WorldContext; readonly directiveAllowed: WorldDirective | null; readonly violation?: { readonly code: string; readonly message: string; readonly violatedInvariant?: string; readonly shortestCounterexampleTrace: readonly StepRecord[]; }; }",
    "export interface IWorldChecker { getState(): WorldState; getContext(): WorldContext; step(request: TransitionStepRequest): StepVerdict; reset(initialContext?: Partial<WorldContext>): void; }",
  ].join("\n");

  const initial = JSON.stringify(spec.states.find((state) => state.initial)?.id);
  const defaults = JSON.stringify(Object.fromEntries(Object.entries(spec.context).map(([key, value]) => [key, value.default ?? 0])));

  const worldCheckerTs = [
    "// AUTO-GENERATED BY KADMOS.",
    'import type { IWorldChecker, WorldContext, WorldState, TransitionStepRequest, StepVerdict, StepRecord } from "./ports.js";',
    `const world = ${JSON.stringify(spec)} as const;`,
    generatedEvaluator,
    generatedSanitizer,
    "export class WorldChecker implements IWorldChecker {",
    `  private state: WorldState = ${initial} as WorldState;`,
    `  private context: Record<string, number> = ${defaults};`,
    "  private history: StepRecord[] = [];",
    "  private busy: boolean = false;",
    "  constructor() {",
    "    const invalid = this.checkBounds(this.context);",
    '    if (invalid) throw new Error(`INVALID_BOUNDS: ${invalid}`);',
    `    const violated = this.checkInvariants(${initial}, this.context);`,
    '    if (violated) throw new Error(`INITIAL_INVARIANT_FAILED: ${violated}`);',
    "  }",
    "  getState(): WorldState { return this.state; }",
    "  getContext(): WorldContext { return { ...this.context } as unknown as WorldContext; }",
    "  private checkBounds(values: Record<string, number>): string | undefined {",
    "    for (const [key, definition] of Object.entries(world.context)) {",
    "      const value = values[key];",
    "      if (value === undefined || !Number.isSafeInteger(value)) return key;",
    '      if ("min" in definition && typeof definition.min === "number" && value < definition.min) return key;',
    '      if ("max" in definition && typeof definition.max === "number" && value > definition.max) return key;',
    "    }",
    "    return undefined;",
    "  }",
    "  private checkInvariants(atState: string, values: Record<string, number>, event?: Readonly<Record<string, unknown>>): string | undefined {",
    "    const env: Record<string, unknown> = { ...values, state: atState, event: event ?? {} };",
    "    for (const invariant of world.invariants) {",
    "      try {",
    "        const res = evaluateWorld(invariant.predicate, env);",
    '        if (typeof res !== "boolean" || !res) return invariant.id;',
    "      } catch { return invariant.id; }",
    "    }",
    "    return undefined;",
    "  }",
    "  reset(initialContext: Partial<WorldContext> = {}): void {",
    '    if (this.busy) throw new Error("REENTRANCY_DETECTED: reset called during active evaluation");',
    "    this.busy = true;",
    "    const snapshotState = this.state;",
    "    const snapshotContext = { ...this.context };",
    "    const snapshotHistory = [...this.history];",
    "    const rollback = () => { this.state = snapshotState; this.context = { ...snapshotContext }; this.history = [...snapshotHistory]; };",
    "    try {",
    `      const candidate: Record<string, number> = { ...${defaults} };`,
    "      for (const [name, value] of Object.entries(initialContext)) {",
    '        if (!Object.hasOwn(world.context, name) || typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`INVALID_BOUNDS: ${name}`);',
    "        candidate[name] = value;",
    "      }",
    "      const invalid = this.checkBounds(candidate);",
    "      if (invalid) throw new Error(`INVALID_BOUNDS: ${invalid}`);",
    `      const violated = this.checkInvariants(${initial}, candidate);`,
    "      if (violated) throw new Error(`INITIAL_INVARIANT_FAILED: ${violated}`);",
    `      this.state = ${initial} as WorldState;`,
    "      this.context = candidate;",
    "      this.history = [];",
    "    } catch (e) {",
    "      rollback();",
    "      throw e;",
    "    } finally { this.busy = false; }",
    "  }",
    "  step(request: TransitionStepRequest): StepVerdict {",
    '    if (this.busy) throw new Error("REENTRANCY_DETECTED: step called during active evaluation");',
    "    this.busy = true;",
    "    const snapshotState = this.state;",
    "    const snapshotContext = { ...this.context };",
    "    const snapshotHistory = [...this.history];",
    "    const rollback = () => { this.state = snapshotState; this.context = { ...snapshotContext }; this.history = [...snapshotHistory]; };",
    "    try {",
    '      const snapshotAction = typeof request.transitionId === "string" ? request.transitionId : String(request.transitionId ?? "");',
    '      const snapshotDirective = request.proposedDirective === undefined ? undefined : (request.proposedDirective === null ? null : String(request.proposedDirective));',
    "      let safePayload: Record<string, unknown> | undefined;",
    "      try { safePayload = sanitizeWorldPayload(request.eventPayload); } catch (e: unknown) {",
    "        rollback();",
    '        return { allowed: false, previousState: snapshotState, currentState: snapshotState, context: this.getContext(), directiveAllowed: null, violation: { code: "SECURITY_VIOLATION", message: e instanceof Error ? e.message : "Invalid payload", shortestCounterexampleTrace: [...snapshotHistory, { step: snapshotHistory.length + 1, state: snapshotState, action: snapshotAction }] } };',
    "      }",
    "      const record: StepRecord = { step: snapshotHistory.length + 1, state: snapshotState, action: snapshotAction, ...(safePayload === undefined ? {} : { eventPayload: safePayload }), ...(snapshotDirective === undefined ? {} : { proposedDirective: snapshotDirective as Exclude<StepRecord[\"proposedDirective\"], undefined> }) };",
    "      const reject = (code: string, message: string, violatedInvariant?: string): StepVerdict => {",
    "        rollback();",
    "        return { allowed: false, previousState: snapshotState, currentState: snapshotState, context: this.getContext(), directiveAllowed: null, violation: { code, message, ...(violatedInvariant === undefined ? {} : { violatedInvariant }), shortestCounterexampleTrace: [...snapshotHistory, record] } };",
    "      };",
    "      const transition = world.transitions.find((item) => item.id === snapshotAction && item.from === this.state);",
    '      if (!transition) return reject("INVALID_TRANSITION", `Transition "${snapshotAction}" is not legal from state "${this.state}"`);',
    '      if ((snapshotDirective ?? null) !== transition.directive) return reject("UNAUTHORIZED_DIRECTIVE", "Directive does not match declared transition");',
    "      const env = (at: string, values: Record<string, number>): Record<string, unknown> => ({ ...values, state: at, event: safePayload ?? {} });",
    "      try {",
    "        const guardVal = evaluateWorld(transition.guard, env(this.state, this.context));",
    '        if (typeof guardVal !== "boolean" || !guardVal) return reject("GUARD_FAILED", "Guard condition failed");',
    '      } catch (e: unknown) { if (e instanceof Error && e.message.includes("REENTRANCY_DETECTED")) throw e; return reject("GUARD_FAILED", "Guard evaluation failed"); }',
    "      const candidate = { ...this.context };",
    "      try {",
    "        for (const effect of transition.effects) {",
    "          const match = /^([A-Za-z_][A-Za-z_0-9]*)\\s*=\\s*(.+)$/.exec(effect);",
    '          if (!match || !Object.hasOwn(world.context, match[1]!)) return reject("INVALID_EFFECT", "Invalid effect target");',
    "          const value = evaluateWorld(match[2]!, env(transition.to, candidate));",
    '          if (typeof value !== "number" || !Number.isSafeInteger(value)) return reject("INVALID_EFFECT", "Invalid effect result");',
    "          candidate[match[1]!] = value;",
    "        }",
    '      } catch (e: unknown) { if (e instanceof Error && e.message.includes("REENTRANCY_DETECTED")) throw e; return reject("INVALID_EFFECT", "Effect execution failed"); }',
    "      const boundError = this.checkBounds(candidate);",
    '      if (boundError) return reject("INVALID_BOUNDS", `Context bound failed on "${boundError}"`);',
    "      const violatedInv = this.checkInvariants(transition.to, candidate, safePayload);",
    '      if (violatedInv) return reject("INVARIANT_FAILED", `Invariant violation: "${violatedInv}"`, violatedInv);',
    "      this.state = transition.to as WorldState;",
    "      this.context = candidate;",
    "      this.history.push(record);",
    '      return { allowed: true, previousState: snapshotState, currentState: this.state, context: this.getContext(), directiveAllowed: transition.directive as StepVerdict["directiveAllowed"] };',
    "    } finally { this.busy = false; }",
    "  }",
    "}",
  ].join("\n");

  return { portsDts, worldCheckerTs };
}

const generatedSanitizer = `
function sanitizeWorldPayload(raw: unknown, depth: number = 0): Record<string, unknown> | undefined {
  if (depth > 128) throw new Error("SECURITY_VIOLATION: payload depth exceeded");
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_EVENT_PAYLOAD: must be an object");
  const isProxy = (globalThis as { process?: { getBuiltinModule?: (name: string) => { types: { isProxy: (value: unknown) => boolean } } } }).process?.getBuiltinModule?.("node:util")?.types.isProxy;
  if (isProxy?.(raw)) throw new Error("SECURITY_VIOLATION: proxy not permitted in eventPayload");
  if (Object.prototype.toString.call(raw) !== "[object Object]") throw new Error("SECURITY_VIOLATION: non-plain object not permitted in eventPayload");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new Error("SECURITY_VIOLATION: non-plain object prototype not permitted in eventPayload");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(\`SECURITY_VIOLATION: '\${key}' not permitted in eventPayload\`);
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc) continue;
    if (desc.get || desc.set) throw new Error("SECURITY_VIOLATION: accessor property not permitted");
    const val = desc.value;
    let copy: unknown;
    if (typeof val === "object" && val !== null) copy = sanitizeWorldPayload(val, depth + 1);
    else if (typeof val === "function" || typeof val === "symbol") throw new Error("SECURITY_VIOLATION: invalid type");
    else copy = val;
    Object.defineProperty(result, key, { value: copy, writable: true, enumerable: true, configurable: true });
  }
  return result;
}
`;

const generatedEvaluator = `
function booleanWorld(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("INVALID_EXPRESSION: expected boolean");
  return value;
}
function evaluateWorld(expression: string | boolean, env: Record<string, unknown>): unknown {
  if (typeof expression === "boolean") return expression;
  const pattern = /=>|==|!=|>=|<=|&&|\\|\\||[()+\\-*/<>!.]|\\d+(?:\\.\\d+)?|[A-Za-z_][A-Za-z_0-9]*|'(?:[^'\\\\]|\\\\.)*'/g;
  const tokens = expression.match(pattern) ?? [];
  if (tokens.join("") !== expression.replace(/\\s+/g, "")) throw new Error("INVALID_EXPRESSION");
  const priority: Record<string, number> = { "=>": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, ">": 5, ">=": 5, "<": 5, "<=": 5, "+": 6, "-": 6, "*": 7, "/": 7 };
  let index = 0;
  const numeric = (value: unknown): number => { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("INVALID_EXPRESSION"); return value; };
  const parse = (minimum = 0): unknown => {
    const token = tokens[index++];
    if (token === undefined) throw new Error("INVALID_EXPRESSION");
    let left: unknown;
    if (token === "(") { left = parse(); if (tokens[index++] !== ")") throw new Error("INVALID_EXPRESSION"); }
    else if (token === "!" || token === "-") { const operand = parse(8); left = token === "!" ? !booleanWorld(operand) : -numeric(operand); }
    else if (token === "true" || token === "false") left = token === "true";
    else if (token === "null") left = null;
    else if (token.startsWith("'")) left = token.slice(1, -1).replace(/\\\\'/g, "'");
    else if (/^\\d/.test(token)) left = Number(token);
    else if (/^[A-Za-z_]/.test(token)) {
      left = env[token];
      while (tokens[index] === ".") { index++; const property = tokens[index++]; if (!property || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(property)) throw new Error("INVALID_EXPRESSION"); left = left && typeof left === "object" && Object.hasOwn(left, property) ? (left as Record<string, unknown>)[property] : undefined; }
    } else throw new Error("INVALID_EXPRESSION");
    while (true) {
      const operator = tokens[index];
      const rank = operator === undefined ? undefined : priority[operator];
      if (rank === undefined || rank < minimum) break;
      index++;
      const right = parse(rank + (operator === "=>" ? 0 : 1));
      switch (operator) {
        case "=>": { const l = booleanWorld(left); const r = booleanWorld(right); left = !l || r; break; }
        case "||": { const l = booleanWorld(left); const r = booleanWorld(right); left = l || r; break; }
        case "&&": { const l = booleanWorld(left); const r = booleanWorld(right); left = l && r; break; }
        case "==": left = left === right; break;
        case "!=": left = left !== right; break;
        case ">": left = numeric(left) > numeric(right); break;
        case ">=": left = numeric(left) >= numeric(right); break;
        case "<": left = numeric(left) < numeric(right); break;
        case "<=": left = numeric(left) <= numeric(right); break;
        case "+": left = numeric(left) + numeric(right); break;
        case "-": left = numeric(left) - numeric(right); break;
        case "*": left = numeric(left) * numeric(right); break;
        case "/": left = numeric(left) / numeric(right); break;
      }
    }
    return left;
  };
  const result = parse();
  if (index !== tokens.length) throw new Error("INVALID_EXPRESSION");
  return result;
}
`;
