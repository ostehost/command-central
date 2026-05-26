# CC Launcher Lifecycle Conflict — Dogfood Report

**Date:** 2026-05-25
**Task:** cc-dogfood-reaper-false-fail-20260525-2138
**Trigger:** ghl-project-icon-regression-20260525-2122

## Root Observation

Ghostty Launcher task `ghl-project-icon-regression-20260525-2122` was marked
`failed` in the node launcher truth (tasks.json) with:

- `error=dead_pid`
- `exit_code=-1`
- `completed_at=2026-05-26T01:28:25Z`

Direct process/tmux proof showed the Claude process and its `just test` children
were still alive afterward in tmux session `agent-ghostty-launcher`, window `@2`,
pane `%2`. The launcher's reaper produced a false failure.

Before this change, Command Central's Tier 1a trust (`toDisplayTask()`) accepted
`failed` as authoritative without consulting tmux liveness — rendering it as a
normal red-icon failure with no hint that the process was actually still running.

## What Changed in CC

### New pure function: `classifyLifecycleConflict()`

**File:** `src/providers/agent-status-tree-provider.ts` (~line 901)

A pure, exported classifier — mirrors the pattern of `classifyCompletionRouting()`.

**Inputs:**
- `task: Pick<AgentTask, "status" | "error_message">` — only the fields needed
- `livenessEvidence: "alive" | "dead" | "unknown" | "not-checked"` — tmux probe result

**Logic:** If `status ∈ {failed, contract_failure, stopped, killed}` AND
`livenessEvidence === "alive"`, return `{ kind: "live-process-conflict", ... }`.
Otherwise return `{ kind: "none" }`. Only positive liveness evidence triggers
the conflict — `"unknown"` and `"dead"` do not.

### New private method: `getTerminalTaskLivenessEvidence()`

Wraps `getTmuxPaneAgentEvidence()` for terminal tasks. Returns `"not-checked"`
for non-tmux tasks, remote tasks, or tasks without valid session IDs. Reuses
the existing 5-second TTL pane evidence cache.

### Rendering changes in `createTaskItem()`

1. **Description badge:** `"⚠ lifecycle conflict"` appended to description parts
2. **Tooltip line:** `**$(warning) Lifecycle conflict:** Launcher marked failed (dead_pid) but process is still alive in terminal` — rendered immediately after the status line for visibility
3. **Icon override:** Orange warning icon (`charts.orange`) takes highest priority, above stale/stuck (yellow) and reviewed (green)

### Detail view in `getDetailChildren()`

Section 8 — a `DetailNode` with the conflict label, detail, and orange warning
icon. Only rendered for failure-class terminal statuses when liveness evidence
is positive.

## Files Changed

| File | Change |
|------|--------|
| `src/providers/agent-status-tree-provider.ts` | +~100 lines: pure classifier, private liveness probe, rendering wiring |
| `test/tree-view/agent-status-tree-provider-pure-helpers.test.ts` | +12 test cases covering all status × evidence combinations |

## Tests Run

```
bun test test/tree-view/agent-status-tree-provider-pure-helpers.test.ts
  → 30 pass, 0 fail (including 12 new lifecycle conflict tests)

just test
  → 1595 pass, 0 fail across 119 files

just check
  → biome ci + tsc + knip all pass
```

## How to Manually Verify with the Real Task

1. Ensure `ghl-project-icon-regression-20260525-2122` is still in tasks.json with
   `status: "failed"` and `error_message: "dead_pid"`
2. Ensure the tmux session `agent-ghostty-launcher` window `@2` pane `%2` is still alive
   (or any tmux-backed task in `failed` state with a live process)
3. Open VS Code with Command Central loaded
4. In the Agent Status tree view, the task should show:
   - Orange warning icon (not the normal red error icon)
   - `"⚠ lifecycle conflict"` in the description line
   - Tooltip includes `Lifecycle conflict: Launcher marked failed (dead_pid) but process is still alive in terminal`
   - Expanded detail view shows a "Lifecycle conflict" detail node

If the tmux process has since exited, the task will render as a normal failure
(no conflict detected). This is correct behavior — the conflict is a live-state
observation, not a historical annotation.

## What Still Belongs in Ghostty Launcher

The root cause — the reaper reporting `dead_pid` for a live process — is a
Ghostty Launcher bug. CC's lifecycle conflict feature is a diagnostic overlay
that makes the contradiction visible; it does not fix the reaper.

Ghostty Launcher work needed:
- **Reaper PID check accuracy:** The `dead_pid` detection should verify process
  tree liveness (pgrep/ps check of the actual Claude PID and descendants) before
  declaring death, similar to CC's `inspectTmuxPaneAgent()` BFS approach
- **Race window:** The reaper may be checking PID liveness at a moment when the
  process tree is transitioning (e.g., between shell wrapper exit and Claude
  process fork). A brief grace period or retry would reduce false positives
- **Error message specificity:** `dead_pid` should include which PID was checked
  and what check was performed, to aid future debugging

## Design Decisions

- **Only positive liveness triggers conflict:** `"unknown"` (fail-open from tmux
  probe) does NOT trigger the conflict. This avoids false positive warnings when
  tmux is unavailable or the session metadata is stale.
- **No status mutation:** The lifecycle conflict is a rendering annotation, not a
  status override. The task stays `failed` in the data model. This preserves the
  launcher-truth hierarchy and avoids confusing the reconciliation tiers.
- **Failure-class statuses only:** `completed`, `completed_dirty`, and
  `completed_stale` do not trigger conflict checks — a live process after
  successful completion is normal (e.g., interactive REPL still open).
