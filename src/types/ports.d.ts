import type { StepRecord } from "./counterexample.js";

/** Contract mirrored by the compiler's disposable ports.d.ts projection. */
export type WorldState = string;
export type WorldDirective = string;
export type WorldContext = Readonly<Record<string, number>>;

export interface TransitionStepRequest {
  readonly transitionId: string;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
  readonly proposedDirective?: WorldDirective | null;
}

export interface StepVerdict {
  readonly allowed: boolean;
  readonly previousState: WorldState;
  readonly currentState: WorldState;
  readonly context: WorldContext;
  readonly directiveAllowed: WorldDirective | null;
  readonly violation?: {
    readonly code: string;
    readonly message: string;
    readonly violatedInvariant?: string;
    readonly shortestCounterexampleTrace: readonly StepRecord[];
  };
}

export interface IWorldChecker {
  getState(): WorldState;
  getContext(): WorldContext;
  step(request: TransitionStepRequest): StepVerdict;
  reset(initialContext?: Partial<WorldContext>): void;
}
