# RESULT — Agent Status missing-current/running surface & detached misclassification

- **Task id:** `cc-current-running-surface-fix-20260613`
- **Date:** 2026-06-13
- **Repo:** `~/projects/command-central` (branch `main`)
- **Status:** ✅ Fixed, test-backed, full suite green (2075 pass / 0 fail). No push/tag/publish.

---

## 1. Symptom (from Mike's 21:40 screenshot)

A launcher lane that the registry still reported as `status=running`
(`ghostty-review-stdin-tty-fix-20260613`, Ghostty Launcher pane `%9`) was shown
under **GHOSTTY LAUNCHER → Failed & Stopped** with a `detached` badge — there was
no obvious "current / live" section, even though the lane was alive (tmux pane
exists, `#{pane_dead}=0`).

## 2. Root cause (verified in code)

The status shown in the tree is the *display* status produced by
`AgentStatusTreeProvider.toDisplayTask()`. Its Tier 4 fallback demoted a
registry-`running` lane to a terminal `stopped` / `completed_dirty` status
**whenever `isRunningTaskHealthy()` returned `false`**:

```ts
if (this.isRunningTaskHealthy(task)) return task;   // Tier 3
if (this.hasCommitsSinceStart(task)) return completed_dirty;  // Tier 4
return stopped;                                      // Tier 4
```

But `isRunningTaskHealthy()` returns `false` for **"could not confirm alive"**,
not only for "confirmed dead":

- the stale heuristic fires (old + `isAgentStuck`) while the JSONL stream is
  silent (normal for an interactive/REPL review lane), **and**
- pane evidence is `"unknown"` (the pane is alive but its foreground command is
  not a recognized agent CLI — `inspectTmuxPaneAgent` only returns `"alive"` for
  `claude/codex/cursor-agent/aider/ollama`), **or**
- the lane ran on another host whose tmux this machine cannot probe.

Once demoted to `stopped`, `getNodeStatusGroup()` routed the task to the
`attention` bucket → **"Failed & Stopped"**. The `detached` text is a separate
`classifyCompletionRouting()` label (no `session_key`/`callback_url`) — a
*visibility* signal that was riding on top of the wrongly-terminal status.

**The asymmetry that proves the bug:** `getStaleTransitionReason()` already
required `isTaskSessionConfirmedDead(task)` before demoting a running lane to
`completed_stale`. `toDisplayTask()`'s synchronous Tier 4 path did **not** — so a
live-but-unconfirmable lane was demoted by one path and kept by the other.

## 3. Fix (immediate, RC-safe classification layer — no tree rewrite)

`src/providers/agent-status-tree-provider.ts`:

1. **Tier 3b gate in `toDisplayTask()`** — a registry-`running` lane is only
   demoted to a terminal state when its session is **positively confirmed dead**
   (`isTaskSessionConfirmedDead`). Otherwise it stays `running`. This mirrors the
   gate `getStaleTransitionReason()` already uses, so the two paths agree.
   Detached / unconfirmable liveness is treated as visibility, not death.

2. **Host-authority in `isTaskSessionConfirmedDead()`** — returns `false`
   (not confirmed dead) when local probes are not authoritative for the task's
   host (`!isLocalFileProbeAuthoritative(task)`), mirroring the existing
   file-probe doctrine. A node-origin lane whose host we cannot verify is never
   demoted by a local tmux probe that simply can't see its session.

3. **`STATUS_GROUP_LABELS.running: "Running" → "Current · Live"`** — makes the
   live/current surface unmistakable. That group already sorts first
   (`TASK_STATUS_PRIORITY.running = 0`) and auto-expands
   (`getStatusGroupRecentThresholdMs(running) = +∞`), so running+detached lanes
   now land at the top in an obvious "Current · Live" section.

`detached` remains a `classifyCompletionRouting` visibility badge and now
coexists with a `running` status instead of implying a terminal one.

### Cache cost

`isTaskSessionConfirmedDead()` reuses the same 5s-TTL tmux/persist caches that
`isRunningTaskHealthy()` warmed one line earlier, so the gate adds **no extra
subprocess calls** on the render hot path.

## 4. UX decision (aligned with Mike's V2 steer)

- Keep the single status-grouping tree as the **RC-safe classification layer**;
  do **not** rewrite the tree. V2 builds on this layer.
- `running` + `detached` → **Current · Live**, never **Failed & Stopped**.
- `detached` is a visibility/attention badge, not a lifecycle state.
- **All history preserved** — completed/failed/stale/needs-review lanes remain
  visible and grouped; nothing is hidden or dropped.
- Stale review backlog stays **collapse-but-counted** via the existing
  `LIMBO_RECENT_THRESHOLD_MS` behavior (header keeps the full count).
- No `"none active"` / absence-implying wording introduced.

## 5. Files changed

| File | Change |
| --- | --- |
| `src/providers/agent-status-tree-provider.ts` | Tier 3b confirmed-death gate; host-authority in `isTaskSessionConfirmedDead`; `running` label → "Current · Live" |
| `test/tree-view/agent-status-running-detached-surface.test.ts` | **New** — running+detached stays Current/Live; node-origin host-authority; confirmed-dead still demotes; history preserved |
| `test/tree-view/agent-status-tree-provider-health.test.ts` | Updated the session-alive-but-stale case: now stays `running` (was `stopped`) |
| `test/tree-view/agent-status-launcher-interactive-claude.test.ts` | Updated "unknown pane + stale + live session" → stays `running`, badged `(possibly stuck)` |
| `test/tree-view/agent-status-pending-review-truth.test.ts` | Tier-4 fallback guard now uses a *confirmed-dead* session so it still exercises the terminal path |

## 6. Tests

- `bun test test/tree-view/` → **453 pass / 0 fail**
- `just test` (full suite + typecheck + quality gate) → **2075 pass / 1 skip / 0 fail**
- `just check` (biome ci + tsc + knip) → clean (8 pre-existing informational
  knip/lint warnings in `agent-status-perf-caches.test.ts`, untouched here)
- `git diff --check` → clean

New/changed coverage matches the verification ask:
- running + detached lane appears under **Current/Live**, not Failed & Stopped;
- node-origin running lane with unverifiable host is **not demoted** by a local probe;
- a **confirmed-dead** session still demotes out of running (no zombie lanes);
- historical completed/failed lanes remain visible and correctly grouped;
- the unconfirmable-but-live lane is honestly badged `(possibly stuck)`.

## 7. Behavior tradeoff (intentional, per doctrine)

A genuinely-abandoned lane whose **tmux session stays alive** now remains in
**Current · Live** (badged `(possibly stuck)`) until the session is positively
killed/closed — instead of being silently relabeled "stopped." This is the
doctrine ("a live session is revisitable; detached ≠ dead"). Confirmed-dead
panes/sessions and launcher completion evidence (receipt / `completed_at` /
`exit_code` / stream terminal event) still demote immediately, so this is not the
old disappearing/zombie regression.

## 8. Remaining RC blockers / follow-ups (NOT fixed here — kept focused)

1. **Needs Review stale counts (cross-repo / V2).** When the launcher reconciles
   a review (consumes the `/tmp/oste-pending-review/<id>.json` receipt, e.g. into
   a `reviewed/` subdir) **without stamping `review_state=reviewed` on the
   registry record**, CC's local probe reads `pending_review_path` as `missing`
   and routes the lane to **Needs Review (limbo)** indefinitely.
   `isReviewLifecycleResolved()` already suppresses the gap when the record
   carries `review_state ∈ {reviewed, no_review_expected}` or
   `review_status=approved` — so the durable fix is launcher-side stamping (or a
   Work System / OpenClaw-native projection of review lifecycle that CC reads
   instead of raw per-host receipt files). A CC-only `ReviewTracker.isReviewed`
   gate would only cover lanes reviewed via CC's own UI, not launcher-reconciled
   ones, so it was intentionally **not** added (would not address the observed
   mechanism and would widen the patch against Mike's "keep it focused" steer).

2. **Same-host abandoned lanes.** Host-authority only protects node-origin lanes
   with an unverifiable host. A same-host lane whose pane is confirmed dead still
   demotes correctly; a same-host lane whose session stays alive stays
   Current·Live (see §7). V2 could add an explicit "stale-live" sub-badge.

3. **Auto-commit sweep (process note).** Concurrent-lane auto-commit machinery
   split this work across `807f1158` (`[cc-current-running-surface-fix-20260613]`,
   the src gate) and `4a64e74b` (a sibling lane's `git add -A` swept the
   `running` relabel + the test files into `[cc-unified-status-tree-ux-20260613]`).
   All changes are present in `HEAD` and the suite is green; the remaining
   working-tree edits were committed separately by this lane. Flagged so the
   split commit history is understood, and as a reminder of the
   shared-working-copy hazard.
