# Agent Status Display Bugs

## Summary

Fixed four display regressions in the agent status tree:

- Warning details no longer render a warning emoji in the label when the tree item already has a warning icon.
- Diff summaries now use the same per-file `--numstat` baseline as the expanded file list, including launcher-provided `start_sha` / `start_commit`.
- Running tasks with a terminal stream that already ended in a terminal event now display as `completed` or `failed` instead of being downgraded to `stopped` by the session-health overlay.
- Prompt summaries now prefer `Task` / `Goal` / `Objective` sections and skip orchestration boilerplate, so task descriptions stay useful.

## Implementation

- Extended normalized launcher task metadata to preserve `stream_file`, `start_sha`, and `start_commit`.
- Replaced the old `git diff --stat HEAD~1` summary path with a per-file summary derived from the same `getPerFileDiffs()` range the child file list uses.
- Added stream-terminal state detection for `turn.completed`, `turn.failed`, and `result` events before applying the inactive-session overlay.
- Tightened `readPromptSummary()` to extract section-based summaries first, then skip common orchestration boilerplate in the fallback pass.

## Verification

- `just fix`
- `bun test test/tree-view/agent-status-tree-provider-per-file-diff.test.ts test/tree-view/agent-status-tree-provider.test.ts`
- `bunx tsc --noEmit`

## Follow-up

- If we want identical prompt-summary quality for discovered agents, `readDiscoveredPrompt()` should eventually reuse the same section-aware extraction logic.
