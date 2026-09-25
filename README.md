# Kadmos

**Evidence-native coding agent.**

Kadmos explores a software-development workflow in which low-risk changes are admitted through explicit contracts and independently checkable evidence rather than mandatory line-by-line human source review.

> [!IMPORTANT]
> **Scope & Assurance Boundary:**
> Kadmos at this tier provides a pure deterministic in-process runtime gatekeeper (`WorldChecker`) and compile-time Ports & Directives membrane projection (`ports.d.ts`). OS, syscall, filesystem, and network non-bypass exist only when paired with a hardened execution broker (such as Castor OS and Roche Docker containers). Within this standalone TypeScript tier, `directiveAllowed` is an advisory verdict string that an in-process host application must observe to avoid unconstitutional physical side effects.

## Two Assurance Questions

Kadmos keeps two axes separate:

- **Code Assurance (CA):** Does the artifact satisfy its declared contract? Contract, verifier, breaker, artifact binding, and evidence answer this question.
- **Agent Assurance (EA):** Did the producing agent remain within its granted authority? Tool mediation, capabilities, approval, journaling, and process isolation answer this question.

A strong result on one axis never substitutes for the other.

## Architecture Boundary

Kadmos is an evidence-native coding application, not an OS security kernel.

- **World (Closed Law):** Finite state machines, bounded integer context, safety invariants, transition guards, and authorized directives.
- **Fabric (Open Execution):** Physical LLM-generated code, network calls, retries, and UI/glue logic.
- **The Seam:** Disposable TypeScript interfaces (`ports.d.ts`) and pure runtime gatekeeper (`WorldChecker`).
- **Pi:** Planned replaceable Agent Host.
- **Castor:** Optional Guided execution backend for kernel-level semantic non-bypass.
- **Roche:** Optional Hardened container isolation backend for physical network/filesystem non-bypass.

## Development

Requirements:

- Node.js 24 or newer
- pnpm 11.19.0

```bash
pnpm install
pnpm verify
pnpm run demo
```

## License

Apache-2.0
