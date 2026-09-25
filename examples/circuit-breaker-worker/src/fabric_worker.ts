import {
  type IWorldChecker,
  type WorldState,
  type WorldContext,
  type StepVerdict,
  type WorldDirective,
} from "./world/ports.js";

/**
 * HostActuators represents the physical side-effect capabilities.
 * Under the Kadmos Ports & Directives seam, each physical capability
 * is guarded and MUST consume a valid WorldDirective capability token
 * issued by the WorldChecker gatekeeper.
 */
export interface HostActuators {
  executeJob: (
    token: Extract<WorldDirective, "DISPATCH_EXECUTION_DISPATCHER">,
    jobId: string,
    attempt: number
  ) => Promise<{ success: boolean; error?: string }>;

  scheduleTimer: (
    token: Extract<WorldDirective, "SCHEDULE_TIMER_WAKEUP">,
    seconds: number
  ) => Promise<void>;

  triggerPagerAlert: (
    token: Extract<WorldDirective, "TRIGGER_PAGER_ALERT">,
    reason: string,
    context: WorldContext
  ) => Promise<void>;

  recordMetrics: (
    token: Extract<WorldDirective, "RECORD_METRICS_AND_CLEANUP">,
    status: string,
    durationMs: number
  ) => Promise<void>;
}

export class CircuitBreakerWorker {
  private readonly checker: IWorldChecker;
  private readonly actuators: HostActuators;

  constructor(checker: IWorldChecker, actuators: HostActuators) {
    this.checker = checker;
    this.actuators = actuators;
  }

  get state(): WorldState {
    return this.checker.getState();
  }

  get context(): WorldContext {
    return this.checker.getContext();
  }

  /**
   * Process a job through the governed World FSM lifecycle.
   * Every physical effect is executed ONLY with an authorized WorldDirective token.
   */
  async processJob(jobId: string): Promise<StepVerdict> {
    console.log(`[Worker] Starting job: ${jobId}`);

    // Step 1: Request permission to start task and acquire execution directive
    const startVerdict = this.checker.step({
      transitionId: "START_TASK",
      proposedDirective: "DISPATCH_EXECUTION_DISPATCHER",
    });

    if (!startVerdict.allowed || startVerdict.directiveAllowed !== "DISPATCH_EXECUTION_DISPATCHER") {
      console.error(`[Worker] Failed to start job:`, startVerdict.violation);
      return startVerdict;
    }

    // Acquired capability token to execute job
    let executionToken = startVerdict.directiveAllowed;
    console.log(`   [Seam] Acquired directive token: "${executionToken}"`);

    let isDone = false;
    let finalVerdict: StepVerdict = startVerdict;

    while (!isDone) {
      const currentContext = this.checker.getContext();
      const attemptNumber = currentContext.retry_count + 1;

      console.log(`[Worker] Executing job ${jobId} (Attempt #${attemptNumber}) with token "${executionToken}"...`);
      // Capability-guarded physical actuator call
      const executionResult = await this.actuators.executeJob(executionToken, jobId, attemptNumber);

      if (executionResult.success) {
        console.log(`[Worker] Job ${jobId} executed successfully!`);
        finalVerdict = this.checker.step({
          transitionId: "FINISH_SUCCESS",
          proposedDirective: "RECORD_METRICS_AND_CLEANUP",
        });

        if (finalVerdict.allowed && finalVerdict.directiveAllowed === "RECORD_METRICS_AND_CLEANUP") {
          console.log(`   [Seam] Acquired directive token: "${finalVerdict.directiveAllowed}"`);
          await this.actuators.recordMetrics(finalVerdict.directiveAllowed, "SUCCESS", 120);
        }
        isDone = true;
      } else {
        console.warn(`[Worker] Job ${jobId} failed: ${executionResult.error}`);

        // Check if we should record failure or trip circuit
        const canRetry = currentContext.retry_count < currentContext.max_retries;

        if (canRetry) {
          finalVerdict = this.checker.step({
            transitionId: "RECORD_FAILURE",
            proposedDirective: "SCHEDULE_TIMER_WAKEUP",
          });

          if (!finalVerdict.allowed || finalVerdict.directiveAllowed !== "SCHEDULE_TIMER_WAKEUP") {
            console.error(`[Worker] Refused failure transition:`, finalVerdict.violation);
            return finalVerdict;
          }

          const timerToken = finalVerdict.directiveAllowed;
          const updatedContext = this.checker.getContext();
          console.log(`   [Seam] Acquired timer directive token: "${timerToken}"`);
          console.log(`[Worker] Backing off for ${updatedContext.backoff_seconds}s (Retry ${updatedContext.retry_count}/${updatedContext.max_retries})...`);
          
          // Capability-guarded timer call
          await this.actuators.scheduleTimer(timerToken, updatedContext.backoff_seconds);

          // Retry
          console.log(`[Worker] Waking up from backoff, initiating retry...`);
          const retryVerdict = this.checker.step({
            transitionId: "RETRY_TASK",
            proposedDirective: "DISPATCH_EXECUTION_DISPATCHER",
          });

          if (!retryVerdict.allowed || retryVerdict.directiveAllowed !== "DISPATCH_EXECUTION_DISPATCHER") {
            console.error(`[Worker] Refused retry transition:`, retryVerdict.violation);
            return retryVerdict;
          }

          // Refresh execution capability token for next attempt
          executionToken = retryVerdict.directiveAllowed;
          console.log(`   [Seam] Re-acquired directive token for retry: "${executionToken}"`);
          finalVerdict = retryVerdict;
        } else {
          // Trip circuit breaker
          console.error(`[Worker] Max retries reached (${currentContext.retry_count}/${currentContext.max_retries}). Tripping circuit breaker!`);
          finalVerdict = this.checker.step({
            transitionId: "TRIP_CIRCUIT",
            proposedDirective: "TRIGGER_PAGER_ALERT",
          });

          if (finalVerdict.allowed && finalVerdict.directiveAllowed === "TRIGGER_PAGER_ALERT") {
            const alertToken = finalVerdict.directiveAllowed;
            console.log(`   [Seam] Acquired alert directive token: "${alertToken}"`);
            await this.actuators.triggerPagerAlert(alertToken, `Job ${jobId} exceeded max retries`, this.checker.getContext());
          }
          isDone = true;
        }
      }
    }

    return finalVerdict;
  }

  /**
   * Intentionally attempt an unconstitutional action to test the gatekeeper
   */
  attemptUnconstitutionalShortcut(): StepVerdict {
    console.log(`\n[Adversarial Fabric] Attempting unconstitutional shortcut: RETRY_TASK while in IDLE state without failure...`);
    return this.checker.step({
      transitionId: "RETRY_TASK",
      proposedDirective: "DISPATCH_EXECUTION_DISPATCHER",
    });
  }

  /**
   * Intentionally attempt an unconstitutional retry when max retries exceeded
   */
  attemptIllegalExcessRetry(): StepVerdict {
    console.log(`\n[Adversarial Fabric] Attempting to force RECORD_FAILURE when retry_count already equals max_retries...`);
    return this.checker.step({
      transitionId: "RECORD_FAILURE",
      proposedDirective: "SCHEDULE_TIMER_WAKEUP",
    });
  }
}
