## Summary

Fixed the Agent Status tree time labels so terminal states read as recency from `completed_at` instead of runtime from `started_at`.

## Root Cause

`formatElapsedDescription()` always called `formatElapsed(task.started_at)`, then applied status-specific wording like `Completed in ...` and `Failed after ...`. That meant completed, failed, stopped, killed, and contract-failure rows were all showing task duration, not time since the terminal state was reached.

## Changes

- Added `getStatusElapsedReference(task)` in `src/providers/agent-status-tree-provider.ts`.
- Running tasks still use `started_at`, so rows continue to read like `Running for 5m`.
- Non-running tasks now use `completed_at` when present, with fallback to `started_at` for older/incomplete records.
- Updated terminal-state phrasing to:
  - `Completed X ago`
  - `Failed X ago`
  - `Stopped X ago`
  - `Killed X ago`
  - `Contract failure X ago`
- Tightened `formatElapsed()` so exact-hour values render as `1h` / `2h` instead of `1h 0m` / `2h 0m`.

## Test Coverage

Updated `test/tree-view/agent-status-tree-provider.test.ts` to verify:

- running rows still use start-time elapsed formatting
- completed rows use `completed_at` rather than total duration
- failed rows use `completed_at`
- stopped rows use `completed_at`
- exact-hour elapsed values omit trailing `0m`

## Verification

- `bun test test/tree-view/agent-status-tree-provider.test.ts`
- `just fix`
- `bunx tsc --noEmit`
