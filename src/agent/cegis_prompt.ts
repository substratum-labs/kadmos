import type { StepVerdict } from "../types/ports.js";
import type { StepRecord } from "../types/counterexample.js";
import type { TransitionDef, WorldSpec } from "../types/world.js";

function routeTo(world: WorldSpec, start: string, target: string): TransitionDef[] | undefined {
  if (start === target) return [];
  const visited = new Set([start]);
  const queue: { state: string; route: TransitionDef[] }[] = [{ state: start, route: [] }];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { state, route } = queue[cursor]!;
    for (const transition of world.transitions.filter((item) => item.from === state)) {
      if (visited.has(transition.to)) continue;
      const next = [...route, transition];
      if (transition.to === target) return next;
      visited.add(transition.to);
      queue.push({ state: transition.to, route: next });
    }
  }
  return undefined;
}

function formatStep(step: StepRecord, denied: boolean): string {
  const directive = step.proposedDirective ?? "none";
  const payload = step.eventPayload === undefined ? "" : `, EventPayload=${JSON.stringify(step.eventPayload)}`;
  return `${step.step}. \`Step ${step.step}\`: State=\`${step.state}\`, Action=\`${step.action}\`, ProposedDirective=\`${directive}\`${payload} -> **${denied ? "DENIED (Fail-Closed, zero mutation)" : "ACCEPTED"}**`;
}

function describeTransition(transition: TransitionDef): string {
  const guard = transition.guard === true ? "true" : String(transition.guard);
  const effects = transition.effects.length ? transition.effects.join("; ") : "none";
  return `Transition \`${transition.id}\` with directive \`${transition.directive ?? "none"}\` (${transition.from} -> ${transition.to}); guard \`${guard}\`; effects \`${effects}\`.`;
}

/** Translate a gatekeeper refusal into WorldSpec-grounded repair instructions. */
export function synthesizeCegisPrompt(verdict: StepVerdict, worldSpec: WorldSpec): string {
  const violation = verdict.violation;
  if (verdict.allowed || !violation) throw new Error("CEGIS_PROMPT_REQUIRES_REFUSAL");

  const classification: Record<string, string> = {
    INVALID_TRANSITION: "ILLEGAL_TRANSITION",
    ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
    GUARD_FAILED: "GUARD_FAILED",
    INVARIANT_FAILED: "INVARIANT_VIOLATED",
    INVARIANT_VIOLATED: "INVARIANT_VIOLATED",
    REENTRANCY_DENIED: "REENTRANCY_DENIED",
    REENTRANCY_DETECTED: "REENTRANCY_DENIED",
  };
  const code = classification[violation.code] ?? violation.code;
  const trace = violation.shortestCounterexampleTrace;
  const rejected = trace.at(-1);
  const transition = worldSpec.transitions.find((item) => item.id === rejected?.action && item.from === verdict.previousState);
  const invariant = worldSpec.invariants.find((item) => item.id === violation.violatedInvariant);
  const lines = [
    "### 🛑 [Kadmos Constitutional Gatekeeper Refusal]",
    "",
    "The runtime gatekeeper intercepted an illegal operation during execution.",
    "",
    "#### 1. Violation Classification",
    `- **Code:** \`${code}\``,
    `- **Reason:** ${violation.message}`,
    `- **Violated Invariant:** ${invariant ? `\`${invariant.id}\`: \`${invariant.predicate}\`` : "None (structural or guard violation)"}`,
    "",
    "#### 2. Shortest Counterexample Execution Trace",
    ...(trace.length ? trace.map((step, index) => formatStep(step, index === trace.length - 1)) : ["No execution steps were recorded."]),
    "",
    "#### 3. Algebraic Remediation Directive",
  ];

  if (code === "ILLEGAL_TRANSITION" && rejected) {
    const candidates = worldSpec.transitions.filter((item) => item.id === rejected.action);
    const routes = candidates.map((candidate) => ({ candidate, route: routeTo(worldSpec, verdict.previousState, candidate.from) }))
      .filter((item): item is { candidate: TransitionDef; route: TransitionDef[] } => item.route !== undefined)
      .sort((a, b) => a.route.length - b.route.length);
    const best = routes[0];
    if (best) {
      lines.push(`To execute \`${rejected.action}\` from \`${verdict.previousState}\`, first reach \`${best.candidate.from}\`.`,
        `Required sequence from state \`${verdict.previousState}\`:`);
      [...best.route, best.candidate].forEach((step, index) => lines.push(`${index + 1}. ${describeTransition(step)}`));
      lines.push("Satisfy each guard with the required event payload and context before requesting its directive.");
    } else {
      lines.push(`No legal route in this WorldSpec reaches action \`${rejected.action}\` from \`${verdict.previousState}\`. Do not invent a transition or execute its side effect; stop and request a WorldSpec change.`);
    }
  } else if (code === "GUARD_FAILED" && transition) {
    lines.push(`The transition \`${transition.id}\` exists, but its guard \`${transition.guard}\` evaluated false with context \`${JSON.stringify(verdict.context)}\`.`,
      "Supply an event payload and prior legal transitions that make this exact guard true. Do not bypass the guard or trigger its directive on refusal.");
  } else if (code === "INVARIANT_VIOLATED" && transition) {
    lines.push(`The attempted transition \`${transition.id}\` would violate \`${invariant?.predicate ?? violation.violatedInvariant ?? "an invariant"}\`.`,
      `Current context: \`${JSON.stringify(verdict.context)}\`. Declared effects: \`${transition.effects.join("; ") || "none"}\`.`,
      "Revise the transition inputs or preceding legal sequence so the post-state algebra satisfies the invariant. Do not apply the rejected effects or trigger its directive.");
  } else if (code === "REENTRANCY_DENIED") {
    lines.push("A nested gatekeeper call occurred during atomic evaluation. Move the nested action after the current step returns; never mutate gatekeeper state during a guard or effect.");
  } else {
    lines.push("The gatekeeper refused this step. Do not execute its side effect. Follow the declared WorldSpec and address the refusal reason before retrying.");
  }

  lines.push("", "#### Instructions for Code Repair:",
    "Revise the service code so every physical side effect follows an allowed checker.step() verdict and all declared invariants remain true.",
    "Output the complete updated TypeScript code in a ```typescript code fence.");
  return lines.join("\n");
}
