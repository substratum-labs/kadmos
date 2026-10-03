import { compileWorldSpec, createWorldChecker, parseWorldSpec, type StepVerdict } from "./index.js";
import { evaluate } from "./world_expression.js";

const DEMO_WORLD_YAML = `version: "kadmos.world.v0"
name: "OrderSettlementWorld"
description: "Governed order payment and fulfillment"

states:
  - id: CREATED
    initial: true
    description: "Order placed, awaiting customer payment"
  - id: PAYMENT_PENDING
    description: "Payment dispatched to gateway, awaiting webhook"
  - id: PAID
    description: "Funds securely captured and held in escrow"
  - id: FULFILLED
    terminal: true
    description: "Goods dispatched and funds settled"
  - id: CANCELLED
    terminal: true
    description: "Order cancelled, zero liability"

context:
  order_amount:
    type: integer
    unit: "cents"
    min: 1
    max: 100000000
    default: 5000
  escrow_balance:
    type: integer
    unit: "cents"
    min: 0
    max: 100000000
    default: 0
  settled_amount:
    type: integer
    unit: "cents"
    min: 0
    max: 100000000
    default: 0

invariants:
  - id: VALUE_CONSERVATION
    description: "Escrow and settled funds must never exceed the declared order amount"
    predicate: "escrow_balance + settled_amount <= order_amount"
  - id: NO_NEGATIVE_BALANCES
    description: "Account balances can never become negative"
    predicate: "escrow_balance >= 0 && settled_amount >= 0"
  - id: FULFILLED_SETTLEMENT
    description: "A fulfilled order must have fully settled funds and empty escrow"
    predicate: "state == 'FULFILLED' => (settled_amount == order_amount && escrow_balance == 0)"

transitions:
  - id: INITIATE_PAYMENT
    from: CREATED
    to: PAYMENT_PENDING
    guard: "order_amount > 0"
    directive: "DISPATCH_PAYMENT_GATEWAY"
    effects: []

  - id: CONFIRM_PAYMENT
    from: PAYMENT_PENDING
    to: PAID
    guard: "event.captured_amount == order_amount"
    directive: null
    effects:
      - "escrow_balance = order_amount"

  - id: DISPATCH_GOODS
    from: PAID
    to: FULFILLED
    guard: "escrow_balance == order_amount"
    directive: "INVOKE_LOGISTICS_DISPATCH"
    effects:
      - "settled_amount = escrow_balance"
      - "escrow_balance = 0"

  - id: CANCEL
    from: CREATED
    to: CANCELLED
    guard: true
    directive: null
    effects: []
`;

export function runDemo(): string {
  const useColor = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
  const color = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (text: string) => color("1", text);
  const cyan = (text: string) => color("36", text);
  const green = (text: string) => color("32", text);
  const red = (text: string) => color("31", text);
  const yellow = (text: string) => color("33", text);
  const dim = (text: string) => color("2", text);

  const lines: string[] = [];
  const log = (msg = "") => lines.push(msg);

  log("");
  log(bold(cyan("============================================================================")));
  log(bold("  Kadmos World-Fabric Integration Walkthrough: Order Settlement"));
  log(bold(cyan("============================================================================")));
  log("");
  log(dim("[Scope & Assurance Boundary Notice]"));
  log(dim("Kadmos provides a pure deterministic in-process runtime gatekeeper (WorldChecker)"));
  log(dim("and compile-time Ports & Directives membrane. Physical container isolation"));
  log(dim("and network non-bypass exist when paired with Castor/Roche."));
  log("");

  // Step 1: Compilation
  log(bold(cyan("--- Step 1: World IR Compilation ---")));
  const worldSpec = parseWorldSpec(DEMO_WORLD_YAML);
  const projection = compileWorldSpec(worldSpec);
  log(`[World] Loaded World IR: '${worldSpec.name}' (version: ${worldSpec.version})`);
  log(`[World] States: ${worldSpec.states.map((s) => s.id).join(", ")}`);
  log(`[World] Invariants declared: ${worldSpec.invariants.length}`);
  log(`[World] Transitions declared: ${worldSpec.transitions.length}`);
  log(`[World] Projected ${green("ports.d.ts")} (${projection.portsDts.length} bytes) and ${green("world_checker.ts")} (${projection.worldCheckerTs.length} bytes)`);
  log("");

  // Step 2: Initialize Gatekeeper
  log(bold(cyan("--- Step 2: Initialize Runtime Gatekeeper ---")));
  const orderAmountCents = 5000;
  const gatekeeper = createWorldChecker(worldSpec, { order_amount: orderAmountCents });
  log(`[Gatekeeper] Current State: ${bold(gatekeeper.getState())}`);
  log(`[Gatekeeper] Current Context: ${JSON.stringify(gatekeeper.getContext())}`);
  log("");

  // Step 3: Fabric Hallucination Attempt
  log(bold(cyan("--- Step 3: Fabric Hallucination / Unconstitutional Shortcut Attempt ---")));
  log("Simulating an LLM Fabric agent attempting to dispatch goods before payment capture...");
  log(dim("-> Proposing step: { transitionId: 'DISPATCH_GOODS', proposedDirective: 'INVOKE_LOGISTICS_DISPATCH' }"));

  const unconstitutionalVerdict: StepVerdict = gatekeeper.step({
    transitionId: "DISPATCH_GOODS",
    proposedDirective: "INVOKE_LOGISTICS_DISPATCH",
  });

  if (!unconstitutionalVerdict.allowed) {
    log("");
    log(bold(red("[Gatekeeper] REFUSED UNCONSTITUTIONAL ACTION!")));
    log(`   Violation Code: ${red(unconstitutionalVerdict.violation?.code ?? "UNKNOWN")}`);
    log(`   Message: ${unconstitutionalVerdict.violation?.message}`);
    log(`   Shortest Counterexample Trace:`);
    for (const step of unconstitutionalVerdict.violation?.shortestCounterexampleTrace ?? []) {
      log(`     Step ${step.step}: State=${bold(step.state)}, Action=${bold(step.action)}, Directive=${step.proposedDirective ?? "none"}`);
    }
  } else {
    throw new Error("FATAL: Gatekeeper permitted an unconstitutional transition!");
  }

  if (gatekeeper.getState() !== "CREATED" || gatekeeper.getContext().escrow_balance !== 0) {
    throw new Error("FATAL: Gatekeeper mutated state on rejected transition!");
  }
  log("");
  log(`[Gatekeeper] ${green("Fail-closed verified")}: State remains 'CREATED', escrow balance remains $0.00.`);
  log("");

  // Step 4: Refusal-Guided Plan Repair (CEGIS)
  log(bold(cyan("--- Step 4: Refusal-Guided Plan Repair (CEGIS) ---")));
  log(yellow("[Feedback] Counterexample trace provided to Fabric Agent:"));
  log(`           Refusal Code: ${unconstitutionalVerdict.violation?.code}`);
  log(`           Refusal Message: ${unconstitutionalVerdict.violation?.message}`);
  log(`[Fabric] Diagnosed failure: Action 'DISPATCH_GOODS' is illegal from state 'CREATED'.`);
  log(`[Fabric] Synthesizing repaired 3-step constitutional plan:`);
  log(`         1. INITIATE_PAYMENT -> Acquire directive 'DISPATCH_PAYMENT_GATEWAY'`);
  log(`         2. CONFIRM_PAYMENT  -> Receive webhook payload { captured_amount: 5000 }`);
  log(`         3. DISPATCH_GOODS   -> Acquire directive 'INVOKE_LOGISTICS_DISPATCH' and fulfill`);
  log("");

  // Step 5: Execute Repaired Plan
  log(bold(cyan("--- Step 5: Executing Repaired Constitutional Plan ---")));

  // Sub-step 1: INITIATE_PAYMENT
  log(dim("-> Executing Sub-step 1: INITIATE_PAYMENT"));
  const step1 = gatekeeper.step({
    transitionId: "INITIATE_PAYMENT",
    proposedDirective: "DISPATCH_PAYMENT_GATEWAY",
  });
  if (!step1.allowed) throw new Error("Sub-step 1 failed");
  log(`   ${green("Allowed!")} State: ${step1.previousState} -> ${bold(step1.currentState)}`);
  log(`   Authorized Directive: '${bold(step1.directiveAllowed ?? "")}'`);
  log(dim("   [Host Simulation] Calling payment gateway provider with authorized directive..."));

  // Sub-step 2: CONFIRM_PAYMENT
  log("");
  log(dim("-> Executing Sub-step 2: CONFIRM_PAYMENT (Webhook received: $50.00 captured)"));
  const step2 = gatekeeper.step({
    transitionId: "CONFIRM_PAYMENT",
    eventPayload: { captured_amount: orderAmountCents },
  });
  if (!step2.allowed) throw new Error("Sub-step 2 failed");
  log(`   ${green("Allowed!")} State: ${step2.previousState} -> ${bold(step2.currentState)}`);
  log(`   Escrow Balance updated to: ${bold("$" + (Number(step2.context.escrow_balance ?? 0) / 100).toFixed(2))}`);

  // Sub-step 3: DISPATCH_GOODS
  log("");
  log(dim("-> Executing Sub-step 3: DISPATCH_GOODS"));
  const step3 = gatekeeper.step({
    transitionId: "DISPATCH_GOODS",
    proposedDirective: "INVOKE_LOGISTICS_DISPATCH",
  });
  if (!step3.allowed) throw new Error("Sub-step 3 failed");
  log(`   ${green("Allowed!")} State: ${step3.previousState} -> ${bold(step3.currentState)}`);
  log(`   Authorized Directive: '${bold(step3.directiveAllowed ?? "")}'`);
  log(`   Settled Amount: ${bold("$" + (Number(step3.context.settled_amount ?? 0) / 100).toFixed(2))}`);
  log(`   Escrow Balance settled to: $${(Number(step3.context.escrow_balance ?? 0) / 100).toFixed(2)}`);
  log(dim("   [Host Simulation] Calling shipping provider with authorized directive..."));
  log("");

  // Step 6: Final Audit
  log(bold(cyan("--- Step 6: Final Constitutional Invariant Audit ---")));
  const finalState = gatekeeper.getState();
  const finalContext = gatekeeper.getContext();
  log(`Final State: ${bold(finalState)} (Terminal: true)`);
  log(`Final Context: ${JSON.stringify(finalContext)}`);

  const finalEnv = { ...finalContext, state: finalState, event: {} };
  for (const invariant of worldSpec.invariants) {
    const passed = evaluate(invariant.predicate, finalEnv);
    if (typeof passed !== "boolean" || !passed) {
      throw new Error(`FATAL: Invariant '${invariant.id}' evaluated to FALSE: ${invariant.predicate}`);
    }
    log(`  [${green("Verified")}] ${bold(invariant.id)}: ${invariant.predicate} => ${green("TRUE")}`);
  }

  log("");
  log("All conservation invariants preserved:");
  log(`  - Escrow balance settled cleanly to $0.00.`);
  log(`  - Settled amount equals total order amount ($50.00).`);
  log(`  - Goods only dispatched after 100% payment verification.`);
  log(`  - Zero unauthorized directives reached simulated providers.`);
  log("");
  log(bold(green("============================================================================")));
  log(bold("  Walkthrough Verdict: SUCCESS (All World invariants verified!)"));
  log(bold(green("============================================================================")));
  log("");

  return lines.join("\n");
}
