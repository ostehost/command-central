# Command Central Tree Terminal UX Improvement

**Task ID:** `cc-tree-terminal-ux-20260526`
**Date:** 2026-05-26
**Commit:** `60a848c0`

## Current UX Problem Summary

Clicking a completed/non-running agent row in the Command Central tree view opened a QuickPick menu titled "Resume options for {task-id}" with 4–5 items:

1. "Open Prior Chat (0ac78f2b…)" — exact session transcript
2. "Resume Exact Session (0ac78f2b…)" — `claude --resume ...`
3. "Focus Existing Terminal" — bring project terminal to front
4. "Build Project Terminal" — create new bundle + tmux pane
5. "Owner-bound completion" — informational, not actionable

**Problems identified:**
- The click required two interactions (click → QuickPick → select item) for the common path
- Labels were cryptic, containing UUID fragments that mean nothing to the user
- "Owner-bound completion" was selectable even though clicking it did nothing
- The most common action (seeing what the task did) was buried in a menu
- Running tasks already had the right UX (direct terminal focus), but completed tasks did not

## Changes Made

### Files Changed

| File | Change |
|------|--------|
| `src/extension.ts` | New `commandCentral.defaultAgentAction` command; cleaned up QuickPick labels in both `resumeAgentSession` and `focusAgentTerminal` dead-session flows |
| `src/providers/agent-status-tree-provider.ts` | `createTaskItem()` now uses `defaultAgentAction` for all task states |
| `src/commands/agent-quick-actions.ts` | Updated labels: "Open Prior Chat" → "View Conversation Transcript", "Resume Session" → "Resume Claude Session…" |
| `package.json` | Registered `commandCentral.defaultAgentAction` command |
| `test/commands/agent-quick-actions-options.test.ts` | Updated expected label strings |
| `test/tree-view/agent-status-tree-provider.test.ts` | Updated command name assertions |
| `test/tree-view/agent-status-tree-provider-discovery.test.ts` | Updated command name assertion |
| `test/tree-view/agent-status-tree-provider-health.test.ts` | Updated command name assertion |
| `test/integration/installed-vsix-proof-suite.ts` | `findFocusNode()` now recognizes both `focusAgentTerminal` and `defaultAgentAction` |

### New Default Click Behavior

| Tree Item State | Single-Click Action | Rationale |
|-----------------|---------------------|-----------|
| **Running task** | Focus terminal directly | Unchanged — the obvious action for a live task |
| **Completed task with live tmux session** | Focus terminal directly | If the terminal is still alive, show it |
| **Completed task (no live terminal)** | View diff | "What did this task change?" is the most common question |
| **Failed/stopped/killed task** | View diff | Same — show what happened |
| **Discovered agent** | Focus terminal | Delegate to existing `focusAgentTerminal` |

### Where Advanced Actions Now Live

- **Context menu** (right-click): "Resume Session", "Focus Terminal", "Restart", "View Diff", "Remove" — all existing context menu items unchanged
- **Agent Actions** command (inline icon or palette): The `agentQuickActions` command continues to offer a full action list per status
- The `resumeAgentSession` command is unchanged and still available — it's just no longer the default click

### QuickPick Label Improvements

| Before | After |
|--------|-------|
| `Open Prior Chat (0ac78f2b…)` | `View Conversation Transcript` (session ID in description) |
| `Resume Exact Session (0ac78f2b…)` | `Resume Claude Session` with "Starts a shell command" warning |
| `Focus Existing Terminal` | `Focus Terminal` |
| `Owner-bound completion` (selectable) | Rendered as non-actionable `Separator` |
| `Detached — manual observation required` (selectable) | Rendered as non-actionable `Separator` |
| QuickPick title: "Resume options for {id}" | "Actions for {id}" |

### Ghostty Failure/Fallback UX Behavior

No changes to Ghostty failure handling in this PR. The existing fallback chain in `focusAgentTerminal` (Strategy 0 → 1 → 2 → 2.5 → 3) is preserved. When Ghostty app launch fails due to macOS Launch Constraint Violation:

- Strategy 3 (`openGhosttyTmuxAttach`) spawns a fresh Ghostty window attached to the tmux session and shows an info message
- If tmux session is dead, the dead-session QuickPick appears with cleaned-up labels
- The Ghostty crash investigation (separate issue) remains tracked in `research/COMMAND-CENTRAL-GHOSTTY-CRASH-COUNT-INVESTIGATION-2026-05-26.md`

## Validation

```
$ just ready
✅ Biome CI — 242 files, 0 errors
✅ TypeScript — tsc --noEmit passes
✅ Tests — 1597 pass, 0 fail, 1 skip (11.18s across 119 files)
✅ Quality — zero 'as any' assertions, zero skipped tests
```

## Git Status

```
commit 60a848c0 feat(tree): deterministic single-click for agent tree items
branch: main
working tree: clean (untracked research files preserved)
```

## Recommended Follow-up

1. **Full tree item icon refresh**: Running tasks could get an inline "pause/stop" icon; completed tasks could get a "diff" icon to reinforce the click affordance.
2. **Ghostty Launch Constraint Violation fix**: The code-signing issue in `/Applications/Projects/*.app` bundles (tracked in crash count investigation) needs a signing fix at the launcher level. This is orthogonal to tree UX.
3. **Badge count dedup**: Separate bug — avoid worsening count behavior. Not touched in this PR.
4. **Keyboard/accessibility audit**: The command palette paths are preserved but could benefit from a dedicated `defaultAgentAction` keybinding for tree-focused navigation.
