# Agent History Cap

## Summary

Implemented an item cap for Agent Status history with an expandable `Show N older runs...` node.

## UX Choice

When Agent Status is grouped by project, the cap applies per project group instead of globally.

Why:

- Grouped mode is already about local project context.
- A global cap in grouped mode would hide entire projects based on unrelated activity elsewhere.
- Per-project truncation keeps each project predictable while still preventing any one project from exploding the child list.

## Behavior

- Added `commandCentral.agentStatus.maxVisibleAgents`.
- Default: `50`
- Minimum: `10`
- Maximum: `500`
- Flat mode shows the most recent `N` entries and moves older history under a collapsed node.
- Running agents remain visible even when they fall past the cap.
- Grouped mode applies the same rule inside each project group.
- Expanding the synthetic node reveals the hidden older runs in sorted order.

## Implementation Notes

- Added a new synthetic tree node type: `olderRuns`.
- Reused the existing sort order and only changed the final visibility pass.
- Kept counts and summary labels based on the full scoped task set, not only visible nodes.
- Updated parent resolution so hidden tasks nested under `olderRuns` still resolve correctly in the tree.

## Verification

Ran:

- `bun test test/tree-view/agent-status-tree-provider.test.ts test/package-json/agent-menu-contributions.test.ts`
- `bun test test/tree-view/agent-status-tree-provider.test.ts test/package-json/agent-menu-contributions.test.ts test/services/agent-status-bar.test.ts test/utils/agent-counts.test.ts`

Notes:

- `just format` does not exist in this repo. Used `just fix` as the nearest supported formatting/linting step.
- `bunx tsc --noEmit` still fails on existing branch issues outside this task area.
