# Kadmos Bootstrap Design

**Status:** Approved in conversation on 2026-09-13

## Goal

Initialize Kadmos as a framework-neutral, evidence-native coding application whose primary review surface is a machine-checkable contract and independent evidence rather than mandatory line-by-line human source review.

## Assurance Separation

Kadmos keeps two assurance questions orthogonal:

- **Code Assurance (CA):** whether an artifact satisfies declared claims. Contract, independent verification, breaker counterexamples, artifact binding, and evidence determine CA.
- **Agent Assurance (EA):** whether the producing agent remained within authority. Tool mediation, capability, approval, journaling, and process isolation determine EA.

Neither axis substitutes for the other. An admission record must report both independently and must never silently upgrade or downgrade either.

## v0 Scope

- TypeScript application and CLI foundations managed with pnpm.
- Language-neutral, versioned schema and conformance-fixture homes.
- Pure application interfaces that do not depend on Pi, Castor, or Roche types.
- Pi as the first planned replaceable Agent Host.
- Local execution as the baseline backend; Castor and Castor-plus-Roche as optional future backends.
- A future Rust verifier may replace stable deterministic admission components; a wholesale Rust rewrite is not promised.

## Non-goals

- Production deployment, automatic merge, database migration, or credential access.
- Formal verification of generated programs.
- Process isolation in the local backend.
- Deliberately unreadable generated code.
- Reimplementation of an LLM provider stack, terminal UI, Castor, or Roche.

## Trust Boundary

The model, Agent Host, Builder, Breaker, generated tests, and prose explanations are untrusted. Model self-reports are not evidence. Kadmos v0 may recommend admission but does not possess production authority. A hardened deployment delegates authoritative action admission to a backend such as Castor and physical containment to Roche or an equivalent sandbox.

## Core Invariants

1. Contract and implementation revisions are separate; a contract change invalidates prior evidence.
2. Evidence binds an exact contract digest and artifact digest.
3. A Builder cannot be the sole author of both implementation and final acceptance evidence.
4. Every reported assurance result states the checks run, assumptions, omissions, and actual EA profile.
5. Missing checks or unavailable backends fail closed for policies that require them.
6. Pi, Castor, and Roche types do not enter the language-neutral protocol.
7. Canonical schemas use explicit versions, closed objects, tagged unions, bounded integers, UTC timestamps, and specified digest encodings.
8. Agent actions must pass through an ExecutionBackend to count as mediated; local execution makes no non-bypass claim.

## Migration Boundary

The initial TypeScript core uses pure inputs and outputs around admission decisions. Protocol schemas and conformance fixtures are the cross-language authority. A later Rust verifier is introduced behind stdio or a Unix-domain protocol, shadow-runs against the TypeScript implementation, and becomes authoritative only after conformance reaches zero unexplained decision differences.

## Initial Repository Shape

```text
docs/
schemas/
conformance/
src/
tests/
```

The bootstrap exposes only a typed project identity describing the two assurance axes and optional integration policy. Functional Contract, Evidence, Builder, Breaker, Pi, Castor, and Roche implementations require separately approved tasks.

## Verification

The bootstrap is acceptable when dependency installation, tests, TypeScript compilation, and type checking pass; CI runs the same verification command; agent bootstrap links resolve to `substratum-internal`; and the local and remote repositories plus internal project registry agree on the project identity.
