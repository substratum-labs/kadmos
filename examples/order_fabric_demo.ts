import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseWorldSpec,
  compileWorldSpec,
  createWorldChecker,
  type IWorldChecker,
  type StepVerdict,
} from "../src/index.js";
import { evaluate } from "../src/world_expression.js";

// Locate the canonical order settlement World IR fixture
const __dirname = fileURLToPath(new URL(".", import.meta.url));
function findFixturePath(): string {
  const candidates = [
    join(__dirname, "../conformance/fixtures/order_settlement.world.yaml"),
    join(process.cwd(), "conformance/fixtures/order_settlement.world.yaml"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find order_settlement.world.yaml in candidates: ${candidates.join(", ")}`);
}
const fixtureYaml = readFileSync(findFixturePath(), "utf8");

function printHeader(title: string): void {
  console.log("\n" + "=".repeat(76));
  console.log(`  ${title}`);
  console.log("=".repeat(76));
}

function printSubheader(title: string): void {
  console.log(`\n--- ${title} ---`);
}

export function runOrderFabricDemo(): boolean {
  printHeader("Kadmos World-Fabric Integration Walkthrough: Order Settlement");

  console.log("\n[Scope & Assurance Boundary Notice]");
  console.log("Kadmos at this tier provides a pure deterministic in-process runtime");
  console.log("gatekeeper (WorldChecker) and compile-time Ports & Directives membrane.");
  console.log("OS, network, and physical non-bypass exist only when paired with Castor/Roche.");
  console.log("Simulated physical side effects below are narrated host callbacks.\n");

  // Step 1: Parse and Compile the World Specification
  printSubheader("Step 1: World IR Compilation");
  const worldSpec = parseWorldSpec(fixtureYaml);
  const projection = compileWorldSpec(worldSpec);

  console.log(`[World] Loaded World IR: '${worldSpec.name}' (version: ${worldSpec.version})`);
  console.log(`[World] States: ${worldSpec.states.map((s) => s.id).join(", ")}`);
  console.log(`[World] Invariants declared: ${worldSpec.invariants.length}`);
  console.log(`[World] Transitions declared: ${worldSpec.transitions.length}`);
  console.log(`[World] Successfully projected ports.d.ts (${projection.portsDts.length} bytes) and world_checker.ts (${projection.worldCheckerTs.length} bytes)`);

  // Step 2: Initialize Gatekeeper with initial context ($50.00 order)
  printSubheader("Step 2: Initialize Runtime Gatekeeper");
  const orderAmountCents = 5000;
  const gatekeeper: IWorldChecker = createWorldChecker(worldSpec, {
    order_amount: orderAmountCents,
  });

  console.log(`[Gatekeeper] Current State: ${gatekeeper.getState()}`);
  console.log(`[Gatekeeper] Current Context:`, gatekeeper.getContext());

  // Step 3: Simulated Unconstrained LLM Fabric Attempts an Unconstitutional Shortcut
  printSubheader("Step 3: Fabric Hallucination / Unconstitutional Shortcut Attempt");
  console.log("Simulating an LLM Fabric agent attempting to dispatch goods immediately before payment capture...");
  console.log("-> Proposing step: { transitionId: 'DISPATCH_GOODS', proposedDirective: 'INVOKE_LOGISTICS_DISPATCH' }");

  const unconstitutionalVerdict: StepVerdict = gatekeeper.step({
    transitionId: "DISPATCH_GOODS",
    proposedDirective: "INVOKE_LOGISTICS_DISPATCH",
  });

  if (!unconstitutionalVerdict.allowed) {
    console.log("\n[Gatekeeper] REFUSED UNCONSTITUTIONAL ACTION!");
    console.log(`   Violation Code: ${unconstitutionalVerdict.violation?.code}`);
    console.log(`   Message: ${unconstitutionalVerdict.violation?.message}`);
    console.log(`   Violated Invariant: ${unconstitutionalVerdict.violation?.violatedInvariant ?? "None (structural state transition violation)"}`);
    console.log(`   Shortest Counterexample Trace:`);
    for (const step of unconstitutionalVerdict.violation?.shortestCounterexampleTrace ?? []) {
      console.log(`     Step ${step.step}: State=${step.state}, Action=${step.action}, Directive=${step.proposedDirective ?? "none"}`);
    }
  } else {
    console.error("FATAL: Gatekeeper permitted an unconstitutional transition!");
    return false;
  }

  // Verify that the World state remained intact (fail-closed, zero mutation)
  if (gatekeeper.getState() !== "CREATED" || gatekeeper.getContext().escrow_balance !== 0) {
    console.error("FATAL: Gatekeeper mutated state on rejected transition!");
    return false;
  }
  console.log("\n[Gatekeeper] Fail-closed verified: State remains 'CREATED', escrow balance remains $0.00.");

  // Step 4: Counterexample-Guided Plan Repair
  printSubheader("Step 4: Refusal-Guided Plan Repair");
  console.log(`[Feedback] Counterexample trace provided to Fabric Agent:`);
  console.log(`           Refusal Code: ${unconstitutionalVerdict.violation?.code}`);
  console.log(`           Refusal Message: ${unconstitutionalVerdict.violation?.message}`);
  console.log(`[Fabric] Diagnosed failure: Action 'DISPATCH_GOODS' is illegal from state 'CREATED'.`);
  console.log(`[Fabric] Synthesizing repaired 3-step constitutional plan:`);
  console.log(`         1. INITIATE_PAYMENT -> Acquire directive 'DISPATCH_PAYMENT_GATEWAY'`);
  console.log(`         2. CONFIRM_PAYMENT -> Receive webhook payload { captured_amount: 5000 }`);
  console.log(`         3. DISPATCH_GOODS -> Acquire directive 'INVOKE_LOGISTICS_DISPATCH' and fulfill`);

  // Step 5: Execute Repaired Plan
  printSubheader("Step 5: Executing Repaired Constitutional Plan");

  // Sub-step 5.1: Initiate Payment
  console.log("\n-> Executing Sub-step 1: INITIATE_PAYMENT");
  const step1 = gatekeeper.step({
    transitionId: "INITIATE_PAYMENT",
    proposedDirective: "DISPATCH_PAYMENT_GATEWAY",
  });
  if (!step1.allowed) {
    console.error("Sub-step 1 failed:", step1);
    return false;
  }
  console.log(`   Allowed! State: ${step1.previousState} -> ${step1.currentState}`);
  console.log(`   Authorized Directive: '${step1.directiveAllowed}'`);
  console.log("   [Host Simulation] Calling payment gateway provider with authorized directive...");

  // Sub-step 5.2: Confirm Payment Webhook
  console.log("\n-> Executing Sub-step 2: CONFIRM_PAYMENT (Webhook event received: $50.00 captured)");
  const step2 = gatekeeper.step({
    transitionId: "CONFIRM_PAYMENT",
    eventPayload: { captured_amount: orderAmountCents },
  });
  if (!step2.allowed) {
    console.error("Sub-step 2 failed:", step2);
    return false;
  }
  console.log(`   Allowed! State: ${step2.previousState} -> ${step2.currentState}`);
  console.log(`   Escrow Balance updated to: $${(Number(step2.context.escrow_balance ?? 0) / 100).toFixed(2)}`);

  // Sub-step 5.3: Dispatch Goods
  console.log("\n-> Executing Sub-step 3: DISPATCH_GOODS");
  const step3 = gatekeeper.step({
    transitionId: "DISPATCH_GOODS",
    proposedDirective: "INVOKE_LOGISTICS_DISPATCH",
  });
  if (!step3.allowed) {
    console.error("Sub-step 3 failed:", step3);
    return false;
  }
  console.log(`   Allowed! State: ${step3.previousState} -> ${step3.currentState}`);
  console.log(`   Authorized Directive: '${step3.directiveAllowed}'`);
  console.log(`   Settled Amount: $${(Number(step3.context.settled_amount ?? 0) / 100).toFixed(2)}`);
  console.log(`   Escrow Balance settled to: $${(Number(step3.context.escrow_balance ?? 0) / 100).toFixed(2)}`);
  console.log("   [Host Simulation] Calling shipping provider with authorized directive...");

  // Step 6: Audit & Verification
  printSubheader("Step 6: Final Constitutional Audit");
  const finalState = gatekeeper.getState();
  const finalContext = gatekeeper.getContext();
  console.log(`Final State: ${finalState} (Terminal: true)`);
  console.log(`Final Context:`, finalContext);

  // Directly evaluate all declared invariants on the final post-state
  const finalEnv = { ...finalContext, state: finalState, event: {} };
  for (const invariant of worldSpec.invariants) {
    const passed = evaluate(invariant.predicate, finalEnv);
    if (typeof passed !== "boolean" || !passed) {
      console.error(`FATAL: Invariant '${invariant.id}' evaluated to FALSE in final state: ${invariant.predicate}`);
      return false;
    }
    console.log(`  [Verified] ${invariant.id}: ${invariant.predicate} => TRUE`);
  }

  console.log(`All conservation invariants preserved:`);
  console.log(`  - Escrow balance settled cleanly to 0.`);
  console.log(`  - Settled amount equals total order amount ($50.00).`);
  console.log(`  - Goods only dispatched after 100% payment verification.`);
  console.log(`  - Zero unauthorized directives reached simulated providers.`);

  printHeader("Walkthrough Verdict: SUCCESS (All World invariants verified!)");
  return true;
}

// Auto-run if executed directly via node
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const success = runOrderFabricDemo();
  process.exit(success ? 0 : 1);
}
