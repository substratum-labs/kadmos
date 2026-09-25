# Conformance Fixtures

This directory is the future language-neutral conformance boundary between the TypeScript implementation and any later Rust verifier.

Fixtures record valid inputs, invalid inputs, canonical encodings, admission
transitions, and expected decisions.

# T-333 World Fabric RED harness

`fixtures/order_settlement.world.yaml` mirrors the approved T-332 World IR
example. The TypeScript test suites exercise parsing, fail-closed validation,
disposable code projection, runtime directive admission, and ordered CEGIS
counterexamples. `src/world_compiler.ts` and `src/world_checker.ts` intentionally
throw until T-334 implements them. A successful T-333 verification has a clean
build and typecheck, with these conformance tests failing against those stubs.

Run `npm run build`, `npm run typecheck`, and
`node --test dist/tests/**/*.test.js` from the repository root.

Specification question for T-334 review: `DISPATCH_GOODS` clears
`escrow_balance`, while `INV-03-FULFILL-REQUIRES-ESCROW` requires the balance to
equal `order_amount` in `FULFILLED`. `INV-01-CONSERVATION-OF-VALUE` also uses
`paid`, which the IR does not declare, and would reject the same path if `paid`
remains true after dispatch. The harness preserves the specified fixture and
required allowed happy path; implementation needs an explicit predicate and
invariant evaluation decision.
