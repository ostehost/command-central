# RETRO: Agent Status Truth Wave v1

**Date:** 2026-04-10
**Lane:** `RETRO-agent-status-truth-wave-v1` (research only)
**Wave:** Spec (`64de485`) → Slice 1 shipped (`88e1e02 … 3b011af`) → Slice 2
in flight (dead-process-running), running alongside the five ghostty-launcher
dogfood lanes that produced the real signal for this pass.

This retro is operational, not generic. Section 6 is the ranked slice order
you can use right now while Slice 2 is still running.

---

## 1. What Slice 1 actually fixed

Display-layer only — no schema, no new data sources:

- **Limbo tier lands.** `AgentStatusGroup` gains `"limbo"` at
  `src/providers/agent-status-tree-provider.ts:219`, priority 2 at `:556`,
  `"Needs Review"` label at `:566`, yellow `question` icon at `:573`.
  `getNodeStatusGroup` at `:2869` routes `completed_dirty` and
  `completed_stale` out of `done` and into `limbo`.
- **Render order.** `running → attention → limbo → done` at `:2904`.
- **Review-status routing (tree only).** At `:2873`, completed tasks with
  `review_status ∈ {pending, changes_requested}` redirect to `attention`.
  Added in `c06d863`; tests in `83db428`.
- **Count bucket.** `AgentCounts.limbo` at `src/utils/agent-counts.ts:6`;
  `formatCountSummary` emits `"N limbo"` at `:63`. Badge no longer inflates
  `done` with dirty/stale exits.
- **`done` default-collapsed.** `createStatusGroupItem` at `:5525` forces
  Collapsed regardless of recency so actionable groups stay above the fold.
- **Net effect.** Two of the five largest display lies are dead:
  "dirty/stale lumped with clean done" and "stale exits inflate the green
  count." A third — "awaiting-review looks done in the tree" — is partly
  dead (tree routes, badge still lies).

## 2. What remains misleading after Slice 1

1. **Dead-process-running.** `getNodeStatusGroup` at `:2871` still trusts
   `status === "running"`. A crashed lane that never wrote a terminal event
   still shows `sync~spin` and inflates the working count. No liveness probe
   yet.
2. **Badge vs tree split.** `countAgentStatuses` deliberately ignores
   `review_status`, so a task awaiting review is routed to `attention` in
   the tree **and** still ticks the `done` badge. DEV-NOTES §2 records this
   as intentional; it is still a lie in the status bar.
3. **No historical tier.** Weeks-old failures mix with fresh ones in
   `attention`; weeks-old completions sit in `done`. Spec §3 age-split
   deferred.
4. **No host distinction.** Hub and local-node lanes interleave under one
   project group. Neither `hostname` schema nor `project_dir` path
   inference has been attempted.
5. **No handoff-file contract enforcement.** "Completed + documented
   (.oste-report.yaml present)" is indistinguishable from "completed +
   silent" in the UI even though the orchestrator already treats the
   latter as `contract_failure`.

## 3. Proven vs guessed signals (the wave's actual learning)

| Signal | Verdict | Evidence |
|---|---|---|
| `task.status == completed_dirty/stale` means "not truly done" | **Proven** | `88e1e02` routes to limbo; live data confirms |
| `review_status ∈ {pending, changes_requested}` is actionable | **Proven** | `c06d863`, `83db428` |
| `ProcessScanner` ps/lsof as liveness | **Proven (not yet wired)** | Spec §"Proven signals" lines 249–250 |
| Process-exit wrapper `oste-complete.sh $? $task_id` as canonical completion trigger | **Proven** | Load-bearing in `build_wrapped_agent_command()` |
| **Stream-file presence as liveness** | **Failed** | Slice 1's own team run was alive in tmux with no registered stream file (DEV-NOTES "Known issues") |
| `.oste-report.yaml.tests_passing: true` as truth | **Failed** | `ghl-stale-session-reuse-mainroof-v1` claimed pass; reproduction hit pre-existing `test-spawn.sh` failures. `cfcc03c` now records `test_status.claimed` with `verified: null` |
| `tasks.json.end_commit` from raw HEAD as review endpoint | **Failed** | Scenario D in the completion-range advisory — auto-commit Pass 2 captured a `.oste-report.yaml` deletion as `final_head`. Fix `cfcc03c` pins to TaskCompleted snapshot |
| TaskCompleted hook as completion trigger | **Failed** | Never registered in any `settings.json`. `scripts/write-prompt.sh` lied about this until `a7f2f4c` |
| Path-based host inference | **Guessed** | Not attempted; breaks on remote mounts |
| Age-based tier assignment | **Guessed** | Thresholds are arbitrary |

The rule for future slices: **trust `task.status`, `review_status`, `ps/lsof`,
git commits since `start_commit`, and `exit_code`. Treat stream-file presence,
`tests_passing`, and raw-HEAD range endpoints as stories an agent told.**

## 4. Why Slice 2 = dead-process-running is the right next slice

Of the five remaining lies in §2, dead-process-running is the only one that:

- kills the largest active lie (crashed lane still spinning, inflating
  "working" count that operators act on);
- needs **no schema change and no orchestrator cooperation** —
  `ProcessScanner` already exists;
- uses a **proven** signal per the spec (`ps/lsof`), not a guessed one;
- plugs cleanly into the tier Slice 1 just built (dead+recent `running` →
  `limbo`, dead+old → `historical` when that tier lands); and
- unblocks honest auto-refresh cadence — idle when nothing is alive.

**Critical caveat the dogfood wave surfaced:** the liveness check must probe
the process group (or tmux pane), **not the stream file**. Slice 1's own team
run would have been mis-flagged by a stream-file check. Burn this into the
Slice 2 implementation or it will repeat the Slice 1 lie in a new place.

## 5. Slice 3 — what ships next if Slice 2 lands cleanly

**Slice 3: Badge-truth fix.** Push `review_status` routing from
`getNodeStatusGroup` into `countAgentStatuses`. Roughly 20 lines in
`src/utils/agent-counts.ts` plus test updates. No schema change. Fixes
misleading item #2 above.

Why this before the historical tier:

- It is the cheapest slice in the backlog by an order of magnitude.
- It fixes a **currently visible** lie in the status bar badge that
  operators look at constantly, not an archival tier they rarely open.
- It is purely additive — the intentional split from Slice 1 (tree knows
  `review_status`, badge doesn't) was a scope choice, not an architectural
  one. Slice 3 simply collapses the split.
- It has zero risk of regressing the ProcessScanner work in Slice 2.

## 6. Ranked next-slices playbook (operational)

Use this order while Slice 2 is running and after it merges. Each row
includes the signal it depends on and whether that signal is proven.

| Rank | Slice | Signal | Proven? | Cost | Fixes |
|---|---|---|---|---|---|
| **Slice 2 (in flight)** | Dead-process-running detection via `ProcessScanner` | ps/lsof liveness | ✅ | Medium | Running-but-crashed lanes |
| **Slice 3** | Badge-truth: `review_status` into `countAgentStatuses` | `task.review_status` | ✅ | ~20 lines | Badge/tree divergence |
| **Slice 4** | Handoff-file detection — probe `.oste-report.yaml` presence | filesystem read | ✅ | Small | "completed + silent" invisibility |
| **Slice 5** | Historical tier — age-split `done`/`attention` | timestamps | ✅ | Medium | Fresh-vs-stale mixing |
| **Slice 6** | Host hint badge from `project_dir` inference (**hint only, not grouping**) | path heuristic | ⚠️ guessed | Small | Hub vs local confusion |
| **Deferred** | Tmux pane liveness as secondary signal | tmux probe | ⚠️ unvalidated | Medium | Only after Slice 2 proves stable |
| **Deferred** | Host grouping Phase 2 (hostname in schema) | orchestrator cooperation | — | Large | Proper multi-node display |

**Do NOT promote Slice 6 above Slice 5** — path inference is a guessed
signal and the spec is clear that guessed signals belong in badges/tooltips,
not grouping logic.

## 7. Process lessons

### 7a. Stream-vs-tmux truth

Slice 1's own team run proved the lesson the hard way: the lane was alive
across tmux panes while its registered stream file was missing. Any
liveness code that reads stream files first will false-negative on exactly
the orchestration modes we use most. **Stream-file existence is evidence a
stream was once written, not evidence the process is currently alive.**
Slice 2's ps/lsof probe must be the authoritative source; stream files are
a hint at best, and only as a tiebreaker.

### 7b. task_id reconciliation drift

Slice 1's first `.oste-report.yaml` was written as
`task_id: "cc-agent-status-slice1"` — the `-v1` suffix was dropped. The
orchestrator lane appeared live/unreconciled for minutes after all work
was already committed clean. Fix commit `3b011af` corrected it, and
`pending-review.sh` (per `cfcc03c`) now sets `report_task_id_mismatch:
true` when report `task_id` disagrees with launcher `task_id`.

Two consequences:

1. **Command Central should surface `report_task_id_mismatch`** — it is a
   cheap "this lane will look wrong until reconciled" flag, already
   populated upstream.
2. **Agent prompts should not ask the agent to type the task_id.** The
   launcher knows it; interpolate it. This is exactly the class of bug
   `a7f2f4c` killed in `scripts/write-prompt.sh` (`$task_id` had been
   dead-wired via a shellcheck disable).

### 7c. Ingestion must precede auto-commit

`cfcc03c` reordered the ghostty-launcher completion flow because
auto-commit Pass 2 was capturing the post-ingest deletion of
`.oste-report.yaml` and writing that as `final_head`. Any Command Central
UI surface that treats `tasks.json.end_commit` as the review endpoint must
assume **pre-fix values are untrusted** and wait for the snapshot-pinned
field to propagate.

### 7d. Agent claims ≠ orchestrator truth

`tests_passing: true` is now recorded as `test_status.claimed` with
`verified: null` until the orchestrator re-runs. Every Command Central
surface that displays "passing" must say who verified it — this is a UI
obligation created by the orchestrator-side fix.

### 7e. Prompts must match what is wired

`scripts/write-prompt.sh` told agents the TaskCompleted hook notified the
orchestrator; it was never registered in any `settings.json`. Fix
`a7f2f4c`. Lesson for Command Central: when a spec references a hook,
grep `settings.json` across both repos before committing the prose.

### 7f. Hot-context continuation rule

**Default: when an active lane already has the best context and is still
productive, continue/refine work in that same window over spawning a cold
replacement lane.** Re-briefing is expensive; mental model is fragile; the
second agent re-reads the same files, re-derives the same conclusions, and
often misses subtleties the first agent had internalized.

**Why this helped in the current wave.** Two concrete examples, both
validated after the fact:

1. **Slice 1's review-status routing was a hot-context bolt-on.** The
   original plan was limbo tier only (commit `88e1e02`). Once the agent
   was deep inside `agent-status-tree-provider.ts`, it could see that
   routing `review_status` pending/changes_requested into `attention` was
   a ~10-line adjacent fix using a field that was already in the schema
   (commit `c06d863`, tests `83db428`). Spawning a separate lane for that
   would have cost a full re-orientation pass and likely produced a merge
   conflict on the same file. Continuing in-window was clearly correct.
2. **The `3b011af` task_id reconciliation fix stayed in-window.** The
   `.oste-report.yaml` had the wrong task_id. Filing a follow-up lane for
   a one-line YAML edit would have been absurd. The same agent, with the
   same context, fixed and re-committed.

Conversely, **Slice 2 (dead-process-running) is correctly being spawned as
a separate lane** — different files (`ProcessScanner` integration), a
different signal class (liveness vs. metadata), and low overlap with
Slice 1's display-layer surface. That is the right spawn call.

**When to continue in-window:**
- Adjacent fixes to the same files or concerns the agent has just touched
- Refinement passes that build directly on a just-landed commit
- Gaps found during self-review or reviewer pushback on the same diff
- Task/metadata reconciliation (task_id, completion report corrections)
- Any change where the cost of re-briefing a fresh agent exceeds the
  change itself

**When to spawn fresh:**
- Material scope change (new files, new signal class, new layer of the
  stack) — Slice 2 is the canonical "spawn fresh" case
- Writer overlap with another *live* lane on the same file becomes
  dangerous (merge-conflict risk > coordination cost)
- The original lane's context is stale, polluted, or got the architecture
  wrong and needs a clean reviewer perspective
- The original agent is mid-failure and the failure mode is the context
  itself
- Independent-enough that it can genuinely run in parallel and you want
  the parallelism

**What this reduces:**
- **Re-briefing cost** — a cold lane re-reads the spec, the dev notes, the
  tree provider file, and git log just to reach the point the hot lane
  was already at.
- **Context loss** — subtle mental model items (e.g., "countAgentStatuses
  deliberately ignores review_status; that split is intentional but still
  misleading") rarely survive re-briefing.
- **Duplicate analysis** — the fresh lane re-derives the same conclusions
  about the same files before making the same decisions.

**Risk boundary.** Continue in-window when the new work is *refinement or
adjacent* to what the lane just did. Spawn fresh when scope shifts
materially **or** when you have evidence of dangerous writer overlap with
another live lane. The mistake to avoid in both directions:
over-continuation (scope creep inside one lane until the diff is
unreviewable) and under-continuation (spawning a cold lane to fix a
one-line follow-up on hot files).

**Heuristic.** If the follow-up change fits in the agent's current mental
model without re-reading files, continue in-window. If the agent would
need to re-read the spec or re-orient in a different directory, spawn
fresh.

---

## 8. Operational checklist (use while Slice 2 is running)

- [ ] Slice 2 probes **ps/lsof** (or tmux pane), **never** stream-file
      presence, as the liveness signal.
- [ ] Slice 2 routes dead+recent `running` → `limbo`, reusing the tier
      Slice 1 built; does not introduce a new tier.
- [ ] Slice 3 = badge-truth (`review_status` into `countAgentStatuses`)
      is queued ahead of the historical tier.
- [ ] `report_task_id_mismatch` (populated by `cfcc03c`) is surfaced
      somewhere in the UI — it is a free visibility win.
- [ ] Any "tests passing" surface distinguishes `claimed` from `verified`.
- [ ] Pre-`cfcc03c` values of `tasks.json.end_commit` are treated as
      untrusted until the snapshot-pinned field propagates.
- [ ] Slice 1 DEV-NOTES or the spec doc is amended to record that only a
      subset of the 5-tier model landed, so the next reader does not
      assume the full spec shipped.
- [ ] **Hot-context continuation applied:** before spawning any follow-up
      lane, ask whether the hot lane could make the change in-window.
      Default to in-window for adjacent/refinement work; spawn fresh only
      on material scope change or live writer overlap.

## 9. One-line call to action

Ship Slice 2 using `ProcessScanner` (**not** stream-file presence), then
Slice 3 badge-truth before the historical tier. Prefer in-window
continuation for any Slice 2 follow-up work — only spawn a fresh lane
when scope shifts materially.
