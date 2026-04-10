# DEV-NOTES: Agent Status Slice 3 — Badge-Truth Fix

**Date:** 2026-04-10
**Task:** cc-agent-status-slice3-v1
**Scope:** Count/badge layer only — no schema changes, no new data sources, no tree-provider edits

## Summary

Closed the deliberate gap Slice 1 left open: `countAgentStatuses` now routes completed tasks with `review_status` of `pending` or `changes_requested` into the `attention` bucket instead of `done`. Badge/status-bar counts now tell the truth that the tree view was already telling — awaiting-review work is no longer counted as finished.

## Problem

Slice 1 shipped a tree-layer fix: `getNodeStatusGroup` routes completed+pending/completed+changes_requested into the `attention` group. But `countAgentStatuses` intentionally kept routing purely on `task.status`, so the status-bar badge and summary text continued to call those same tasks "done". The Slice 1 dev notes called this split intentional ("badge counts reflect orchestration state, while tree grouping reflects actionability"), and the `RETRO-agent-status-truth-wave-v1` document flagged the resulting divergence as the next highest-priority truthfulness fix.

The practical symptom: tree said "N attention" while the status bar said "N done" for the exact same tasks. Operator-facing counts lied.

## Changes

### Count routing (`src/utils/agent-counts.ts`)

Inside the `completed` case of `countAgentStatuses`:

```ts
case "completed":
    if (
        task.review_status === "pending" ||
        task.review_status === "changes_requested"
    ) {
        counts.attention++;
    } else {
        counts.done++;
    }
    break;
```

This is exact symmetry with `AgentStatusTreeProvider.getNodeStatusGroup` at `src/providers/agent-status-tree-provider.ts:2869-2886`. The four cases:

| `task.status` | `review_status`       | bucket    |
|---------------|-----------------------|-----------|
| completed     | pending               | attention |
| completed     | changes_requested     | attention |
| completed     | approved              | done      |
| completed     | null / undefined      | done      |

No other buckets change. `completed_dirty` / `completed_stale` still route to `limbo`. `running` still routes to `working`. `failed` / `killed` / `stopped` / `contract_failure` still route to `attention`.

### Test coverage

Added focused coverage across three files:

1. **`test/utils/agent-counts.test.ts`** (6 new tests)
   - Individual tests for each of the four `review_status` states on a completed task.
   - Mixed bucket scenario: 1 running + 1 completed+approved + 1 completed+pending + 1 completed_dirty → `{working: 1, attention: 1, limbo: 1, done: 1, total: 4}`.
   - `formatCountSummary` with `includeAttention: true` against the mixed scenario to prove the `N attention` segment renders.

2. **`test/services/agent-status-bar-count.test.ts`** (2 new tests)
   - Status-bar badge text contains `1 attention` and `1 done` for `[completed+pending, completed+approved]`.
   - Status-bar badge text contains `$(warning)` icon and `1 attention` for `[completed+changes_requested]` alone.
   - The `makeTask` helper was extended additively with an optional `review_status` parameter so existing tests remain unchanged.

3. **`test/tree-view/agent-status-limbo-tier.test.ts`** (2 tests updated)
   - Slice 1 left a deliberate test block asserting that `countAgentStatuses` ignores `review_status`. Slice 3 reverses that invariant, so the block needed updating:
     - Comment block rewritten to describe Slice 3 behavior.
     - `describe` renamed from `"countAgentStatuses ignores it (display-layer only)"` to `"countAgentStatuses routes pending/changes_requested to attention"`.
     - `pending` and `changes_requested` tests now assert `attention: 1, done: 0`.
     - `approved` and `null` tests left untouched (they already assert `done: 1, attention: 0` which is still correct).

## Files changed

| File | Change |
|------|--------|
| `src/utils/agent-counts.ts` | +8/-1 — review_status branch inside the `completed` case |
| `test/utils/agent-counts.test.ts` | +80/-1 — new `review_status` routing suite + mixed-bucket + formatCountSummary assertion |
| `test/services/agent-status-bar-count.test.ts` | +22/-1 — extended `makeTask` helper + 2 status-bar-level tests |
| `test/tree-view/agent-status-limbo-tier.test.ts` | +12/-12 — updated Slice 1 stale invariant block |

## What was NOT changed

- **No schema changes** — `AgentTask.review_status` already existed.
- **No tree-provider edits** — the display-layer routing in `getNodeStatusGroup` was already correct from Slice 1. Slice 3 only needed to make the count function catch up.
- **No Slice 2 overlap** — process/liveness / dead-process-running code was untouched.
- **No historical tier, host grouping, or handoff-file detection** — all out of scope.
- **No new exports, no new helpers** — inline branch only.

## Validation

Focused tests: `bun test test/utils/agent-counts.test.ts test/services/agent-status-bar-count.test.ts test/tree-view/agent-status-limbo-tier.test.ts` → all pass.

Full suite: 1284 pass, 8 fail. The 8 failures are **pre-existing and unrelated** to this slice:
- `test/ghostty/window-focus.test.ts` — 4 failures (launcher script resolution)
- `test/integration/cross-repo-smoke.test.ts` — 1 failure (launcher script lookup)
- `test/tree-view/agent-status-tree-provider.test.ts` — 3 failures (liveness / stale-running overlays)

These match the baseline noted in the Slice 1 dev notes. Zero Slice 3 regressions.

Typecheck, Biome lint, and `bun run build` all pass.

## Known issues / observations

### Reviewer false-negative on initial pass

The first review pass reported a coverage gap in `agent-status-bar-count.test.ts`, but the tester had already added both required status-bar-level tests in commit `1d5a6bc`. The reviewer's re-check confirmed coverage was fine. No action needed — just worth noting that reviewers reading a diff should grep the actual test names, not just skim.

### Slice 1's "intentional split" was actually debt

The Slice 1 dev notes framed the badge-vs-tree split as an intentional design choice: "badge counts reflect orchestration state, while tree grouping reflects actionability." In practice, users don't perceive that distinction — they just see two numbers that disagree about the same tasks and lose trust in both. Slice 3 collapses the split in the honest direction (badge matches tree). Future truthfulness slices should default to symmetry between summary and detail views unless there's a concrete user-visible reason to diverge.

### Stale Slice 1 test block

Slice 1 added a test block that explicitly asserted `countAgentStatuses` ignores `review_status`. That block was a tripwire for any future slice that closed the gap — which is exactly what Slice 3 had to do. It would have been cleaner for Slice 1 to omit the block entirely (leaving the invariant unasserted) or to mark it as a known intentional-divergence with a TODO. Something to consider for future deliberate gaps: prefer a comment over a test when the invariant is expected to be reversed.

## Recommended next slices

Per `research/RETRO-agent-status-truth-wave-v1.md`, after Slice 3 the remaining truthfulness slices are:

1. **Dead-process-running detection** (Slice 2, in flight on a separate worktree)
2. **Handoff-file detection** — distinguish "completed but forgot DEV-NOTES" from "completed with full deliverables"
3. **Stream liveness as secondary signal** — tmux session probing when stream files are missing
4. **Host grouping** — group agents by host when multi-node orchestration is active
