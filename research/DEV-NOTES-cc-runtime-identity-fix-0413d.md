## Summary

- Hardened duplicate-running reconciliation in `AgentStatusTreeProvider` so it no longer collapses tasks by weak `session_id` alone.
- Added tooltip breadcrumbs for exact timestamps, runtime identity, and transcript/session hints.
- Kept scope inside the provider and `test/tree-view/agent-status-tree-provider.test.ts`.

## Files Changed

- `src/providers/agent-status-tree-provider.ts`
- `test/tree-view/agent-status-tree-provider.test.ts`

## Tests Run

- `bun test test/tree-view/agent-status-tree-provider.test.ts` ✅
- `bunx tsc --noEmit` ⚠️ fails outside this slice in `test/services/whats-new-notification.test.ts` with existing `TS2558` generic-call errors on mocked `globalState.get(...)`

## Remaining Caveats

- I could not create/update the external task-system entry for `cc-runtime-identity-fix-0413d` from this session. Local `openclaw tasks ...` commands fail immediately with `SecItemCopyMatching failed -50`, so task registration/progress updates were blocked by the host OpenClaw/keychain setup rather than this repo.
- Repo-wide typecheck is still blocked by the unrelated `whats-new-notification` test file; I left that untouched to avoid widening the requested provider-only patch.
