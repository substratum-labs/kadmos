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
  const magenta = (text: string) => color("35", text);

  const lines: string[] = [];
  const log = (msg = "") => lines.push(msg);

  // Parse and set up real gatekeeper
  const worldSpec = parseWorldSpec(DEMO_WORLD_YAML);
  const orderAmountCents = 5000;
  const gatekeeper = createWorldChecker(worldSpec, { order_amount: orderAmountCents });

  log("");
  log(bold(cyan("================================================================================")));
  log(bold("  KADMOS: USER INPUT -> MODEL -> FABRIC -> INTEGRATION IN ACTION"));
  log(bold(cyan("================================================================================")));
  log("");

  // 1. USER INPUT
  log(bold(magenta("[ 1. USER INPUT ] (High-level Requirement / PRD)")));
  log(`   ${dim('"')}${yellow("Build an order settlement system. Goods must only be dispatched after")}`);
  log(`   ${yellow("payment is captured. Total funds must be strictly conserved.")}${dim('"')}`);
  log("");
  log(dim("      │"));
  log(dim("      ▼ (kadmos infer / legislate: propose a World for human review)"));
  log("");

  // 2. THE MODEL
  log(bold(cyan("[ 2. THE MODEL ] (The World — a reviewed domain model)")));
  log(cyan("   ┌────────────────────────────────────────────────────────────────────────────┐"));
  log(`   │ ${bold("States:")}      CREATED ──(CONFIRM_PAYMENT)──> PAID ──(DISPATCH_GOODS)──> FULFILLED │`);
  log(`   │ ${bold("Invariant:")}   escrow_balance + settled_amount <= order_amount (Conservation)       │`);
  log(`   │ ${bold("Rule:")}        DISPATCH_GOODS requires state == PAID & escrow == order_amount       │`);
  log(`   │ ${bold("Generated:")}   Zero-dependency TypeScript & Python gatekeepers in milliseconds      │`);
  log(cyan("   └────────────────────────────────────────────────────────────────────────────┘"));
  log("");
  log(dim("      │"));
  log(dim("      ▼ (Fabric requests authorization before the modeled physical operation)"));
  log("");

  // 3. THE FABRIC
  log(bold(yellow("[ 3. THE FABRIC ] (Coding Agent writes code, but attempts a hallucinated shortcut)")));
  log("   An illustrative Fabric request attempts an illegal shortcut:");
  log(`   ${red("-> Proposing step:")} { transition: ${bold("DISPATCH_GOODS")}, directive: ${bold("INVOKE_LOGISTICS_DISPATCH")} }`);
  log(`      ${dim("(Attempting to fulfill and ship goods immediately from 'CREATED' before payment!)")}`);
  log("");
  log(dim("      │"));
  log(dim("      ▼ (This demo checks the request; it performs no DB or API operation)"));
  log("");

  // 4. INTEGRATION
  log(bold(red("[ 4. INTEGRATION ] (Deterministic Gatekeeper Interception & CEGIS Self-Repair)")));

  // Real execution of illegal step
  const unconstitutionalVerdict: StepVerdict = gatekeeper.step({
    transitionId: "DISPATCH_GOODS",
    proposedDirective: "INVOKE_LOGISTICS_DISPATCH",
  });

  if (!unconstitutionalVerdict.allowed) {
    log(`   ${bold(red("🛑 [GATEKEEPER REFUSED UNCONSTITUTIONAL ACTION!]"))}`);
    log(`      Reason: Transition 'DISPATCH_GOODS' is illegal from state 'CREATED'!`);
    log(`      Refusal trace: accepted prefix and refused attempt`);
    for (const step of unconstitutionalVerdict.violation?.shortestCounterexampleTrace ?? []) {
      log(`        Step ${step.step}: State=${bold(step.state)}, Action=${bold(step.action)}, Directive=${step.proposedDirective ?? "none"}`);
    }
    log(`      ${green("Result: checker state remains CREATED; this demo attempted no physical effect.")}`);
  } else {
    throw new Error("FATAL: Gatekeeper permitted unconstitutional transition!");
  }

  log("");
  log(bold(green("   🔄 [A legal candidate path checked against the same World]")));
  log("      The following candidate steps are accepted in sequence:");

  // Execute legal repaired steps
  const step1 = gatekeeper.step({ transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" });
  if (!step1.allowed) throw new Error("Step 1 failed");
  log(`      1. INITIATE_PAYMENT -> ${green("ALLOWED")} (State: CREATED -> PAYMENT_PENDING)`);

  const step2 = gatekeeper.step({ transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: orderAmountCents } });
  if (!step2.allowed) throw new Error("Step 2 failed");
  log(`      2. CONFIRM_PAYMENT  -> ${green("ALLOWED")} (State: PAYMENT_PENDING -> PAID, Escrow: $50.00)`);

  const step3 = gatekeeper.step({ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" });
  if (!step3.allowed) throw new Error("Step 3 failed");
  log(`      3. DISPATCH_GOODS   -> ${green("ALLOWED")} (State: PAID -> FULFILLED, Settled: $50.00, Escrow: $0.00)`);

  // Verify invariants
  const finalState = gatekeeper.getState();
  const finalContext = gatekeeper.getContext();
  const finalEnv = { ...finalContext, state: finalState, event: {} };
  for (const inv of worldSpec.invariants) {
    if (!evaluate(inv.predicate, finalEnv)) throw new Error(`Invariant failed: ${inv.id}`);
  }

  log("");
  log(bold(cyan("================================================================================")));
  log(bold("  💡 KEY TAKEAWAYS (THE KADMOS SHIFT):"));
  log(`  1. ${bold("Review the World")}            : Check that the declared policy matches domain intent;`);
  log(`  2. ${bold("Route Fabric through the checker")}: Each modeled request must be checked before its physical effect;`);
  log(`  3. ${bold("Use refusal evidence")}       : The accepted prefix and refused attempt guide a candidate repair.`);
  log(bold(cyan("================================================================================")));
  log("");

  return lines.join("\n");
}
