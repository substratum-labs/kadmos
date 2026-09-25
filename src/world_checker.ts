import type { IWorldChecker, StepVerdict, TransitionStepRequest, WorldContext } from "./types/ports.js";
import type { StepRecord } from "./types/counterexample.js";
import type { WorldSpec } from "./types/world.js";
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

export function sanitizePayload(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_EVENT_PAYLOAD: must be an object");
  const result: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc) continue;
    if (desc.get || desc.set) {
      throw new Error(`SECURITY_VIOLATION: accessor property '${key}' not permitted in eventPayload`);
    }
    const val = desc.value;
    if (typeof val === "object" && val !== null) {
      result[key] = sanitizePayload(val);
    } else if (typeof val === "function" || typeof val === "symbol") {
      throw new Error(`SECURITY_VIOLATION: ${typeof val} not permitted in eventPayload`);
    } else {
      result[key] = val;
    }
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
  let context: Record<string, number> = {};
  let history: StepRecord[] = [];
  let busy = false;

  const env = (atState: string, values: Record<string, number>, eventPayload?: Readonly<Record<string, unknown>>) => ({
    ...values,
    state: atState,
    event: eventPayload ?? {},
  });

  const checkBounds = (values: Record<string, number>): string | undefined => {
    for (const [key, definition] of Object.entries(spec.context)) {
      const value = values[key];
      if (value === undefined || !Number.isSafeInteger(value)) return key;
      if (definition.min !== undefined && value < definition.min) return key;
      if (definition.max !== undefined && value > definition.max) return key;
    }
    return undefined;
  };

  const checkInvariants = (atState: string, values: Record<string, number>, eventPayload?: Readonly<Record<string, unknown>>): string | undefined => {
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
      const candidateContext: Record<string, number> = Object.fromEntries(
        Object.entries(spec.context).map(([name, definition]) => [name, definition.default ?? 0]),
      );
      for (const [name, value] of Object.entries(next)) {
        if (!Object.hasOwn(spec.context, name) || typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new Error(`INVALID_BOUNDS: ${name}`);
        }
        candidateContext[name] = value;
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
      const snapshotHistory = [...history];

      const rollback = () => {
        state = snapshotState;
        context = { ...snapshotContext };
        history = [...snapshotHistory];
      };

      try {
        let safePayload: Record<string, unknown> | undefined;
        try {
          safePayload = sanitizePayload(request.eventPayload);
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
                action: request.transitionId,
              }],
            },
          };
        }

        const record: StepRecord = {
          step: snapshotHistory.length + 1,
          state: snapshotState,
          action: request.transitionId,
          ...(safePayload === undefined ? {} : { eventPayload: safePayload }),
          ...(request.proposedDirective === undefined ? {} : { proposedDirective: request.proposedDirective }),
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
              shortestCounterexampleTrace: [...snapshotHistory, record],
            },
          };
        };

        const transition = spec.transitions.find((item) => item.id === request.transitionId && item.from === state);
        if (!transition) {
          return reject("INVALID_TRANSITION", `Transition '${request.transitionId}' is not legal from state '${state}'`);
        }

        if ((request.proposedDirective ?? null) !== transition.directive) {
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
            if (typeof value !== "number" || !Number.isSafeInteger(value)) {
              return reject("INVALID_EFFECT", "Effect expression did not yield an integer");
            }
            candidateContext[match[1]!] = value;
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
        history.push(record);

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
