# RESULT-cc-history-olderruns-rc63-live-retest-20260614

## Summary

Cut and installed local Command Central `v0.6.0-rc.63` after stabilizing History `olderRuns` tree identity.

## Fix

- Commit: `d39ac0a6 fix(agent-status): stabilize History older-runs tree identity`
- Source: `src/providers/agent-status-tree-provider.ts`
  - `olderRuns` now uses `getOlderRunsStableId(...)` for both `TreeItem.id` and refresh-element identity.
  - ID derives from parent scope plus sorted hidden child identities, not from the count-bearing label `Show N older completed...`.
- Test: `test/tree-view/agent-status-tree-item-stable-id.test.ts`
  - Asserts `olderRuns` ID is invariant across label/count changes.

## Verification

- Targeted tests:
  - `bun test test/tree-view/agent-status-tree-item-stable-id.test.ts test/tree-view/agent-status-history-native-rows.test.ts`
  - Result: `19 pass, 0 fail`.
- Broader gate:
  - `just check`
  - Result: green; existing Knip warnings remain informational.
- Local dist/install:
  - `just dist --prerelease`
  - Version bumped to `0.6.0-rc.63` and installed in VS Code.
  - Known pre-existing launcher-bundle drift warning still appears; not part of this History fix.
- Installed bundle marker check at `/Users/ostehost/.vscode/extensions/oste.command-central-0.6.0-rc.63`:
  - `getOlderRunsStableId`: present
  - `olderRuns:`: present
  - `getStableTreeItemId`: present
  - `summary:sources`: present
  - `agentTask.running`: present
- Live UI retest after reload:
  - Screenshot/log receipt root: `/private/tmp/cc-rc63-logclick-20260614T124655/`
  - Clicked `History`, `Show 38 older completed...`, and a completed History task row.
  - Result: no VS Code log files changed during the click pass.
  - Old bug signatures in newest VS Code log session: `TOTAL 0` for `Failed to resolve tree node`, `No tree item with id`, `Cannot resolve tree item`.

## Conclusion

The original Command Central History TreeView resolve-storm/rattle class is fixed in local `rc.63`. VS Code remains in `Screen Reader Optimized` mode (`editor.accessibilitySupport=on`), so any residual audible feedback with zero logs should be treated as native VS Code accessibility/selection audio rather than a Command Central exception storm.
