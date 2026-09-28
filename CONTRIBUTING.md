# Contributing to Kadmos

Kadmos is a Developer Preview (v0.x). We welcome bug reports, adapters, examples, documentation, and state-machine improvements. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) and report security issues through [SECURITY.md](SECURITY.md).

## Architecture boundary

A **World** is reviewed constitutional policy: states, transitions, guards, invariants, context effects, and permitted directives. The World and generated gatekeeper decide whether a transition is legal. **Fabric** is replaceable execution code, including workers and adapters. Fabric may propose a transition and perform the authorized effect only after the gatekeeper accepts it. Keep a new adapter's operational logic in Fabric; do not let it silently redefine World policy or bypass a refusal. If a new primitive changes policy, include a World specification and conformance tests.

## Local setup and checks

Use Node.js 18+, Python 3.10+, and pnpm 10. From the repository root:

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
pnpm run test:fuzz
```

The build compiles TypeScript into `dist/`; the test suite covers the CLI, gatekeepers, adapters, and differential behavior between TypeScript and Python. If you change a public import or packaging, also run `pnpm pack --dry-run` and inspect the included paths.

## Changes and pull requests

Open an issue for substantial new World primitives or adapter APIs so maintainers can agree on the policy boundary. Keep pull requests focused, explain the behavior and compatibility impact, and link the relevant issue. Add or update tests for behavior changes; for a bug, include a reproducer. Use strict TypeScript types, follow the existing ESM/NodeNext import style (`.js` extensions in TypeScript imports), and keep generated code synchronized with its World source. Run the checks above before submitting. The pull request template records the validation and boundary review.
