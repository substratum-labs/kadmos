# Circuit-Breaking Asynchronous Task Worker PRD

## Overview
A resilient asynchronous task processing worker that executes jobs with retry backoff and circuit-breaking protection.

## Requirements & Lifecycle
1. The worker starts in an `IDLE` state waiting for incoming jobs.
2. When a job arrives, it transitions to `RUNNING` and dispatches execution to a worker runner.
3. If execution succeeds, the worker transitions to `COMPLETED` (terminal state), resetting consecutive failure counters.
4. If execution fails:
   - The worker must track `retry_count` and `consecutive_failures`.
   - As long as `retry_count < max_retries` (default max 3 retries), the worker enters `BACKOFF_WAIT` and schedules a timer backoff.
   - From `BACKOFF_WAIT`, the timer wakes up the worker and it transitions back to `RUNNING` for retry.
5. If the worker fails and `retry_count == max_retries`:
   - It is strictly forbidden from executing or retrying further.
   - It must trip the circuit breaker and transition to `CIRCUIT_BROKEN` (terminal state).
   - It triggers an urgent PagerDuty alert directive.

## Safety Invariants
- Retry bounds: `retry_count` must never exceed `max_retries` under any circumstance.
- Non-negative metrics: `retry_count`, `consecutive_failures`, and `backoff_seconds` cannot be negative.
- Completed cleanliness: In state `COMPLETED`, `consecutive_failures` must be 0.
- Circuit broken assertion: In state `CIRCUIT_BROKEN`, `retry_count` must equal `max_retries`.
