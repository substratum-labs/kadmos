import type { BoundaryInferenceResult } from "./boundary_inference.js";

export interface LegislativeDilemma {
  readonly id: string;
  readonly title: string;
  readonly worstCaseTrace: readonly string[];
  readonly optionA: string;
  readonly optionB: string;
}

export function synthesizeDilemmas(result: BoundaryInferenceResult): LegislativeDilemma[] {
  const source = result.inputContent;
  const dilemmas: LegislativeDilemma[] = [];
  if (/cancel/i.test(source) && /payment|capture|paid|charge/i.test(source)) {
    dilemmas.push({
      id: "DIL-001", title: "Concurrent cancellation and payment capture",
      worstCaseTrace: [
        "Order enters PAYMENT_PENDING; payment capture is dispatched.",
        "Cancellation is accepted while the gateway capture remains in flight.",
        "A delayed payment success arrives after cancellation; funds may be captured without a legal settlement path.",
      ],
      optionA: "Elevate to World law: add an atomic cancellation/capture guard and an arbitration state before either terminal outcome.",
      optionB: "Leave in Fabric policy: use an asynchronous reconciliation and refund retry workflow.",
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
      optionA: "Elevate to World law: require a guarded idempotency key and explicit unknown-outcome state before retry.",
      optionB: "Leave in Fabric policy: retry with provider idempotency and asynchronous reconciliation.",
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
      optionA: "Elevate to World law: guard refund confirmation with a unique settlement identity and bounded balance invariant.",
      optionB: "Leave in Fabric policy: deduplicate webhooks and reconcile with an asynchronous retry worker.",
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
    `- **Option A — Elevate to World Law:** ${dilemma.optionA}`,
    `- **Option B — Leave in Fabric policy:** ${dilemma.optionB}`,
    "Choose Option A or Option B before adopting the candidate World.",
  ].join("\n")).join("\n\n") + "\n";
}
