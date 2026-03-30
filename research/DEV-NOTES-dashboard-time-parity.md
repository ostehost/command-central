# DEV-NOTES: Dashboard Time Parity

## Summary

Updated the Agent Dashboard panel to use the same status-aware elapsed wording as the Agent Status tree.

## What Changed

- Exported a shared `formatTaskElapsedDescription(task)` helper from `src/providers/agent-status-tree-provider.ts`.
- Switched `src/providers/agent-dashboard-panel.ts` to render that shared description instead of its own `Elapsed:` duration label.
- Preserved running-task wording as `Running for X`.
- Changed completed, failed, stopped, killed, and contract-failure dashboard cards to use the tree-aligned `X ago` wording based on `completed_at` when available.

## Verification

- `bun test test/providers/agent-dashboard-panel.test.ts`
- `bun test test/tree-view/agent-status-tree-provider.test.ts -t "task status time descriptions"`

## Notes

- Attempted to create/update the external task-system entry under `~/.claude/tasks/cc-dashboard-time-parity`, but the sandbox blocked writes outside the workspace.
