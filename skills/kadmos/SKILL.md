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
    Production Reality <──── [5. Bisimulation Fuzz] <──── [4. Fabric Under Gatekeeper] <─┘
```

---

## The 5-Phase Protocol for Coding Agents

When tasked with implementing or refactoring any stateful or critical workflow, the agent **MUST** follow this five-phase sequence:

### Phase 1: Boundary & World Inference
Do **NOT** jump directly into writing business code or modifying endpoints.
1. Inspect the requirements or PRD.
2. Run `kadmos infer --prd <spec.md>` or invoke MCP tool `kadmos_infer`.
3. Synthesize or inspect the resulting `world.yaml`:
   - **States**: Closed finite enumeration (including explicit `initial` and `terminal` states).
   - **Context**: Bounded numerical/relational quantities (with `min`, `max`, `unit`, and `default`).
   - **Invariants**: Safety predicates that must **never** be violated in any state (e.g. conservation of value, balance non-negativity).
   - **Transitions**: Guarded transitions with directives and context update effects.

### Phase 2: Interactive Legislation & Dilemma Resolution
If the model contains ambiguous edge cases, race conditions, or conflicting requirements:
1. Run `kadmos legislate world.yaml --out world.yaml` or invoke MCP tool `kadmos_legislate`.
2. Kadmos will surface 2–3 shortest worst-case dilemmas (Option A vs Option B).
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
2. **Mandatory Step Hook**: Before committing any physical side effect (e.g., executing payment capture, writing database state, releasing a lock), the Fabric code **MUST** request authorization:
   ```typescript
   // TypeScript Example
   import { WorldChecker } from "./world/world_checker.js";

   export async function handlePayment(orderId: string, amount: number) {
     const verdict = checker.step({
       transitionId: "CONFIRM_PAYMENT",
       payload: { captured_amount: amount },
     });

     if (!verdict.allowed) {
       // Automatic sound blame: log and rollback
       checker.rollbackLastStep();
       throw new Error(`Gatekeeper rejected payment: ${verdict.violation?.message}`);
     }

     // Safe to commit side effects now
     await db.orders.update(orderId, { status: verdict.currentState });
   }
   ```
   ```python
   # Python Example
   from world.world_checker import WorldChecker

   def handle_payment(order_id: str, amount: int):
       verdict = checker.step({
           "transitionId": "CONFIRM_PAYMENT",
           "payload": {"captured_amount": amount}
       })
       if not verdict["allowed"]:
           checker.rollback_last_step()
           raise RuntimeError(f"Gatekeeper rejected: {verdict.get('violation')}")
       
       db.orders.update(order_id, status=verdict["currentState"])
   ```

### Phase 5: Bisimulation Testing & CEGIS Self-Repair
1. Run the differential fuzzer:
   ```bash
   kadmos test world.yaml --runs 30 --steps 10
   ```
2. If tests fail or the Gatekeeper rejects an action:
   - Kadmos computes the **Shortest Counterexample Trace** (e.g. `CREATED -> FULFILLED` without `PAID`).
   - Use this algebraic counterexample to re-order your Fabric execution calls.
   - Do **NOT** try random code changes; follow the exact sequence indicated by the shortest trace.

---

## Agent Operational Rules (Non-Bypassable Invariants)

1. **Zero Silent Mutation**: If a business test fails because of a World invariant, the agent is strictly forbidden from editing `world.yaml` to weaken the rule without explicit human operator instruction.
2. **Atomicity & Rollback**: Whenever a Fabric worker catches an exception after calling `step()`, it must immediately call `checker.rollbackLastStep()`.
3. **Seam Immutability**: All type definitions in `ports.d.ts` / `ports.py` are ground truth. If the types do not fit the requirement, re-run `infer` and `compile`, never hand-edit.
4. **Clean Verification**: Before declaring any coding task complete, execute:
   - `pnpm test` (or `pytest`)
   - `tsc --noEmit`
   - `kadmos test world.yaml`
