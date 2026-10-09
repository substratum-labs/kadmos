---
name: kadmos
description: Use when designing, implementing, verifying, or refactoring state machines, transactional workflows, payment/order lifecycles, distributed queues/leases, or safety-critical backend logic. Enforces the Kadmos World-Fabric architecture with formal invariants, compiled deterministic gatekeepers, and counterexample-guided self-healing (CEGIS).
---

# Kadmos: Evidence-Native Governed Coding

## Overview

Kadmos is an evidence-native framework that decouples non-negotiable formal domain laws (**The World**) from disposable LLM-authored glue code (**The Fabric**). 

Instead of letting an agent generate unconstrained code and relying on fallible human line-by-line review, Kadmos enforces a rigid **Seam** (`ports.d.ts` / `ports.py`) and a deterministic runtime **Gatekeeper** (`WorldChecker`).

```
Raw PRD / Intent ────> [1. Infer World] ────> [2. Legislate Dilemmas] ────> [3. Compile Seam]
                                                                                     │
    Production Reality <──── [5. Differential Fuzz] <──── [4. Fabric Under Gatekeeper] <─┘
```

---

## The 5-Phase Protocol for Coding Agents

When tasked with implementing or refactoring any stateful or critical workflow, the agent **MUST** follow this five-phase sequence:

### Phase 1: Boundary & World Inference
Do **NOT** jump directly into writing business code or modifying endpoints.
1. Inspect the requirements or PRD.
2. Run `kadmos infer <requirements-file>` or invoke MCP tool `kadmos_infer`.
3. Synthesize or inspect the resulting `world.yaml`:
   - **States**: Closed finite enumeration (including explicit `initial` and `terminal` states).
   - **Context**: Bounded numerical/relational quantities (with `min`, `max`, `unit`, and `default`).
   - **Invariants**: Safety predicates checked at initialization and after requested transitions (e.g. conservation of value, balance non-negativity).
   - **Transitions**: Guarded transitions with directives and context update effects.

### Phase 2: Interactive Legislation & Dilemma Resolution
If the model contains ambiguous edge cases, race conditions, or conflicting requirements:
1. Run `kadmos legislate <requirements-file> --out world.yaml` or invoke MCP tool `kadmos_legislate`; the CLI reads requirements prose and infers a candidate World before presenting dilemmas.
2. Kadmos will surface candidate worst-case dilemmas (Option A vs Option B) for review.
3. Present these dilemma trade-offs to the human operator for explicit legislative decision. **NEVER** silently guess or weaken invariants in secret.

### Phase 3: Formal Seam Compilation
Once the World IR is frozen:
1. Run the compiler:
   ```bash
   # For TypeScript:
   kadmos compile world.yaml --out src/world --lang ts
   # For Python:
   kadmos compile world.yaml --out src/world --lang python
   # For polyglot:
   kadmos compile world.yaml --out src/world --lang all
   ```
   Or invoke MCP tool `kadmos_compile`.
2. Inspect the generated disposable Seam:
   - TypeScript: `src/world/ports.d.ts` and `src/world/world_checker.ts`
   - Python: `src/world/ports.py` and `src/world/world_checker.py`
3. **RULE**: The agent must treat these generated files as **READ-ONLY**. Never manually alter generated gatekeepers.

### Phase 4: Fabric Implementation Under Gatekeeper
Implement the physical glue code (HTTP controllers, database persistence, Redis adapters, third-party APIs):
1. Import `WorldChecker` into the worker or service.
2. **Mandatory Step Hook**: Before a physical side effect, request authorization. This TypeScript example assumes the compiled order World declares `CONFIRM_PAYMENT` from `CREATED` to `PAID`, with `directive: null` and a guard matching `event.captured_amount` to `order_amount`. The [README Fabric example](https://github.com/substratum-labs/kadmos/blob/main/README.md#3-fabric-under-governance) includes that World; the executable pattern is also included here so this skill can be copied on its own.

```typescript
import { WorldChecker } from "./world/world_checker.js";

export const checker = new WorldChecker();
let pending: Promise<void> = Promise.resolve();

export function processPayment(
  orderId: string,
  amount: number,
  persist: (orderId: string, state: string) => Promise<void>,
): Promise<void> {
  const operation = pending.then(async () => {
    const verdict = checker.step({
      transitionId: "CONFIRM_PAYMENT",
      eventPayload: { captured_amount: amount },
    });
    if (!verdict.allowed) {
      throw new Error(`Gatekeeper refusal: ${verdict.violation?.message}`);
    }
    try {
      await persist(orderId, verdict.currentState);
    } catch (error) {
      checker.rollbackLastStep();
      throw error;
    }
  });
  pending = operation.then(() => undefined, () => undefined);
  return operation;
}
```

This checker represents one order lifecycle; Fabric must associate each order with its own governed lifecycle. All calls using this checker must pass through the queue so another successful step cannot replace its savepoint during `await persist(...)`. Refusal preserves earlier accepted state and needs no rollback. A physical failure after an allowed step rolls back checker memory immediately, while the queue remains usable and the caller receives the failure. If persistence committed before reporting failure, it needs separate transactional, idempotent, or compensating handling; checker rollback does not undo committed external effects or establish cross-process atomicity.

3. In a scaffolded Python `src/worker.py`, the import path is:
   ```python
   from pathlib import Path
   import sys

   sys.path.insert(0, str(Path(__file__).parent / "world"))
   from world_checker import WorldChecker

   checker = WorldChecker()
   verdict = checker.step({
       "transitionId": "INITIATE_PAYMENT",
       "proposedDirective": "DISPATCH_PAYMENT_GATEWAY",
       "eventPayload": {},
   })
   if not verdict["allowed"]:
       raise RuntimeError(f"Gatekeeper rejected: {verdict['violation']}")
   ```
   This request matches the default scaffold World. For a transition with no directive, its World definition must explicitly say `directive: null`, and the request may omit `proposedDirective`. Generated Python has no public post-success rollback method; plan persistence failure handling separately before using it for physical effects.

### Phase 5: Differential Testing & CEGIS Self-Repair
1. Run the differential fuzzer:
   ```bash
   kadmos test world.yaml --runs 30 --steps 10
   ```
2. If tests fail or the Gatekeeper rejects an action:
   - A refusal includes the accepted step history and refused attempt as a diagnostic trace.
   - Use the refusal code, guard, invariant, and trace to revise Fabric and retest against the declared World.
   - The seeded differential fuzzer compares observed TypeScript and Python behavior; it is not a proof for all inputs.

---

## Agent Operational Rules (Non-Bypassable Invariants)

1. **Zero Silent Mutation**: If a business test fails because of a World invariant, the agent is strictly forbidden from editing `world.yaml` to weaken the rule without explicit human operator instruction.
2. **Checker Rollback**: In generated TypeScript, after an allowed `step()`, a physical failure must immediately call `checker.rollbackLastStep()` before any other successful step can replace the savepoint. Do not call it after a refused step. Serialize all asynchronous users of the checker. This restores checker memory only; coordinate external effects separately. Generated Python currently has no matching public post-success method.
3. **Seam Immutability**: `ports.d.ts` and `ports.py` are generated projections; never hand-edit them. If generated types and checker behavior differ, record the defect and change the compiler only through a separately reviewed behavior change. The current generated TypeScript port interface omits the checker's post-success rollback method.
4. **Clean Verification**: Before declaring any coding task complete, execute:
   - `pnpm test` (or `pytest`)
   - `tsc --noEmit`
   - `kadmos test world.yaml`
