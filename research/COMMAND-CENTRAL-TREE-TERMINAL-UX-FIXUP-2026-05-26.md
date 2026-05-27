# Tree Terminal UX Fixup Report

**Task ID:** `cc-tree-terminal-ux-review-fixup-20260526`
**Date:** 2026-05-26
**Commit:** `721a6b98` on `main`

## Root Cause

In `src/extension.ts`, the `commandCentral.defaultAgentAction` handler had a fallback block (lines 1603-1617) that checked whether a non-running task's tmux session was still alive. If alive, it focused the terminal instead of showing the diff/review artifact. This applied to **all** non-running statuses — including `failed`, `stopped`, `killed`, and `contract_failure` — contradicting the intended UX behavior matrix where only `running` tasks should focus the terminal on single-click.

The tree provider itself correctly set the command title to "View Changes" for non-running tasks, but the command handler's runtime behavior diverged by preferring terminal focus when a live tmux session existed.

## Fix Applied

Removed the live-tmux-session fallback block from `defaultAgentAction`. The handler now has two branches:

1. `running` → `focusAgentTerminal`
2. Everything else → `viewAgentDiff`

Terminal focus for non-running tasks remains available through the context menu / More Actions (`agentQuickActions`).

## Files Changed

| File | Change |
|------|--------|
| `src/extension.ts` | Removed 15-line tmux-session-alive check for non-running tasks; updated comments |
| `test/commands/extension-commands.test.ts` | Added `defaultAgentAction routing` describe block with 9 tests covering all status routing |
| `test/tree-view/agent-status-tree-provider.test.ts` | Added 4 tree-level tests for failed/stopped/killed/contract_failure command titles |

## Default-Click Behavior Matrix (Post-Fix)

| Task Status | Single-Click Action | Terminal Access |
|---|---|---|
| `running` | Focus terminal (`focusAgentTerminal`) | Direct click |
| `completed` | View diff/review (`viewAgentDiff`) | Context menu |
| `completed_dirty` | View diff/review (`viewAgentDiff`) | Context menu |
| `completed_stale` | View diff/review (`viewAgentDiff`) | Context menu |
| `failed` | View diff/review (`viewAgentDiff`) | Context menu |
| `stopped` | View diff/review (`viewAgentDiff`) | Context menu |
| `killed` | View diff/review (`viewAgentDiff`) | Context menu |
| `contract_failure` | View diff/review (`viewAgentDiff`) | Context menu |
| Discovered agent (no task) | Focus terminal (`focusAgentTerminal`) | Direct click |

## Tests Run

- `bun test test/commands/extension-commands.test.ts` — 89 pass, 0 fail
- `bun test test/tree-view/agent-status-tree-provider.test.ts` — 13 pass, 0 fail
- `just ready` (full gate: fix + check + test) — 1616 pass, 1 skip, 0 fail across 119 files

## New Tests Added

### `test/commands/extension-commands.test.ts`
- `running task → focusAgentTerminal`
- `failed task with live tmux metadata → viewAgentDiff (not terminal)`
- `stopped task with live tmux metadata → viewAgentDiff (not terminal)`
- `killed task with live tmux metadata → viewAgentDiff (not terminal)`
- `contract_failure task with live tmux metadata → viewAgentDiff (not terminal)`
- `completed task → viewAgentDiff`
- `completed_dirty task → viewAgentDiff`
- `completed_stale task → viewAgentDiff`
- `discovered agent (no task) → focusAgentTerminal`

### `test/tree-view/agent-status-tree-provider.test.ts`
- `failed task click views changes (not terminal focus)`
- `stopped task click views changes (not terminal focus)`
- `killed task click views changes (not terminal focus)`
- `contract_failure task click views changes (not terminal focus)`

## Git State

- **HEAD:** `721a6b98 fix(tree): non-running tasks default-click opens diff, not terminal`
- **Branch:** `main`
- **Tracked tree:** Clean (committed files only)
- **Untracked:** Pre-existing research files and unrelated `auto-review-lane.ts` from another task
