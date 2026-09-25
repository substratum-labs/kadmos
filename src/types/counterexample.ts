/** A minimal, ordered prefix of accepted steps plus the rejected attempt. */
export interface StepRecord {
  readonly step: number;
  readonly state: string;
  readonly action: string;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
  readonly proposedDirective?: string | null;
}

export interface CounterexampleTrace {
  readonly violatedInvariant: string;
  readonly reason: string;
  readonly shortestCounterexampleTrace: readonly StepRecord[];
  readonly remediationDirective?: string;
}
