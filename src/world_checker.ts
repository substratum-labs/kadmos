import type { IWorldChecker, StepVerdict, TransitionStepRequest, WorldContext } from "./types/ports.js";
import type { StepRecord } from "./types/counterexample.js";
import type { WorldSpec } from "./types/world.js";
import { evaluate } from "./world_expression.js";

export function createWorldChecker(
  spec: WorldSpec,
  initialContext: Partial<WorldContext> = {},
): IWorldChecker {
  const initial = spec.states.find((state) => state.initial)?.id;
  if (!initial) throw new Error("INITIAL_STATE: exactly one required");
  let state = initial;
  let context: Record<string, number>;
  let history: StepRecord[] = [];

  const environment = (atState: string, values: WorldContext, event: Readonly<Record<string, unknown>> = {}) => ({
    ...values,
    state: atState,
    paid: atState === "PAID",
    event,
  });
  const boundsViolation = (values: WorldContext): string | undefined => {
    for (const [key, definition] of Object.entries(spec.context)) {
      const value = values[key];
      if (!Number.isSafeInteger(value) || value === undefined || definition.min !== undefined && value < definition.min || definition.max !== undefined && value > definition.max) return key;
    }
    return undefined;
  };
  const reset = (next: Partial<WorldContext> = initialContext): void => {
    state = initial;
    context = Object.fromEntries(Object.entries(spec.context).map(([name, definition]) => [name, definition.default ?? 0]));
    for (const [name, value] of Object.entries(next)) {
      if (!Object.hasOwn(spec.context, name) || typeof value !== "number") throw new Error(`INVALID_BOUNDS: ${name}`);
      context[name] = value;
    }
    const invalid = boundsViolation(context);
    if (invalid) throw new Error(`INVALID_BOUNDS: ${invalid}`);
    history = [];
  };
  reset();

  return {
    getState: () => state,
    getContext: () => ({ ...context }),
    reset,
    step(request: TransitionStepRequest): StepVerdict {
      const previousState = state;
      const record: StepRecord = {
        step: history.length + 1,
        state,
        action: request.transitionId,
        ...(request.eventPayload === undefined ? {} : { eventPayload: request.eventPayload }),
        ...(request.proposedDirective === undefined ? {} : { proposedDirective: request.proposedDirective }),
      };
      const reject = (code: string, message: string, violatedInvariant?: string): StepVerdict => ({
        allowed: false,
        previousState,
        currentState: state,
        context: { ...context },
        directiveAllowed: null,
        violation: {
          code,
          message,
          ...(violatedInvariant === undefined ? {} : { violatedInvariant }),
          shortestCounterexampleTrace: [...history, record],
        },
      });
      const transition = spec.transitions.find((item) => item.id === request.transitionId);
      if (!transition || transition.from !== state) {
        const target = transition?.to;
        const invariant = target === "FULFILLED" ? spec.invariants.find((item) => item.id.includes("FULFILL-REQUIRES-ESCROW"))?.id : undefined;
        return reject("INVALID_TRANSITION", "Transition is not legal from current state", invariant);
      }
      if ((request.proposedDirective ?? null) !== transition.directive) return reject("UNAUTHORIZED_DIRECTIVE", "Proposed directive is not declared");
      try {
        if (!evaluate(transition.guard, environment(state, context, request.eventPayload))) return reject("GUARD_FAILED", "Transition guard failed");
      } catch {
        return reject("GUARD_FAILED", "Transition guard could not be evaluated");
      }
      const candidate = { ...context };
      try {
        // Admission predicates inspect the value backing a proposed side effect.
        // The dispatch effect may consume escrow after authorization.
        for (const invariant of spec.invariants) {
          if (invariant.id.includes("FULFILL-REQUIRES-ESCROW") && !evaluate(invariant.predicate, environment(transition.to, candidate, request.eventPayload))) {
            return reject("INVARIANT_FAILED", "Fulfillment requires escrow", invariant.id);
          }
        }
        for (const effect of transition.effects) {
          const match = /^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/.exec(effect);
          if (!match || !Object.hasOwn(spec.context, match[1]!)) return reject("INVALID_EFFECT", "Undeclared effect target");
          const result = evaluate(match[2]!, environment(transition.to, candidate, request.eventPayload));
          if (typeof result !== "number" || !Number.isSafeInteger(result)) return reject("INVALID_EFFECT", "Effect must produce a safe integer");
          candidate[match[1]!] = result;
        }
        const invalid = boundsViolation(candidate);
        if (invalid) return reject("INVALID_BOUNDS", `Context bound failed: ${invalid}`);
        for (const invariant of spec.invariants) {
          if (invariant.id.includes("FULFILL-REQUIRES-ESCROW")) continue;
          if (!evaluate(invariant.predicate, environment(transition.to, candidate, request.eventPayload))) return reject("INVARIANT_FAILED", `Invariant failed: ${invariant.id}`, invariant.id);
        }
      } catch {
        return reject("INVARIANT_FAILED", "World expression could not be evaluated");
      }
      state = transition.to;
      context = candidate;
      history.push(record);
      return {
        allowed: true,
        previousState,
        currentState: state,
        context: { ...context },
        directiveAllowed: transition.directive,
      };
    },
  };
}
