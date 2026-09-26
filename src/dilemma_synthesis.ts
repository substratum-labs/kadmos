import { serializeWorldSpec, type BoundaryInferenceResult } from "./boundary_inference.js";
import { parseWorldSpec } from "./world_compiler.js";
import type { WorldSpec } from "./types/world.js";

export interface WorldPatch {
  readonly removeTransitions?: readonly string[];
  readonly refineTransitions?: readonly { readonly id: string; readonly guard: string | boolean; readonly to?: string; readonly effects?: readonly string[] }[];
  readonly states?: readonly { readonly id: string; readonly initial?: boolean; readonly terminal?: boolean }[];
  readonly context?: Readonly<Record<string, { readonly type: "integer"; readonly min?: number; readonly max?: number; readonly default?: number }>>;
  readonly invariants?: readonly { readonly id: string; readonly description?: string; readonly predicate: string }[];
  readonly transitions?: readonly { readonly id: string; readonly from: string; readonly to: string; readonly guard: string | boolean; readonly directive?: string | null; readonly effects?: readonly string[] }[];
}

export interface LegislativeDilemma {
  readonly id: string;
  readonly title: string;
  readonly worstCaseTrace: readonly string[];
  readonly optionA: { readonly description: string; readonly patch: WorldPatch };
  readonly optionB: { readonly description: string; readonly fabricGuidance: string };
}

const bounded = { type: "integer" as const, min: 0, max: 1_000_000_000, default: 0 };
const boundedNonce = { type: "integer" as const, min: 0, max: 1, default: 0 };
const canonicalContext = {
  order_amount: bounded,
  settled_amount: bounded,
  refunded_amount: bounded,
  settlement_nonce: boundedNonce,
};

function sameGuard(left: string | boolean, right: string | boolean): boolean {
  return (left === "true" ? true : left) === (right === "true" ? true : right);
}

export function applyLegislationPatch(baseSpec: WorldSpec, patch: WorldPatch): WorldSpec {
  const states = baseSpec.states.map((state) => ({ ...state }));
  for (const state of patch.states ?? []) {
    const index = states.findIndex((item) => item.id === state.id);
    if (index !== -1) {
      const existing = states[index]!;
      if (state.initial === true && existing.initial !== true) throw new Error(`CONFLICTING_STATE: ${state.id}`);
      states[index] = { ...existing, ...state };
      continue;
    }
    states.push({ ...state });
  }
  const context = { ...baseSpec.context };
  for (const [name, field] of Object.entries(patch.context ?? {})) {
    const existing = context[name];
    const restoresCanonicalCeiling = Object.hasOwn(canonicalContext, name)
      && field.max === canonicalContext[name as keyof typeof canonicalContext].max
      && field.min === 0 && field.default === 0;
    if (existing && (field.min !== undefined && existing.min !== undefined && field.min < existing.min || field.max !== undefined && existing.max !== undefined && field.max > existing.max && !restoresCanonicalCeiling)) throw new Error(`CONFLICTING_BOUNDS: ${name}`);
    context[name] = { ...existing, ...field };
  }
  const invariants = baseSpec.invariants.map((item) => ({ ...item }));
  for (const invariant of patch.invariants ?? []) {
    const sameId = invariants.find((item) => item.id === invariant.id);
    if (sameId) {
      if (sameId.predicate !== invariant.predicate) throw new Error(`CONFLICTING_INVARIANT: ${invariant.id}`);
      continue;
    }
    if (!invariants.some((item) => item.predicate === invariant.predicate)) invariants.push({ ...invariant });
  }
  const removed = new Set(patch.removeTransitions ?? []);
  const transitions = baseSpec.transitions.filter((item) => !removed.has(item.id)).map((item) => ({ ...item, effects: [...item.effects] }));
  for (const refinement of patch.refineTransitions ?? []) {
    const index = transitions.findIndex((item) => item.id === refinement.id);
    if (index !== -1) transitions[index] = { ...transitions[index]!, guard: refinement.guard, to: refinement.to ?? transitions[index]!.to, effects: [...(refinement.effects ?? transitions[index]!.effects)] };
  }
  const addedPatchIds = new Set<string>();
  for (const candidate of patch.transitions ?? []) {
    const transition = { ...candidate, directive: candidate.directive ?? null, effects: [...(candidate.effects ?? [])] };
    const sameId = transitions.find((item) => item.id === transition.id);
    if (sameId && sameId.from === transition.from && sameId.to === transition.to && sameGuard(sameId.guard, transition.guard)
      && sameId.directive === transition.directive && JSON.stringify(sameId.effects) === JSON.stringify(transition.effects)) continue;
    for (let index = transitions.length - 1; index >= 0; index--) {
      const existing = transitions[index]!;
      if (!addedPatchIds.has(existing.id) && (existing.id === transition.id || existing.from === transition.from && existing.to === transition.to)) transitions.splice(index, 1);
    }
    transitions.push(transition);
    addedPatchIds.add(transition.id);
  }
  return parseWorldSpec(serializeWorldSpec({ ...baseSpec, states, context, invariants, transitions }));
}

export function synthesizeDilemmas(result: BoundaryInferenceResult): LegislativeDilemma[] {
  const source = result.inputContent;
  const dilemmas: LegislativeDilemma[] = [];
  const states = result.worldSpec.states;
  const initial = states.find((state) => state.initial)!.id;
  const paymentPending = states.some((state) => state.id === "PAYMENT_PENDING") ? "PAYMENT_PENDING" : initial;
  const hazardous = result.worldSpec.transitions.filter((transition) => transition.directive && /PAYMENT|RPC|HTTP_REQUEST/.test(transition.directive));
  const paymentDirectives = hazardous.filter((transition) => transition.directive && /PAYMENT/.test(transition.directive));
  if (/cancel/i.test(source) && /payment|capture|paid|charge/i.test(source)) {
    dilemmas.push({
      id: "DIL-001", title: "Concurrent cancellation and payment capture",
      worstCaseTrace: [
        "Order enters PAYMENT_PENDING; payment capture is dispatched.",
        "Cancellation is accepted while the gateway capture remains in flight.",
        "A delayed payment success arrives after cancellation; funds may be captured without a legal settlement path.",
      ],
      optionA: {
        description: "Elevate to World law: add an atomic cancellation/capture guard and an arbitration state before either terminal outcome.",
        patch: {
          states: [{ id: "ARBITRATION" }, { id: "REFUNDED", terminal: true }, { id: "SETTLED", terminal: true }],
          context: {
            escrow_balance: result.worldSpec.context.escrow_balance ?? bounded,
            ...canonicalContext,
          },
          removeTransitions: paymentDirectives.map((transition) => transition.id),
          transitions: [
            { id: "RECORD_ORDER_AMOUNT", from: initial, to: initial, guard: "event.amount >= 0", effects: ["order_amount = event.amount"] },
            { id: "ENTER_CANCELLATION_ARBITRATION", from: paymentPending, to: "ARBITRATION", guard: true },
            { id: "CAPTURE_AFTER_ARBITRATION", from: "ARBITRATION", to: "SETTLED", guard: "escrow_balance == 0 && event.amount > 0 && event.amount <= order_amount", directive: "DISPATCH_PAYMENT", effects: ["settled_amount = event.amount"] },
            { id: "SETTLE_AFTER_ARBITRATION", from: "ARBITRATION", to: "SETTLED", guard: "escrow_balance > 0 && settled_amount + escrow_balance <= order_amount", effects: ["settled_amount = settled_amount + escrow_balance", "escrow_balance = 0"] },
            { id: "REFUND_AFTER_ARBITRATION", from: "ARBITRATION", to: "REFUNDED", guard: "escrow_balance > 0 && refunded_amount + escrow_balance <= order_amount", directive: "DISPATCH_REFUND", effects: ["refunded_amount = refunded_amount + escrow_balance", "escrow_balance = 0"] },
            { id: "CLOSE_EMPTY_ARBITRATION", from: "ARBITRATION", to: "REFUNDED", guard: "escrow_balance == 0" },
          ],
        },
      },
      optionB: { description: "Leave in Fabric policy: use an asynchronous reconciliation and refund retry workflow.", fabricGuidance: "Deduplicate payment webhooks and reconcile in-flight captures before issuing idempotent refunds." },
    });
  }
  if (/timeout|deadline|in.flight|in-flight/i.test(source) && /rpc|payment|charge|fetch|retry/i.test(source)) {
    dilemmas.push({
      id: "DIL-002", title: "Timeout on an in-flight external RPC",
      worstCaseTrace: [
        "World permits one external payment or RPC directive.",
        "The request reaches the provider, but the local client times out before receiving an acknowledgement.",
        "Fabric retries the uncertain request; the provider may apply the side effect twice.",
      ],
      optionA: {
        description: "Elevate to World law: require a guarded idempotency key and explicit unknown-outcome state before retry.",
        patch: {
          states: [{ id: "OUTCOME_UNKNOWN" }, { id: "FAILED", terminal: true }],
          context: canonicalContext,
          refineTransitions: hazardous.map((transition) => ({ id: transition.id, guard: "settlement_nonce == 0", to: "OUTCOME_UNKNOWN", effects: ["settlement_nonce = 1"] })),
          transitions: [
            { id: "RECORD_UNCERTAIN_OUTCOME", from: paymentPending, to: "OUTCOME_UNKNOWN", guard: "settlement_nonce == 0", effects: ["settlement_nonce = 1"] },
            { id: "RESOLVE_UNKNOWN_AS_FAILED", from: "OUTCOME_UNKNOWN", to: "FAILED", guard: true },
          ],
        },
      },
      optionB: { description: "Leave in Fabric policy: retry with provider idempotency and asynchronous reconciliation.", fabricGuidance: "Pass the same provider idempotency key on every retry and reconcile uncertain outcomes before replay." },
    });
  }
  if (/refund/i.test(source) && /retry|webhook|cancel/i.test(source)) {
    dilemmas.push({
      id: "DIL-003", title: "Refund confirmation arrives out of order",
      worstCaseTrace: [
        "A refund directive is sent after cancellation.",
        "The acknowledgement is delayed while Fabric retries or processes another webhook.",
        "Two outcomes compete to update the balance; the recorded amount may diverge from provider settlement.",
      ],
      optionA: {
        description: "Elevate to World law: guard refund confirmation with a bounded balance invariant.",
        patch: {
          context: {
            ...canonicalContext,
          },
          states: [{ id: "REFUNDED", terminal: true }, { id: "SETTLED", terminal: true }],
          invariants: [{ id: "INV-REFUND-CONSERVATION", description: "Refunded and settled value cannot exceed the order amount", predicate: "refunded_amount + settled_amount <= order_amount" }],
          transitions: [
            { id: "RECORD_ORDER_AMOUNT", from: initial, to: initial, guard: "event.amount >= 0", effects: ["order_amount = event.amount"] },
            { id: "RECORD_REFUND_AMOUNT", from: initial, to: "REFUNDED", guard: "event.amount > 0", effects: ["refunded_amount = refunded_amount + event.amount"] },
            { id: "RECORD_SETTLED_AMOUNT", from: initial, to: "SETTLED", guard: "event.amount > 0", effects: ["settled_amount = settled_amount + event.amount"] },
          ],
        },
      },
      optionB: { description: "Leave in Fabric policy: deduplicate webhooks and reconcile with an asynchronous retry worker.", fabricGuidance: "Compute refunds in application code, deduplicate confirmations, and reconcile totals with provider records." },
    });
  }
  return dilemmas.slice(0, 3);
}

export function formatDilemmas(dilemmas: readonly LegislativeDilemma[]): string {
  if (!dilemmas.length) return "No boundary dilemmas inferred from this input.\n";
  return dilemmas.map((dilemma, index) => [
    "### Kadmos Legislative Dilemma",
    `#### Dilemma #${index + 1} (${dilemma.id}): ${dilemma.title}`,
    "#### Worst-Case Trace",
    ...dilemma.worstCaseTrace.map((step, stepIndex) => `${stepIndex + 1}. ${step}`),
    `- **Option A — Elevate to World Law:** ${dilemma.optionA.description}`,
    `- **Option B — Leave in Fabric policy:** ${dilemma.optionB.description}`,
    "Choose Option A or Option B before adopting the candidate World.",
  ].join("\n")).join("\n\n") + "\n";
}
