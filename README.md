# Kadmos

**Evidence-native coding agent.**

Kadmos explores a software-development workflow in which low-risk changes are admitted through explicit contracts and independently checkable evidence rather than mandatory line-by-line human source review.

## Two Assurance Questions

Kadmos keeps two axes separate:

- **Code Assurance:** Does the artifact satisfy its declared contract? Contract, verifier, breaker, artifact binding, and evidence answer this question.
- **Agent Assurance:** Did the producing agent remain within its granted authority? Tool mediation, capabilities, approval, journaling, and process isolation answer this question.

A strong result on one axis never substitutes for the other.

## Architecture Boundary

Kadmos is an application, not a security kernel or sandbox.

- Pi is the first planned replaceable Agent Host.
- Castor is an optional Guided execution backend.
- Roche is an optional Hardened isolation backend.
- A local backend will remain available without making non-bypass claims.
- Stable deterministic verification components may later move to Rust behind language-neutral protocols; the TypeScript application is not scheduled for a wholesale rewrite.

None of these integrations is required by the bootstrap.

## Status

Early bootstrap. The repository currently defines project identity, architectural constraints, schema/conformance homes, and verification plumbing. It does not yet implement Contract, Evidence, Builder, Breaker, admission, Pi, Castor, or Roche behavior.

## Development

Requirements:

- Node.js 24 or newer
- pnpm 11.19.0

```bash
pnpm install
pnpm verify
```

The approved bootstrap design is in [docs/superpowers/specs/2026-09-13-kadmos-bootstrap-design.md](docs/superpowers/specs/2026-09-13-kadmos-bootstrap-design.md).

## License

Apache-2.0
