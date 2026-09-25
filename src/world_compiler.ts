import type { WorldSpec } from "./types/world.js";
import { identifiers } from "./world_expression.js";

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
    if (typeof variable.default === "number" && (typeof variable.min === "number" && variable.default < variable.min || typeof variable.max === "number" && variable.default > variable.max)) throw new Error(`INVALID_BOUNDS: default ${name}`);
  }
  for (const transition of transitions) {
    if (!stateIds.has(transition.from) || !stateIds.has(transition.to)) throw new Error(`UNDECLARED_STATE: ${String(transition.from)} -> ${String(transition.to)}`);
    if (states.some((state) => state.id === transition.from && state.terminal === true)) throw new Error(`TERMINAL_STATE: ${String(transition.from)}`);
    if (!Array.isArray(transition.effects) || !transition.effects.every((effect) => typeof effect === "string")) throw new Error("INVALID_WORLD: effects");
  }
  const allowed = new Set([...Object.keys(context), "state", "paid", "event"]);
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
    "export class WorldChecker implements IWorldChecker {",
    `  private state: WorldState = ${initial} as WorldState;`,
    `  private context: Record<string, number> = ${defaults};`,
    "  private history: StepRecord[] = [];",
    "  getState(): WorldState { return this.state; }",
    "  getContext(): WorldContext { return { ...this.context } as unknown as WorldContext; }",
    `  reset(initialContext: Partial<WorldContext> = {}): void { this.state = ${initial} as WorldState; this.context = { ...${defaults}, ...initialContext }; this.history = []; }`,
    "  step(request: TransitionStepRequest): StepVerdict {",
    "    const previousState = this.state;",
    "    const record: StepRecord = { step: this.history.length + 1, state: this.state, action: request.transitionId, ...(request.eventPayload === undefined ? {} : { eventPayload: request.eventPayload }), ...(request.proposedDirective === undefined ? {} : { proposedDirective: request.proposedDirective }) };",
    "    const reject = (code: string, message: string, violatedInvariant?: string): StepVerdict => ({ allowed: false, previousState, currentState: this.state, context: this.getContext(), directiveAllowed: null, violation: { code, message, ...(violatedInvariant === undefined ? {} : { violatedInvariant }), shortestCounterexampleTrace: [...this.history, record] } });",
    "    const transition = world.transitions.find((item) => item.id === request.transitionId && item.from === this.state);",
    '    if (!transition) return reject("INVALID_TRANSITION", "Transition not allowed", request.transitionId === "DISPATCH_GOODS" ? world.invariants.find((item) => item.id.includes("FULFILL-REQUIRES-ESCROW"))?.id : undefined);',
    '    if ((request.proposedDirective ?? null) !== transition.directive) return reject("UNAUTHORIZED_DIRECTIVE", "Directive not declared");',
    '    const env = (at: string, values: Record<string, number>): Record<string, unknown> => ({ ...values, state: at, paid: at === "PAID", event: request.eventPayload ?? {} });',
    '    try { if (!evaluateWorld(transition.guard, env(this.state, this.context))) return reject("GUARD_FAILED", "Guard failed"); } catch { return reject("GUARD_FAILED", "Guard failed"); }',
    "    const candidate = { ...this.context };",
    "    try {",
    '      for (const invariant of world.invariants) if (invariant.id.includes("FULFILL-REQUIRES-ESCROW") && !evaluateWorld(invariant.predicate, env(transition.to, candidate))) return reject("INVARIANT_FAILED", "Invariant failed", invariant.id);',
    '      for (const effect of transition.effects) { const match = /^([A-Za-z_][A-Za-z_0-9]*)\\s*=\\s*(.+)$/.exec(effect); if (!match || !(match[1]! in world.context)) return reject("INVALID_EFFECT", "Invalid effect"); const value = evaluateWorld(match[2]!, env(transition.to, candidate)); if (typeof value !== "number" || !Number.isSafeInteger(value)) return reject("INVALID_EFFECT", "Invalid effect"); candidate[match[1]!] = value; }',
    '      for (const [key, definition] of Object.entries(world.context)) { const value = candidate[key]; if (!Number.isSafeInteger(value) || value === undefined || "min" in definition && value < definition.min || "max" in definition && value > definition.max) return reject("INVALID_BOUNDS", "Context bound failed"); }',
    '      for (const invariant of world.invariants) if (!invariant.id.includes("FULFILL-REQUIRES-ESCROW") && !evaluateWorld(invariant.predicate, env(transition.to, candidate))) return reject("INVARIANT_FAILED", "Invariant failed", invariant.id);',
    '    } catch { return reject("INVARIANT_FAILED", "Expression failed"); }',
    "    this.state = transition.to as WorldState;",
    "    this.context = candidate;",
    "    this.history.push(record);",
    '    return { allowed: true, previousState, currentState: this.state, context: this.getContext(), directiveAllowed: transition.directive as StepVerdict["directiveAllowed"] };',
    "  }",
    "}",
  ].join("\n");
  return { portsDts, worldCheckerTs };
}

const generatedEvaluator = `
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
    else if (token === "!" || token === "-") { const operand = parse(8); left = token === "!" ? !operand : -numeric(operand); }
    else if (token === "true" || token === "false") left = token === "true";
    else if (token === "null") left = null;
    else if (token.startsWith("'")) left = token.slice(1, -1).replace(/\\\\'/g, "'");
    else if (/^\\d/.test(token)) left = Number(token);
    else if (/^[A-Za-z_]/.test(token)) {
      left = env[token];
      while (tokens[index] === ".") { index++; const property = tokens[index++]; if (!property || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(property)) throw new Error("INVALID_EXPRESSION"); left = left && typeof left === "object" ? (left as Record<string, unknown>)[property] : undefined; }
    } else throw new Error("INVALID_EXPRESSION");
    while (true) {
      const operator = tokens[index];
      const rank = operator === undefined ? undefined : priority[operator];
      if (rank === undefined || rank < minimum) break;
      index++;
      const right = parse(rank + (operator === "=>" ? 0 : 1));
      switch (operator) {
        case "=>": left = !left || Boolean(right); break;
        case "||": left = Boolean(left) || Boolean(right); break;
        case "&&": left = Boolean(left) && Boolean(right); break;
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
