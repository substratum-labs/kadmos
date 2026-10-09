import { types as nodeTypes } from "node:util";
import type { WorldSpec } from "./types/world.js";
import { identifiers } from "./world_expression.js";

export const KADMOS_COMPILER_CONTRACT_VERSION = "kadmos.compiler.k02.v1" as const;

function copyModel(input: unknown, active: WeakSet<object> = new WeakSet()): unknown {
  if (input === null || typeof input !== "object") return input;
  if (nodeTypes.isProxy(input)) throw new Error("INVALID_WORLD: proxy");
  if (active.has(input)) throw new Error("INVALID_WORLD: cycle");
  active.add(input);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (!("value" in descriptor)) throw new Error("INVALID_WORLD: accessor");
    }
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      for (let i = 0; i < input.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor) throw new Error("INVALID_WORLD: sparse list");
        result.push(copyModel(descriptor.value, active));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      Object.defineProperty(result, key, { value: copyModel(descriptor.value, active), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { active.delete(input); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_WORLD: ${label}`);
  return value as Record<string, unknown>;
}

export function admitWorldSpec(input: unknown): WorldSpec {
  const raw = object(copyModel(input), "root");
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
    if (variable.type === "string") {
      if (typeof variable.default !== "string" || variable.min !== undefined || variable.max !== undefined) throw new Error(`INVALID_BOUNDS: ${name}`);
      continue;
    }
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

  const allowed = new Set([...Object.keys(context), "state", "event", "request"]);
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
  for (const transition of transitions) {
    const directive = Object.hasOwn(transition, "directive") ? transition.directive : null;
    if (directive !== null && (typeof directive !== "string" || directive.length === 0)) throw new Error("INVALID_WORLD: directive");
    transition.directive = directive;
  }
  return raw as unknown as WorldSpec;
}
