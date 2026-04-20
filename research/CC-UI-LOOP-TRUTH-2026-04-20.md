# Command Central UI Loop Truth — 2026-04-20

Task: `cc-ui-loop-truth-20260420-1242`
Related: `ghostty-launcher-exit-gap-20260420-0811` (launcher-side fix `5a19f6e`)

## The bug (user-visible)

Command Central kept rendering `ghostty-launcher-exit-gap-20260420-0811`
under **Running / possibly stuck** even though the agent had actually
completed. The screenshot showed the task "running for 25m, no activity
for 15m" with the start commit `9d87ebe` — despite the launcher's
system-completion hook having already written
`/tmp/oste-pending-review/ghostty-launcher-exit-gap-20260420-0811.json`
with `status: completed`, `exit_code: 0`, and `end_commit: 5a19f6e`.

## Root cause

CC treats `tasks.json` as the single source of truth. The launcher's
completion path writes `pending-review/<id>.json` *before* it updates
`tasks.json`. In the exit-gap bug that update was delayed (subshell hang);
even after the launcher-side fix in `5a19f6e`, the two writes are not
atomic and a window remains where:

- `tasks.json` still has `status: "running"`
- `/tmp/oste-pending-review/<task_id>.json` already says `status: "completed"`

Filesystem evidence collected during this fix:

```
Apr 20 08:37:31 2026  /tmp/oste-pending-review/ghostty-launcher-exit-gap-20260420-0811.json
Apr 20 08:43:13 2026  ~/.config/ghostty-launcher/tasks.json
```

— ~6-minute gap between ground truth arriving and the status field
landing in tasks.json. CC's existing runtime-health inference
(`toDisplayTask → isRunningTaskHealthy` in
`src/providers/agent-status-tree-provider.ts`) still surfaces "stuck"
warnings during that window because the tmux session may still be alive
(a live Claude subshell left behind by the exit gap) and the stream file
is quiet.

## The fix (narrowest practical)

**New utility** `src/utils/pending-review-probe.ts`
  Reads `/tmp/oste-pending-review/<task_id>.json` (overridable via
  `CC_PENDING_REVIEW_DIR` for tests), caches results for 5 s, and
  exposes `receiptToOverlay(receipt)` that maps
  `{status, exit_code, *_commit}` onto the existing status overlay
  contract (`completed` / `failed` / `stopped`).

**Tree provider wiring** `src/providers/agent-status-tree-provider.ts`
  Inside `toDisplayTask`, when the task's tasks.json status is still
  `running`, consult the pending-review receipt first. If one exists,
  apply its overlay — which also carries the correct `end_commit` so the
  UI stops showing the old start-sha. The existing stale-reason and
  runtime-inference paths remain as fallbacks for tasks that complete
  without a launcher-written receipt (e.g., pre-OpenClaw external
  terminal discoveries).

Also extended `applyRuntimeStatusOverlay` to accept an `endCommit` field
so receipt-overlaid tasks surface the launcher's commit hash in the UI
without having to wait for tasks.json.

### Why pending-review is the right anchor

- It is written by **`oste-complete.sh`** on the launcher side — the
  authoritative system-level completion hook. If the receipt exists, the
  agent finished. Full stop.
- It already survives crashes (the launcher fix `9d87ebe` reaps stale
  dashboard lanes against this file; `5a19f6e` now guarantees the
  subshell terminates after the receipt is written, so there's no
  phantom pane lingering).
- It is keyed by `task_id` — the same key CC already uses for discovery,
  session ingestion, and the review tracker.
- It preserves compatibility: non-OpenClaw external-terminal tasks never
  write a receipt, so the probe quietly returns `null` and the existing
  runtime-health path keeps handling them.

## Evidence

- Unit tests: `test/tree-view/agent-status-pending-review-truth.test.ts`
  - running task + successful receipt → status `completed`, correct end_commit
  - running task + failed receipt → status `failed`
  - running task + no receipt → unchanged (runtime inference keeps running)
  - running task + canceled receipt → status `stopped`
  - already-completed task + receipt → tasks.json end_commit wins
- Full suite: `just test` → 1376 pass / 0 fail
- Tree-view suite: `bun test test/tree-view/` → 265 pass / 0 fail
- Strict check: `just check` → clean (biome CI + tsc + knip)

## Follow-ups (not in this change)

1. **Enrich completed tasks too.** When tasks.json already says
   `completed` but the receipt has a more specific `end_commit`, prefer
   the receipt. This matters when tasks.json was written by an older
   launcher that never persisted `end_commit`. Low priority — the
   current launcher writes it.
2. **Proactive receipt watcher.** Today the probe is polled from
   `toDisplayTask` (cached 5 s). Adding a native `fs.watch` on
   `/tmp/oste-pending-review/` and kicking a refresh on create would
   drop the median exit-gap latency from ~5 s to ~0 s. Gate on user
   demand.
3. **Surface `agent_summary` from the receipt.** `oste-complete.sh`
   already stores the agent's last assistant message. CC could show it
   as a detail node under completed tasks instead of waiting for the
   review pane. Orthogonal to truth — more a UX enrichment.
4. **Flow-task mirror.** `TaskFlowService` uses the same SQLite ledger
   and may exhibit a symmetrical lag. If it ever shows up in dogfood,
   the same probe pattern drops in cleanly.
