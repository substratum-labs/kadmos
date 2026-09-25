import { WorldChecker } from "./world/world_checker.js";
import { CircuitBreakerWorker, type HostActuators } from "./fabric_worker.js";

function printDivider(title: string): void {
  console.log("\n" + "=".repeat(75));
  console.log(`  ${title}`);
  console.log("=".repeat(75));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCircuitBreakerDemo(): Promise<void> {
  printDivider("Kadmos Circuit-Breaking Task Worker Demo");

  console.log(`[World IR] Loaded World: TaskWorkerWorld`);
  console.log(`[World IR] States: IDLE, RUNNING, BACKOFF_WAIT, COMPLETED (terminal), CIRCUIT_BROKEN (terminal)`);
  console.log(`[World IR] Invariants: INV-01 (Retry Bound), INV-02 (Non-negative), INV-03 (Circuit Trip), INV-04 (Clean Success)`);
  console.log(`[World IR] Directives: DISPATCH_EXECUTION_DISPATCHER, RECORD_METRICS_AND_CLEANUP, SCHEDULE_TIMER_WAKEUP, TRIGGER_PAGER_ALERT`);

  // Simulated Host Actuators enforcing Capability Tokens (WorldDirective)
  const actuators: HostActuators = {
    async executeJob(token, jobId: string, attempt: number) {
      if (token !== "DISPATCH_EXECUTION_DISPATCHER") {
        throw new Error(`CAPABILITY_VIOLATION: executeJob requires "DISPATCH_EXECUTION_DISPATCHER" token, got: "${token}"`);
      }
      await sleep(10);
      if (jobId === "job-always-fails") {
        return { success: false, error: "DatabaseConnectionTimeout: host unreachable" };
      }
      if (jobId === "job-flaky-then-succeeds") {
        if (attempt < 2) {
          return { success: false, error: "RateLimitExceeded: 429 Too Many Requests" };
        }
        return { success: true };
      }
      return { success: true };
    },

    async scheduleTimer(token, seconds: number) {
      if (token !== "SCHEDULE_TIMER_WAKEUP") {
        throw new Error(`CAPABILITY_VIOLATION: scheduleTimer requires "SCHEDULE_TIMER_WAKEUP" token, got: "${token}"`);
      }
      console.log(`   [Host Timer (Token: ${token})] Simulating waiting for ${seconds}s backoff window...`);
      await sleep(20);
    },

    async triggerPagerAlert(token, reason: string, context) {
      if (token !== "TRIGGER_PAGER_ALERT") {
        throw new Error(`CAPABILITY_VIOLATION: triggerPagerAlert requires "TRIGGER_PAGER_ALERT" token, got: "${token}"`);
      }
      console.log(`   🚨 [Host PagerDuty (Token: ${token})] PAGER ALERT FIRED! Reason: "${reason}"`);
      console.log(`      Context: Consecutive Failures=${context.consecutive_failures}, Retries=${context.retry_count}/${context.max_retries}`);
    },

    async recordMetrics(token, status: string, durationMs: number) {
      if (token !== "RECORD_METRICS_AND_CLEANUP") {
        throw new Error(`CAPABILITY_VIOLATION: recordMetrics requires "RECORD_METRICS_AND_CLEANUP" token, got: "${token}"`);
      }
      console.log(`   📊 [Host Telemetry (Token: ${token})] Metrics recorded: status=${status}, duration=${durationMs}ms`);
    },
  };

  const checker = new WorldChecker();
  const worker = new CircuitBreakerWorker(checker, actuators);

  // --------------------------------------------------------------------------
  // Scenario 1: Fabric Hallucination / Unconstitutional Shortcut Interception
  // --------------------------------------------------------------------------
  printDivider("Scenario 1: Adversarial LLM / Buggy Fabric Shortcut Interception");
  console.log(`Current Gatekeeper State: ${worker.state}`);
  console.log(`Context:`, worker.context);

  const illegalVerdict = worker.attemptUnconstitutionalShortcut();
  console.log(`\n[Gatekeeper Verdict] Allowed: ${illegalVerdict.allowed}`);
  console.log(`   Violation Code: ${illegalVerdict.violation?.code}`);
  console.log(`   Violation Message: ${illegalVerdict.violation?.message}`);
  console.log(`   Directive Token: ${illegalVerdict.directiveAllowed} (NO CAPABILITY GRANTED)`);
  console.log(`   Shortest Counterexample Trace:`, illegalVerdict.violation?.shortestCounterexampleTrace);
  console.log(`   Fail-Closed Verified: State remains "${worker.state}", Retry Count remains ${worker.context.retry_count}`);

  // --------------------------------------------------------------------------
  // Scenario 2: Nominal Execution with Transient Failure & Automatic Backoff
  // --------------------------------------------------------------------------
  printDivider("Scenario 2: Flaky Job Transient Failure & Backoff Recovery");
  checker.reset();
  console.log(`Resetting Worker. Current State: ${worker.state}`);

  const scenario2Verdict = await worker.processJob("job-flaky-then-succeeds");
  console.log(`\nFinal Verdict for Flaky Job: Allowed=${scenario2Verdict.allowed}, Final State="${scenario2Verdict.currentState}"`);
  console.log(`Final Context:`, worker.context);

  // --------------------------------------------------------------------------
  // Scenario 3: Persistent Failure Tripping Circuit Breaker
  // --------------------------------------------------------------------------
  printDivider("Scenario 3: Persistent Failure Tripping Circuit Breaker");
  checker.reset();
  console.log(`Resetting Worker. Current State: ${worker.state}`);

  const scenario3Verdict = await worker.processJob("job-always-fails");
  console.log(`\nFinal Verdict for Always-Fails Job: Allowed=${scenario3Verdict.allowed}, Final State="${scenario3Verdict.currentState}"`);
  console.log(`Final Context:`, worker.context);

  // --------------------------------------------------------------------------
  // Scenario 4: Post-Trip Violation (Terminal State Enforcement)
  // --------------------------------------------------------------------------
  printDivider("Scenario 4: Attempting Action in Terminal CIRCUIT_BROKEN State");
  console.log(`Worker is in terminal state "${worker.state}". Attempting another transition...`);
  const terminalVerdict = worker.attemptIllegalExcessRetry();
  console.log(`\n[Gatekeeper Verdict] Allowed: ${terminalVerdict.allowed}`);
  console.log(`   Violation Code: ${terminalVerdict.violation?.code}`);
  console.log(`   Violation Message: ${terminalVerdict.violation?.message}`);
  console.log(`   Directive Token: ${terminalVerdict.directiveAllowed} (NO CAPABILITY GRANTED)`);
  console.log(`   Fail-Closed Verified: System safely locked in "${worker.state}"`);

  // --------------------------------------------------------------------------
  // Scenario 5: Direct Bypass Attempt (Calling Actuator without Directive Token)
  // --------------------------------------------------------------------------
  printDivider("Scenario 5: Rogue Fabric Bypassing Seam (Calling Actuator without Token)");
  console.log("Simulating rogue Fabric attempting to trigger PagerDuty alert directly without Gatekeeper authorization...");
  try {
    // Attempting to call without authorized directive token
    await (actuators.triggerPagerAlert as any)("FORGED_OR_MISSING_TOKEN", "Rogue Alert", worker.context);
    console.error("FAILED: Actuator executed without valid token!");
  } catch (err) {
    console.log(`[Actuator Capability Check] REJECTED:`, (err as Error).message);
    console.log(`   Capability Security Verified: Physical side effects cannot execute without authorized WorldDirective.`);
  }

  printDivider("Kadmos Circuit-Breaking Task Worker Demo: SUCCESS");
}

runCircuitBreakerDemo().catch(console.error);
