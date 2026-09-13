# Kadmos Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a minimal, verifiable TypeScript repository for Kadmos and register it in the Substratum coordination system.

**Architecture:** Kadmos starts as one private TypeScript package with a pure project-identity export and language-neutral schema/conformance homes. Pi is a future replaceable host; Castor and Roche are optional future backends. Internal registration owns task, role, memory, and project-index records.

**Tech Stack:** Node.js 24+, TypeScript, pnpm, Node test runner, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-13-kadmos-bootstrap-design.md`

## Global Constraints

- TypeScript is the v0 application language.
- Code Assurance and Agent Assurance remain separate axes.
- Pi, Castor, and Roche are optional replaceable integrations.
- Language-neutral schemas and conformance fixtures are the future Rust migration boundary.
- No production authority, deployment, automatic merge, or credentials are introduced.

---

### Task 1: Minimal typed package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tests/project-identity.test.ts`
- Create: `src/index.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `AssuranceAxis`, `ProjectIdentity`, and `projectIdentity` from `src/index.ts`.
- `projectIdentity` names `code` and `agent` as separate axes and lists `pi`, `castor`, and `roche` as optional integrations.

- [ ] Write `tests/project-identity.test.ts` before `src/index.ts` and run it to observe the missing-module failure.
- [ ] Implement the minimal typed identity export.
- [ ] Run `pnpm verify` and require tests, build, and typecheck to pass.
- [ ] Configure GitHub Actions to run `pnpm verify` on Node.js 24.

### Task 2: Repository documentation and bootstrap links

**Files:**
- Modify: `README.md`
- Create: `schemas/README.md`
- Create: `conformance/README.md`
- Create: `AGENTS.md` symlink
- Create: `GEMINI.md` symlink
- Create: `CLAUDE.md` symlink
- Create: `GEMINI_SPECIFIC.md` symlink

**Interfaces:**
- Produces: public project boundary and agent bootstrap paths.

- [ ] Document the CA/EA split, explicit non-goals, and optional integration profiles.
- [ ] Reserve schema and conformance directories without inventing premature protocols.
- [ ] Link project instructions to the Substratum coordination hub.
- [ ] Verify all links resolve.

### Task 3: Internal project registration

**Files:**
- Modify: `PROJECTS.md`
- Modify: `ledger/TASKS.md`
- Create: `ledger/projects/kadmos.md`
- Create: `memory/kadmos/MEMORY.md`
- Create: `agent-md/kadmos.md`
- Modify: `ledger/HANDOFF.md`

**Interfaces:**
- Produces: EPIC-37 and T-323 registration plus project-specific task, memory, and role entry points.

- [ ] Register the repository and role without marking Castor or Roche mandatory.
- [ ] Move T-323 to review only after local and remote verification succeeds.
- [ ] Run `scripts/check_ledger.sh` and require a clean result.
- [ ] Commit and push the Kadmos branch and internal registration branch for Yong review.
