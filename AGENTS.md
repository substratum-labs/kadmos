# Kadmos — Contributor & Coding Agent Instructions

## Purpose
This document provides instructions for AI coding agents (Claude Code, Cursor, Cline, Antigravity, Codex) and human contributors modifying or extending the **Kadmos** codebase.

---

## 1. Architectural Invariants (Non-Bypassable)

Kadmos is an evidence-native framework separating declarative constitutional policy (**World**) from replaceable execution code (**Fabric**):

1. **World Policy vs. Fabric Execution**:
   - The formal state machine in `world.yaml` is the ultimate source of truth.
   - The generated Seam (`src/world/ports.d.ts`, `src/world/world_checker.ts`, and their Python equivalents `ports.py`, `world_checker.py`) is **READ-ONLY**. Never manually alter generated gatekeepers; make changes to the compiler or input specification and re-run compilation.
2. **Zero-Coercion & Fail-Closed**:
   - Runtime inputs must match expected primitive types. Malformed values must be refused, not coerced.
   - Internal checker state is encapsulated with ECMAScript `#private` fields to prevent Fabric mutation.
3. **Gatekeeper Atomicity & Sound Rollback**:
   - Any physical failure during execution following an authorized `step()` transition must immediately trigger `checker.rollbackLastStep()`.
4. **Polyglot Bisimulation**:
   - The TypeScript and Python compilers must emit gatekeepers that behave identically under differential fuzzing.

---

## 2. Standard Development & Verification Workflow

Always verify technical correctness before reporting changes as complete.

### Core Commands

```bash
# Clean build (compiles TypeScript to dist/)
pnpm run build

# Run entire test suite (237+ tests including packed typecheck probe)
pnpm test

# Typecheck with strict TypeScript NodeNext
pnpm run typecheck

# Differential fuzzing (fuzz TypeScript & Python gatekeepers for bisimulation)
pnpm run test:fuzz

# Complete one-step verification
pnpm run verify

# Verify packaging hygiene (ensures zero test/fixture leakage in npm tarball)
pnpm pack --dry-run
```

---

## 3. Code & Packaging Conventions

1. **TypeScript & ESM**:
   - The codebase uses `"type": "module"` with NodeNext module resolution.
   - All relative TypeScript imports must specify the `.js` extension (e.g., `import { Foo } from "./foo.js";`).
   - Strict typing is enabled; avoid `any` wherever possible.
2. **Hermetic Release Hygiene**:
   - The npm package must only expose production artifacts (`bin/`, `dist/src/`, `skills/`, `README.md`, `LICENSE`).
   - Never commit or stage build artifacts, test caches, or internal notes into the release files list.
3. **No Unsanctioned Dependencies**:
   - Generated TypeScript and Python gatekeepers must remain zero-dependency. Do not add runtime dependencies to generated artifacts.

---

## 4. Contributor Checklist

Before submitting a PR or concluding an agent task:
- [ ] Run `pnpm run verify` (`pnpm test && pnpm run typecheck`) and confirm 100% pass.
- [ ] Run `pnpm pack --dry-run` if packaging or file boundaries were touched.
- [ ] Ensure all new features or bug fixes have corresponding tests in `tests/`.
- [ ] Confirm no secrets, private environment tokens, or unnecessary files are staged (`git status` clean).
