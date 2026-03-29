# DEV-NOTES: Sort Mode Cycle

## Summary

Implemented Agent Status sort-mode cycling with a new enum setting, legacy migration shim, toolbar state, summary indicator, command palette entries, and coverage for the three sort behaviors.

## What Changed

- Added `commandCentral.agentStatus.sortMode` with:
  - `recency` (default)
  - `status`
  - `status-recency`
- Kept `commandCentral.agentStatus.sortByStatus` as a deprecated read-time alias:
  - `true` maps to `status`
  - `false` maps to `recency`
- Added toolbar sort cycling via `commandCentral.cycleSortMode`.
- Added command palette selection via `commandCentral.setSortMode`.
- Added a summary-row mode indicator:
  - `↓ Recent`
  - `⚠ Status`
  - `▶ Active`

## Sorting Behavior

- `recency`
  - Sorts flat and grouped children by latest activity (`completed_at ?? started_at`) descending.
  - Grouped roots sort by freshest child activity.
- `status`
  - Uses status-priority buckets first, then recency within each bucket.
  - Grouped roots sort alphabetically to preserve a stable status-first grouped view.
- `status-recency`
  - Pins running agents first, then sorts everything else by recency.
  - Grouped roots with running agents float to the top.

## UX Wiring

- Added `commandCentral.agentStatus.sortMode` context key updates in activation/config sync.
- Added three toolbar menu states for `commandCentral.cycleSortMode`:
  - `$(history)` for `recency`
  - `$(warning)` for `status`
  - `$(pin)` for `status-recency`
- Changed `groupByProject` default to `false`.

## Tests

Verified:

- `bunx tsc --noEmit`
- `bun test test/tree-view/agent-status-tree-provider.test.ts`
- `bun test test/commands/extension-commands.test.ts`
- `bun test test/package-json/agent-menu-contributions.test.ts`
- `bun test test/integration/cross-repo-smoke.test.ts`

Formatting step:

- This repo does not define `just format`.
- Ran `just fix` as the maintained formatting/linting equivalent from the current `justfile`.
