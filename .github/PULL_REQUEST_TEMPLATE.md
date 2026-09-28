## Change

Describe the behavior, linked issue, and any public API or compatibility impact.

## Verification

- [ ] Added or updated behavior tests (or explained why none apply)
- [ ] `pnpm run build`
- [ ] `pnpm test`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test:fuzz` when World/compiler behavior changed
- [ ] `pnpm pack --dry-run` when exports or packaging changed

## Architecture boundary

- [ ] World policy and Fabric execution remain separated; no adapter bypasses gatekeeper refusals
- [ ] TypeScript and Python projections remain compatible where applicable
- [ ] No secrets, private data, or test/example artifacts enter the release package
