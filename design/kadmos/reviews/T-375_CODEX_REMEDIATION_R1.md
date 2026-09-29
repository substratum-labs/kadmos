# T-375 Codex Remediation — Grok Reviewer-2 R1

**Date:** 2026-09-28 PDT  
**Task:** T-375 / EPIC-48  
**Branch:** `feat/epic48-release-hardening`  
**Review source:** `substratum-internal/design/kadmos/reviews/T-375_GROK_ADVERSARIAL_REVIEW_R1.md`  
**Status:** Implementation ready for Grok Reviewer-2 R2; Windows CI execution and reviewer acceptance remain pending.

## Blocking item resolutions

1. **Closed root type graph.** Converted handwritten `src/types/ports.d.ts` to `src/types/ports.ts`, preserving the public contract while making `tsc` emit both `dist/src/types/ports.js` and `.d.ts`. Added `scripts/test-packed-types.js` to pack and extract the real package, then typecheck both root and BullMQ subpath imports with TypeScript NodeNext and zero diagnostics. It runs after the unit suite in `pnpm test`.
2. **Windows linked paths.** `publishProjectionDirectory` now walks from the resolved output path to the platform root with `dirname` and `lstatSync`, rejecting any symbolic link or Windows junction before staging or writing. The linked output and linked ancestor tests use junctions on Windows and retain byte-preservation assertions.
3. **Node compatibility.** Agent child processes choose `--experimental-permission` on Node 20 and Node 22 before 22.13, and `--permission` from Node 22.13 onward. Node 18 is no longer advertised or tested: `engines.node` is `>=20`, CI tests Node 20 and 22, and README/CONTRIBUTING say Node.js 20+. The publish workflow already pins Node 20; a release-hygiene assertion now checks its version. Existing published `pnpm@10.32.1` ran through an npm-provisioned CLI for local Node 20/22 verification, avoiding the host's incompatible global pnpm launcher.
4. **Public README accuracy.** The BullMQ section now describes the one Redis CAS Lua script, the constitutional gatekeeper and differential bisimulation evidence, and the tested lifecycle subset. It removes the private whitepaper link and the full-surface implication.

**Bonus:** Generated Python test commands in scaffold CI and README text use `python` on Windows and `python3` elsewhere; scaffold tests assert the emitted command.

## Verification evidence

| Check | Result |
| --- | --- |
| `pnpm run build` | Exit 0; ports `.js` and `.d.ts` emitted. |
| `pnpm run typecheck` | Exit 0; no diagnostics. |
| `pnpm test` on Node 26 host | Exit 0; 236/236 tests passed; packed NodeNext consumer probe exit 0, zero diagnostics. |
| `npx -y -p pnpm@10.32.1 -p node@20 -c 'node -v; pnpm run typecheck && pnpm test'` | Exit 0 on Node 20.20.2; 236/236 tests and packed consumer probe passed. |
| Same command with `node@22` | Exit 0 on Node 22.23.3; 236/236 tests and packed consumer probe passed. |
| `pnpm pack --dry-run --json` | 65 files; `dist/src/types/ports.d.ts` and `.js` present; 0 test/example/benchmark/fixture/conformance paths. |

The linked-path assertions passed on macOS. `windows-latest` execution is still necessary to confirm junction behavior in native Windows CI. No Grok R2 verdict or release merge is claimed here.
