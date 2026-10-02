# Kadmos

[![CI](https://github.com/substratum-labs/kadmos/actions/workflows/ci.yml/badge.svg)](https://github.com/substratum-labs/kadmos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/Node-20%2B-brightgreen)
![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue)
![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple)

**A new paradigm for how coding agents build software.**

Kadmos transforms AI-assisted software engineering from unconstrained, hallucination-prone code generation into declarative, invariant-governed construction. Instead of drowning in line-by-line manual code reviews, humans review the non-negotiable core model—and Kadmos compiles the rest into mathematically verified, self-healing execution layers.

---

## Why Kadmos?

### Model-Driven Core Generation vs. Code Review Fatigue
Coding agents can generate thousands of lines of application code in minutes. However, manually reviewing every line of AI-generated logic for subtle race conditions, invalid financial state transitions, or broken invariant rules is exhaustive and unsustainable.

Kadmos shifts human oversight from **reviewing raw code** to **reviewing declarative domain models**. You specify the non-negotiable rules of your domain once; Kadmos compiles them into deterministic, zero-dependency gatekeepers in TypeScript and Python, providing algebraic proof of correctness.

### Pragmatic Formalism: World, Fabric, and Seam
Kadmos rejects the academic trap of attempting to formally model 100% of an application (HTTP routing, JSON serialization, third-party SDK calls). Instead, it partitions systems into three pragmatic layers:

- **World (Constitutional Law)**: The critical core state machine. Contains explicit states, transitions, invariant predicates, bounded numeric contexts, and authorized directives. Reviewed by humans, frozen, and mathematically verified.
- **Fabric (Replaceable Execution)**: Untrusted, disposable application code written by coding agents or humans (e.g., HTTP controllers, database queries, Redis workers).
- **Seam (The Membrane)**: Compiled, zero-dependency gatekeepers (`WorldChecker`) and typed ports (`ports.d.ts` / `ports.py`). Before Fabric commits any physical side effect, it must request authorization from the gatekeeper. Refusals return algebraic counterexample traces that guide the agent's self-repair loop.

```mermaid
flowchart LR
    P[Requirements / PRD] --> I[kadmos infer]
    I --> L[kadmos legislate]
    L --> W[World YAML: Constitutional Model]
    W --> C[kadmos compile]
    C --> T[TypeScript Seam / Gatekeeper]
    C --> Y[Python Seam / Gatekeeper]
    F[Untrusted Fabric: Agent Code] --> T
    F --> Y
    T --> V[Verdict or Counterexample]
    Y --> V
    V --> R[kadmos run: Self-Repair Loop]
    R --> F
    W --> X[kadmos test: Bisimulation Fuzzing]
    T --> X
    Y --> X
```

---

## A Simple Example: Order Settlement

Here is how Kadmos models and governs an order lifecycle with financial value conservation.

### 1. The Model (`world.yaml`)
You define states, conservation invariants, and transitions:

```yaml
version: "kadmos.world.v0"
name: "OrderSettlementWorld"

states:
  - id: CREATED
    initial: true
  - id: PAID
  - id: FULFILLED
    terminal: true
  - id: CANCELLED
    terminal: true

context:
  order_amount: { type: integer, min: 1, max: 10000000, default: 5000 }
  escrow_balance: { type: integer, min: 0, max: 10000000, default: 0 }
  settled_amount: { type: integer, min: 0, max: 10000000, default: 0 }

invariants:
  - id: INV-CONSERVATION
    predicate: "escrow_balance + settled_amount <= order_amount"

transitions:
  - id: CONFIRM_PAYMENT
    from: CREATED
    to: PAID
    guard: "event.captured_amount == order_amount"
    effects:
      - "escrow_balance = order_amount"

  - id: DISPATCH_GOODS
    from: PAID
    to: FULFILLED
    guard: "escrow_balance == order_amount"
    directive: INVOKE_LOGISTICS_DISPATCH
    effects:
      - "settled_amount = escrow_balance"
      - "escrow_balance = 0"
```

### 2. The Compiled Seam (`WorldChecker`)
Compile the model into zero-dependency TypeScript and Python gatekeepers:

```bash
kadmos compile world.yaml --out src/world --lang all
```

### 3. Fabric Under Governance
The coding agent writes application code constrained by the gatekeeper:

```typescript
import { createWorldChecker } from "./world/world_checker.js";

const checker = createWorldChecker();

export async function processPayment(orderId: string, amount: number) {
  // Request authorization from the gatekeeper
  const verdict = checker.step({
    transitionId: "CONFIRM_PAYMENT",
    payload: { captured_amount: amount },
  });

  if (!verdict.allowed) {
    // Sound rollback if rejected
    checker.rollbackLastStep();
    throw new Error(`Gatekeeper refusal: ${verdict.violation?.message}`);
  }

  // Safe to execute physical database and external API side effects
  await db.orders.update(orderId, { status: verdict.currentState });
}
```

If an agent attempts an illegal transition (e.g., dispatching goods directly from `CREATED` without payment), the gatekeeper rejects the step with the **shortest counterexample trace**, preventing defects before code merges.

---

## Quick Start (Equipping Your Coding Agent)

Get started in 3 minutes by initializing a governed project with built-in agent configurations:

```bash
# 1. Initialize a governed starter project via npx
npx @substratum-labs/kadmos init my-agent --lang all
cd my-agent
pnpm install

# 2. Compile the starter World into TypeScript and Python seams
pnpm run compile

# 3. Differentially fuzz the two gatekeepers for bisimulation
pnpm run test
```

### Equipping Your Agent (Claude Code / Cursor / Cline)
Kadmos ships with built-in configurations that turn your coding assistant into a governed agent:

1. **Via MCP**: Add Kadmos to your agent's MCP tools (see [Model Context Protocol](#model-context-protocol)). The agent gains `kadmos_infer`, `kadmos_legislate`, `kadmos_compile`, and `kadmos_step`.
2. **Via Skill**: Copy `skills/kadmos/` to your project's `.agents/skills/kadmos/`. Your agent automatically learns the 5-phase World-Fabric protocol.
3. **Graphing**: Visualize your state machine anytime:
   ```bash
   npx @substratum-labs/kadmos graph world.yaml --format html --out state_machine.html --open
   ```

---

## CLI Reference

| Command | Purpose | Example |
| --- | --- | --- |
| `kadmos infer` | Extract candidate World and Fabric boundaries from prose requirements or existing code. | `kadmos infer requirements.md` |
| `kadmos legislate` | Resolve state-machine dilemmas with an interactive ANSI terminal TUI wizard. | `kadmos legislate requirements.md --interactive --out world.yaml` |
| `kadmos compile` | Project a World model into zero-dependency TypeScript and Python gatekeepers. | `kadmos compile world.yaml --out generated --lang all` |
| `kadmos run` | Run a bounded CEGIS agent self-repair loop guided by compilation and gatekeeper refusals. | `kadmos run --prd requirements.md --max-turns 3` |
| `kadmos mcp` | Start the stdio Model Context Protocol server for agent integration. | `kadmos mcp` |
| `kadmos test` | Differentially fuzz TypeScript and Python gatekeepers to verify cross-language bisimulation. | `kadmos test world.yaml --runs 30 --coverage` |
| `kadmos graph` | Render the World state machine as Mermaid, Graphviz DOT, or interactive HTML. | `kadmos graph world.yaml --format mermaid` |
| `kadmos init` | Scaffold a new governed project with starter models, workers, and tests. | `kadmos init my-agent --lang all` |

`kadmos test` also accepts `--steps`, `--seed`, and `--json`. `kadmos init` supports `default`, `order-settlement`, and `circuit-breaker` templates.

---

## Model Context Protocol

Add this configuration to Claude Code, Cline, or Cursor's `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kadmos": {
      "command": "npx",
      "args": ["-y", "@substratum-labs/kadmos", "mcp"]
    }
  }
}
```

The server exposes four standard JSON-RPC tools over stdio:
- `kadmos_infer`: Boundary and World candidate inference from PRDs.
- `kadmos_legislate`: Worst-case dilemma detection and legislation patching.
- `kadmos_compile`: Compiling World models into TypeScript/Python seams.
- `kadmos_step`: Interactive verification against runtime gatekeeper models.

The separate `kadmos-mcp` binary starts the same server directly after global installation.

---

## Agent Skill Integration

Kadmos packages an official **Agent Skill** (`skills/kadmos/SKILL.md`) compatible with modern coding agent environments (Antigravity, Claude Code, Cursor, Cline).

The skill establishes a strict 5-phase protocol that stops agents from hallucinating unverified business code:
1. **Phase 1: Boundary & World Inference** (`kadmos infer` / `kadmos_infer`)
2. **Phase 2: Interactive Legislation & Dilemma Resolution** (`kadmos legislate` / `kadmos_legislate`)
3. **Phase 3: Disposable Seam Compilation** (`kadmos compile` / `kadmos_compile`)
4. **Phase 4: Fabric Implementation Under Gatekeeper** (`WorldChecker.step()`, `rollbackLastStep()`)
5. **Phase 5: Bisimulation Testing & CEGIS Self-Repair** (`kadmos test`, `kadmos_step`)

---

## BullMQ Lifecycle Adapter (Developer Preview v0.x)

To see the World-Fabric architecture applied to real-world infrastructure, Kadmos includes a drop-in adapter for BullMQ:

```typescript
import Redis from 'ioredis';
import { Queue, Worker } from '@substratum-labs/kadmos/adapters/bullmq';

const connection = new Redis();
const queue = new Queue('emails', { connection });
const worker = new Worker('emails', async job => {
  console.log(job.data);
  return { delivered: true };
}, { connection });

await queue.add('send', { to: 'user@example.com' });
```

The adapter replaces BullMQ's 30+ complex multi-file Redis Lua scripts with a single atomic compare-and-swap Lua script backed by a formally modeled `JobWorld` gatekeeper. The same state machine compiles to both TypeScript and Python for cross-language queue interoperability.

---

## Roadmap & Open Challenges

Kadmos is currently in **Developer Preview (v0.x)**. Re-architecting software development from line-by-line review to declarative model governance presents fundamental challenges on our active roadmap:

- **Semantic Fidelity & Intent Convergence**: Preventing LLMs from distorting domain intent when translating natural language into formal models. We are designing domain-verified template libraries (`Patterns & Templates`) and few-shot calibration to converge on precise laws without reducing the formal model into shallow prose.
- **Model Compositionality & System Scaling**: Scaling beyond single bounded domains (order settlement, circuit breakers, queues) into multi-model, multi-service systems using rely-guarantee contracts, interface automata, and compositional verification without cognitive explosion.
- **Brownfield Retrofitting**: Developing progressive embedding adapters and static boundary detectors to incrementally introduce formal gatekeepers into existing large-scale, legacy codebases without greenfield rewrites.
- **Agent Skill & Ergonomics**: Deepening frictionless MCP and Skill distribution across leading coding agents (Cursor, Claude Code, Pi, Antigravity) so agents naturally adopt model-first synthesis without requiring developers or models to be formal-methods experts.
- **Formal Verification Backends**: Extending Kadmos IR export and verification backends to standard automated theorem provers and model checkers (SMT/Z3, TLA+, Alloy) alongside the high-speed compiled runtime gatekeepers.

---

## Development and Release

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run test:fuzz
pnpm pack
```

`prepack` builds `dist` before packaging. The published package contains CLI binaries, compiled runtime seams, README, and MIT license. Generated gatekeepers have zero third-party runtime dependencies.

---

## License

[MIT](LICENSE) © 2026 Substratum Labs.
