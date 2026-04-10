# DEV-NOTES: Agent Status Slice 1 — Truthfulness Pass

**Date:** 2026-04-10
**Task:** cc-agent-status-slice1
**Scope:** Display-layer only — no schema changes, no new data sources

## Summary

Shipped the smallest high-leverage truthfulness pass for the Agent Status tree view. The core problem: `completed_dirty` and `completed_stale` lanes were inflating the clean "done" count and sitting alongside genuinely finished work, making the status view misleading.

## Changes

### 1. Limbo display tier

Added a fourth status group — `limbo` (labeled "Needs Review") — between `attention` and `done`:

- **`completed_dirty`** → limbo (materially complete but working tree was dirty)
- **`completed_stale`** → limbo (completion timed out or went stale)
- Only clean **`completed`** stays in `done`

Group ordering is now: `running` → `attention` → `limbo` → `done`

Limbo uses a yellow question-mark icon to visually distinguish it from both failures (orange warning) and clean completions (green check).

### 2. Review status routing (display-layer only)

Completed tasks with `review_status: "pending"` or `"changes_requested"` are routed into the `attention` group in the tree view display. This uses the existing `review_status` field already in the schema — no schema changes.

Important: this routing happens only in `getNodeStatusGroup` (tree provider display logic). The `countAgentStatuses` function (used by status bar badges) does NOT consider `review_status` — it routes purely on `task.status`. This split is intentional: badge counts reflect orchestration state, while tree grouping reflects actionability.

### 3. Count fixes

- `AgentCounts` interface now includes `limbo: number`
- `countAgentStatuses` routes `completed_dirty`/`completed_stale` to limbo bucket
- `formatCountSummary` shows limbo between attention and done
- Top-level summary no longer inflates "done" with ambiguous states

### 4. Done group default-collapsed

The `done` group now always renders as `Collapsed` regardless of recency. Previously it used `statusGroupHasRecentItems` which could expand it, pushing actionable groups below the fold.

## Files changed

| File | Change |
|------|--------|
| `src/utils/agent-counts.ts` | limbo bucket in interface, counting, formatting |
| `src/providers/agent-status-tree-provider.ts` | AgentStatusGroup type, priority/labels/icons, getNodeStatusGroup routing, buildStatusGroupNodes ordering, createStatusGroupItem collapse logic |
| `test/utils/agent-counts.test.ts` | Updated expectations for limbo bucket |
| `test/services/agent-status-bar-count.test.ts` | Updated expectations for limbo display |
| `test/tree-view/agent-status-limbo-tier.test.ts` | New focused test suite (limbo routing, review_status, count behavior) |

## What was NOT changed

- **No schema changes** — `AgentTask` interface and `tasks.json` format are untouched
- **No new data sources** — no handoff-file detection, no process liveness probing
- **No host grouping** — multi-host display is out of scope
- **No schema migration** — existing data works as-is

## Known issues / observations

### Stream-based liveness vs actual tmux execution

During this team run, the orchestrator noted that the lane was live in tmux across team panes even though the registered stream file was missing. **Stream file presence is not a reliable liveness signal for team-mode runs.** The current display code doesn't depend on stream files for grouping decisions, but any future liveness indicator should account for this gap. A tmux session can be alive and producing work without a corresponding stream file being registered.

### Pre-existing test failures

The Reviewer confirmed 3 pre-existing test failures in the broader suite (536 tests total) that are unrelated to this change. They reproduce identically on the baseline commit.

## Recommended next slices

1. **Handoff-file detection** — detect presence/absence of the handoff file to distinguish "completed but forgot to write notes" from "completed with full deliverables"
2. **Dead-process-running detection** — flag lanes where status is "running" but the process is gone
3. **Host grouping** — group agents by host when multi-node orchestration is active
4. **Stream liveness indicator** — use tmux session probing as a secondary liveness signal when stream files are missing
