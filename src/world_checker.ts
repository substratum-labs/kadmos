import type { IWorldChecker, StepVerdict, TransitionStepRequest, WorldContext } from "./types/ports.js";
import type { StepRecord } from "./types/counterexample.js";
import type { WorldSpec } from "./types/world.js";
import { types as nodeTypes } from "node:util";
import { evaluate } from "./world_expression.js";

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === "object" && val !== null && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export function sanitizePayload(raw: unknown, depth: number = 0, seen: Set<object> = new Set<object>()): Record<string, unknown> | undefined {
  if (depth > 128) throw new Error("SECURITY_VIOLATION: payload depth exceeded");
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_EVENT_PAYLOAD: must be an object");
  if (nodeTypes.isProxy(raw)) throw new Error("SECURITY_VIOLATION: proxy not permitted in eventPayload");
  if (seen.has(raw)) throw new Error("SECURITY_VIOLATION: cyclic or shared object graph in payload");
  if (seen.size >= 128) throw new Error("SECURITY_VIOLATION: payload node count exceeded");
  seen.add(raw);
  if (Object.prototype.toString.call(raw) !== "[object Object]") {
    throw new Error("SECURITY_VIOLATION: non-plain object not permitted in eventPayload");
  }
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("SECURITY_VIOLATION: non-plain object prototype not permitted in eventPayload");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`SECURITY_VIOLATION: '${key}' not permitted in eventPayload`);
    }
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc) continue;
    if (desc.get || desc.set) {
      throw new Error(`SECURITY_VIOLATION: accessor property '${key}' not permitted in eventPayload`);
    }
    const val = desc.value;
    let copy: unknown;
    if (typeof val === "object" && val !== null) {
      copy = sanitizePayload(val, depth + 1, seen);
    } else if (typeof val === "function" || typeof val === "symbol") {
      throw new Error(`SECURITY_VIOLATION: ${typeof val} not permitted in eventPayload`);
    } else {
      copy = val;
    }
    Object.defineProperty(result, key, { value: copy, writable: true, enumerable: true, configurable: true });
  }
  return result;
}

export function createWorldChecker(
  rawSpec: WorldSpec,
  rawInitialContext: Partial<WorldContext> = {},
): IWorldChecker {
  const spec = deepFreeze(structuredClone(rawSpec));
  const frozenDefaultContext = Object.freeze(structuredClone(rawInitialContext));
  const initial = spec.states.find((state) => state.initial)?.id;
  if (!initial) throw new Error("INITIAL_STATE: exactly one required");

  let state = initial;
  let context: Record<string, number | string> = {};
  let history: StepRecord[] = [];
  let busy = false;

  const env = (atState: string, values: Record<string, number | string>, eventPayload?: Readonly<Record<string, unknown>>) => ({
    ...values,
    state: atState,
    event: eventPayload ?? {},
    request: eventPayload ?? {},
  });

  const checkBounds = (values: Record<string, number | string>): string | undefined => {
    for (const [key, definition] of Object.entries(spec.context)) {
      const value = values[key];
      if (definition.type === "string" ? typeof value !== "string" : typeof value !== "number" || !Number.isSafeInteger(value)) return key;
      if (definition.min !== undefined && typeof value === "number" && value < definition.min) return key;
      if (definition.max !== undefined && typeof value === "number" && value > definition.max) return key;
    }
    return undefined;
  };

  const checkInvariants = (atState: string, values: Record<string, number | string>, eventPayload?: Readonly<Record<string, unknown>>): string | undefined => {
    const environment = env(atState, values, eventPayload);
    for (const invariant of spec.invariants) {
      try {
        const result = evaluate(invariant.predicate, environment);
        if (typeof result !== "boolean" || !result) {
          return invariant.id;
        }
      } catch {
        return invariant.id;
      }
    }
    return undefined;
  };

  const reset = (next: Partial<WorldContext> = frozenDefaultContext): void => {
    if (busy) throw new Error("REENTRANCY_DETECTED: reset called during active evaluation");
    busy = true;

    const snapshotState = state;
    const snapshotContext = { ...context };
    const snapshotHistory = [...history];

    const rollback = () => {
      state = snapshotState;
      context = { ...snapshotContext };
      history = [...snapshotHistory];
    };

    try {
      const candidateContext: Record<string, number | string> = Object.fromEntries(
        Object.entries(spec.context).map(([name, definition]) => [name, definition.default ?? 0]),
      );
      for (const [name, value] of Object.entries(next)) {
        if (!Object.hasOwn(spec.context, name) || (spec.context[name]!.type === "string" ? typeof value !== "string" : typeof value !== "number" || !Number.isSafeInteger(value))) {
          throw new Error(`INVALID_BOUNDS: ${name}`);
        }
        candidateContext[name] = value as string | number;
      }
      const invalidBound = checkBounds(candidateContext);
      if (invalidBound) {
        throw new Error(`INVALID_BOUNDS: ${invalidBound}`);
      }

      const violatedInvariant = checkInvariants(initial, candidateContext);
      if (violatedInvariant) {
        throw new Error(`INITIAL_INVARIANT_FAILED: ${violatedInvariant}`);
      }

      // Publish only after all validations pass atomically
      state = initial;
      context = candidateContext;
      history = [];
    } catch (err) {
      rollback();
      throw err;
    } finally {
      busy = false;
    }
  };

  reset();

  return {
    getState: () => state,
    getContext: () => ({ ...context }),
    reset,
    step(request: TransitionStepRequest): StepVerdict {
      if (busy) throw new Error("REENTRANCY_DETECTED: step called during active evaluation");
      busy = true;

      const snapshotState = state;
      const snapshotContext = { ...context };
      const snapshotHistory = structuredClone(history);

      const rollback = () => {
        state = snapshotState;
        context = { ...snapshotContext };
        history = structuredClone(snapshotHistory);
      };

      try {
        const rejectRequest = (message: string): StepVerdict => {
          rollback();
          return {
            allowed: false, previousState: snapshotState, currentState: snapshotState,
            context: { ...snapshotContext }, directiveAllowed: null,
            violation: { code: "SECURITY_VIOLATION", message,
              shortestCounterexampleTrace: [...snapshotHistory, { step: snapshotHistory.length + 1, state: snapshotState, action: "<invalid>" }]
                .map((r) => deepFreeze(structuredClone(r))) },
          };
        };
        if (request === null || typeof request !== "object" || nodeTypes.isProxy(request) || Array.isArray(request)) {
          return rejectRequest("step request must be an object");
        }
        const descAction = Object.getOwnPropertyDescriptor(request, "transitionId");
        const descDirective = Object.getOwnPropertyDescriptor(request, "proposedDirective");
        const descPayload = Object.getOwnPropertyDescriptor(request, "eventPayload");
        if (descAction?.get || descAction?.set || descDirective?.get || descDirective?.set || descPayload?.get || descPayload?.set) {
          return rejectRequest("Accessor property not permitted on step request");
        }
        if (typeof descAction?.value !== "string") return rejectRequest("transitionId must be a string");
        if (descDirective?.value !== undefined && descDirective?.value !== null && typeof descDirective?.value !== "string") {
          return rejectRequest("proposedDirective must be a string, null, or undefined");
        }
        const snapshotAction: string = descAction.value;
        const snapshotDirective: string | null = descDirective?.value ?? null;
        let safePayload: Record<string, unknown> | undefined;
        try {
          safePayload = sanitizePayload(descPayload?.value);
        } catch (e: unknown) {
          rollback();
          return {
            allowed: false,
            previousState: snapshotState,
            currentState: snapshotState,
            context: { ...snapshotContext },
            directiveAllowed: null,
            violation: {
              code: "SECURITY_VIOLATION",
              message: e instanceof Error ? e.message : "Invalid payload",
              shortestCounterexampleTrace: [...snapshotHistory, {
                step: snapshotHistory.length + 1,
                state: snapshotState,
                action: snapshotAction,
              }].map((r) => deepFreeze(structuredClone(r))),
            },
          };
        }

        const record: StepRecord = {
          step: snapshotHistory.length + 1,
          state: snapshotState,
          action: snapshotAction,
          ...(safePayload === undefined ? {} : { eventPayload: safePayload }),
          ...(descDirective === undefined ? {} : { proposedDirective: snapshotDirective }),
        };

        const reject = (code: string, message: string, violatedInvariant?: string): StepVerdict => {
          rollback();
          return {
            allowed: false,
            previousState: snapshotState,
            currentState: snapshotState,
            context: { ...snapshotContext },
            directiveAllowed: null,
            violation: {
              code,
              message,
              ...(violatedInvariant === undefined ? {} : { violatedInvariant }),
              shortestCounterexampleTrace: [...snapshotHistory, record].map((r) => deepFreeze(structuredClone(r))),
            },
          };
        };

        const transition = spec.transitions.find((item) => item.id === snapshotAction && item.from === snapshotState);
        if (!transition) {
          return reject(spec.states.some((item) => item.id === snapshotState && item.terminal) ? "ILLEGAL_TRANSITION" : "INVALID_TRANSITION", `Transition '${snapshotAction}' is not legal from state '${snapshotState}'`);
        }

        if ((snapshotDirective ?? null) !== transition.directive) {
          return reject("UNAUTHORIZED_DIRECTIVE", "Directive does not match declared transition");
        }

        // Evaluate guard strictly requiring boolean true
        try {
          const guardValue = evaluate(transition.guard, env(state, context, safePayload));
          if (typeof guardValue !== "boolean" || !guardValue) {
            return reject("GUARD_FAILED", "Guard condition failed");
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes("REENTRANCY_DETECTED")) throw e;
          return reject("GUARD_FAILED", "Guard expression evaluation failed");
        }

        // Candidate post-state effect calculation
        const candidateContext = { ...context };
        try {
          for (const effect of transition.effects) {
            const match = /^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/.exec(effect);
            if (!match || !Object.hasOwn(spec.context, match[1]!)) {
              return reject("INVALID_EFFECT", "Invalid effect assignment target");
            }
            const value = evaluate(match[2]!, env(transition.to, candidateContext, safePayload));
            if (spec.context[match[1]!]!.type === "string" ? typeof value !== "string" : typeof value !== "number" || !Number.isSafeInteger(value)) {
              return reject("INVALID_EFFECT", "Effect expression has wrong type");
            }
            candidateContext[match[1]!] = value as string | number;
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes("REENTRANCY_DETECTED")) throw e;
          return reject("INVALID_EFFECT", "Effect evaluation failed");
        }

        // Check context bounds
        const boundError = checkBounds(candidateContext);
        if (boundError) {
          return reject("INVALID_BOUNDS", `Context bound failed on '${boundError}'`);
        }

        // Check all invariants on post-state
        const violatedInvariant = checkInvariants(transition.to, candidateContext, safePayload);
        if (violatedInvariant) {
          return reject("INVARIANT_FAILED", `Invariant violation: '${violatedInvariant}'`, violatedInvariant);
        }

        // Commit state transition atomically
        state = transition.to;
        context = candidateContext;
        history.push(deepFreeze(record));

        return {
          allowed: true,
          previousState: snapshotState,
          currentState: state,
          context: { ...context },
          directiveAllowed: transition.directive as StepVerdict["directiveAllowed"],
        };
      } finally {
        busy = false;
      }
    },
  };
}
