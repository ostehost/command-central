# Review Lane Tree Cleanup — 2026-05-26

## Root Cause

Four automatic reviewer lanes appeared as top-level items in the Agent Status tree after review completion around 22:42 EDT. The tasks were:

1. `review-ghostty-launcher-signing-fix-20260526` — `/tmp/ghostty-launcher-...-review`
2. `review-config-linear-conductor-snapshot-20260526` — `/tmp/config-...-review`
3. `review-cc-tree-terminal-ux-20260526` — `/tmp/command-central-...-review`
4. `review-cc-badge-launcher-polish-20260526` — `/tmp/command-central-...-review`

These are launcher-spawned review worktrees in `/tmp/*-review` directories. Command Central had no concept of "auto-review lane" — every task from tasks.json was rendered as a top-level tree item and counted toward badge/summary totals. Several rows also carried a bogus `project_id: config` regardless of the actual reviewed project.

## Changes

### New file: `src/utils/auto-review-lane.ts`
- `isAutoReviewLane(task)` — detects auto-review lanes using the `/tmp/*-review` project_dir as a mandatory signal, plus at least one corroborating signal (review- id prefix, reviewer role, or /REVIEW- handoff path). This ensures manual reviewer lanes in real project dirs are never false-positive filtered.
- `extractSourceTaskId(task)` — strips `review-` prefix to find the source task ID.
- `partitionAutoReviewLanes(tasks)` — splits a task array into primary and review-lane groups.

### Modified: `src/providers/agent-status-tree-provider.ts`
- `getScopedLauncherTasks()` — filters out auto-review lanes before the primary tree, summary counts, and project grouping.
- `getTasks()` — filters out auto-review lanes from the API used by dock badge computation.
- `getAutoReviewLaneChildren(task)` — new method that finds review lanes whose source task ID matches the given task, returning them as detail child nodes with click-to-open handoff file support (uses `vscode.open` command).
- Task children section now includes review lane children between detail nodes and file changes.

### New file: `test/utils/auto-review-lane.test.ts`
- 16 regression tests covering all four bug-report fixture shapes, normal developer tasks, manual reviewer lanes, edge cases for signal combinations, extractSourceTaskId, and partitionAutoReviewLanes.

## New Review-Lane Visibility Behavior

| Scenario | Before | After |
|----------|--------|-------|
| Auto-review lane (in /tmp/*-review) | Top-level tree item, counts toward badge | Hidden from primary tree; nested as child of source task with handoff link |
| Manual reviewer in real project dir | Top-level tree item | Top-level tree item (unchanged) |
| Badge count (running agents) | Counted auto-review lanes | Excludes auto-review lanes |
| Summary totals | Counted auto-review lanes | Excludes auto-review lanes |

## Tests Run

```
just ready → all green
  - Biome CI: 244 files checked, 0 errors
  - TypeScript: tsc --noEmit passes
  - Knip: no dead code
  - Tests: 1632 pass, 1 skip, 0 fail across 120 files (11.33s)
  - New tests: 16 pass in auto-review-lane.test.ts
```

## Launcher Metadata Follow-Up

The launcher (ghostty-launcher) should add explicit fields for review lanes:

1. **`review_of`** or **`source_task_id`**: The task ID being reviewed (e.g., `cc-tree-terminal-ux-20260526`). Currently null — Command Central infers it by stripping the `review-` prefix, which is fragile.
2. **`original_project_id`**: The actual project being reviewed. Currently many review lanes carry `project_id: config` regardless of the reviewed project (e.g., reviewing command-central work but labeled as config).
3. **`is_auto_review: true`**: Explicit flag so consumers don't need heuristics.

When these fields are available, `isAutoReviewLane()` can be simplified to check `is_auto_review === true` and the source-task linkage can use `source_task_id` directly.

## Git

- **HEAD**: `41eba078` — `fix(tree): filter auto-review lanes from primary Agent Status tree`
- **Branch**: `main`
- **Working tree**: clean (excluding pre-existing untracked research artifacts)
