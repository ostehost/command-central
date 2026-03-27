# DEV NOTES — CC Visibility Contract and Stale Lifecycle Governance

## Summary
Implemented stale-session governance and visibility-contract hardening in Command Central so stale launcher entries no longer mask live discovered agents, reload/reconnect deterministically re-merges discovery state, and launcher-provided project icons flow through to CC task/group labels.

## Files Changed
- `src/discovery/agent-registry.ts`
- `src/providers/agent-status-tree-provider.ts`
- `test/discovery/agent-registry.test.ts`
- `test/tree-view/agent-status-tree-provider.test.ts`
- `test/fixtures/agent-status/screenshot-stale-running.json`

## Scope Cleanup (cc-cleanup-v2)
- Kept in scope:
  - `src/discovery/agent-registry.ts`
  - `src/providers/agent-status-tree-provider.ts`
  - `test/discovery/agent-registry.test.ts`
  - `test/tree-view/agent-status-tree-provider.test.ts`
  - `test/fixtures/agent-status/screenshot-stale-running.json`
  - `research/DEV-NOTES-cc-visibility.md`
- Removed out-of-scope working-tree changes:
  - Restored accidental deletion of `.oste-report.yaml`.
  - No other out-of-scope working-tree modifications remained.

## Behavior Changes
1. Stale/non-running launcher tasks no longer suppress discovered running agents with the same session id.
2. Provider `reload()` now rehydrates discovery merge state immediately from latest `tasks.json` + discovery sources.
3. Launcher icon contract added: `project_icon` from launcher task payload is now honored in task labels and grouped project labels.
4. Screenshot-repro fixture test enforces stale-running exclusion from running summary, status bar, and Dock badge.

## Tests Run
1. `bun test test/discovery/agent-registry.test.ts test/tree-view/agent-status-tree-provider.test.ts test/services/agent-status-bar.test.ts test/services/agent-status-bar-count.test.ts`
   - Result: PASS
2. `just fix`
   - Result: PASS (`just format` recipe does not exist in this repo; used project-provided formatting/fix recipe)
3. `bun test test/discovery/agent-registry.test.ts test/tree-view/agent-status-tree-provider.test.ts`
   - Result: PASS

## Follow-ups
1. Current launcher/process discovery still centers on Claude-oriented process scanning; if Codex/Gemini process-level discovery parity is required, extend `ProcessScanner` source detection.
2. If launcher starts emitting icon metadata for discovered-process correlation, propagate that to discovered-only rows (currently launcher icon passthrough is task-driven).
