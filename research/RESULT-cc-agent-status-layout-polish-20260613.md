# RESULT — Agent Status layout/noise polish for RC readiness

- **Task:** `cc-agent-status-layout-polish-20260613`
- **Repo:** `~/projects/command-central` (branch `main`)
- **Commit:** `72216ce1` — `fix(agent-status): collapse stale Needs Review backlog and calm idle Symphony summary`
- **Date:** 2026-06-13
- **Blocks CC RC?** **No.** This is additive noise-reduction. It removes false-alarm surface area without hiding any blocker. Safe to ship in the next RC; not a gate.

---

## 1. Coordination with the active rattle/perf lane (read this first)

The working tree already carried **uncommitted** changes from
`cc-rattle-perf-critical-bugs-20260613` in the *same* file I needed to touch
(`src/providers/agent-status-tree-provider.ts`) plus its test
(`test/tree-view/agent-status-tree-provider-diff-notifications.test.ts`).

What that lane added (inspected, not modified by me):

- `notifiedTerminalRuns: Map<string,string>` keyed by `<status>::<started_at>`.
- `shouldNotifyTerminalTransition(task)` — suppresses **duplicate** completion/
  failure toasts/sounds when a registry read-race flaps `completed→running→
  completed` for the same run. A genuine re-run (new `started_at`) still notifies.
- Two tests covering the flap-suppression and genuine-re-run cases.

That work **is** the "suppress duplicate notifications" bullet of this task's
scope (item 3). It is correct and I did **not** alter it.

**Decision — single compatible patch (path b).** Their hunks (lines ~1236 /
~2917 / ~3066) and mine (~818 / ~4430 / ~6455 / new test) live in disjoint
regions of the same file. The provider file cannot be split without interactive
staging (`git add -p` is unavailable in this environment), and the contract
requires a clean tree. The task explicitly authorized *"make a single compatible
patch after inspecting the current diff."* So my commit folds in their
notification-dedup verbatim alongside my layout changes. The commit message
credits the rattle lane and notes the dedup guard + its test are unmodified.
The file was last edited ~71 min before I started (19:35 vs 20:46), i.e. the
lane was parked, not mid-write, so there was no live-write race.

> If `cc-rattle-perf-critical-bugs-20260613` resumes: its provider+test changes
> are already in history under `72216ce1`. Its work is preserved; it can add its
> receipt / further changes on top. Nothing was lost or reverted.

---

## 2. Is the screenshot layout "expected"? — Expected vs Unexpected

| Screenshot symptom | Verdict | Mechanism |
|---|---|---|
| Top banner **"Symphony Status Surface: 101 standalone run attempts"** | **Expected output, but poorly framed** | `formatSymphonyRootDescription()` leads with the raw projected-run count and only the word "standalone" (= no workstream). With nothing running/RetryQueued it reads as a 101-item backlog when it is read-only history. |
| **COMMAND CENTRAL** has running lane but is shown near *Failed & Stopped* | **Expected** | Within a project, buckets render `running → attention → limbo → done` (`buildStatusGroupNodes`, `TASK_STATUS_PRIORITY`). Running already sorts first; flat lists (≤5 agents) sort running-first too. No change needed. |
| **SYMPHONY DAEMON "Needs Review · 10 agents"** expanded, listing old fable lanes "review receipt missing" from **21h–1d ago** | **Expected — and the core noise bug** | `getStatusGroupRecentThresholdMs("limbo")` returned **24h (`DAY_MS`)**. `statusGroupHasRecentItems` therefore auto-expanded any Needs Review bucket holding an item from the last 24h. 21h–1d-old review-receipt-missing / `completed_dirty` lanes kept the bucket expanded → wall of stale items. |
| **GHOSTTY LAUNCHER** "Failed & Stopped" + stale Needs Review | Partly addressed | Needs Review tightening (below) applies here too. Failed & Stopped intentionally left at 2 days — those are real blockers, not noise. |
| **CONFIG** collapsed | **Expected/correct** | Project groups with no running task collapse by default (`createProjectGroupItem`). |

**Routing into "Needs Review" (limbo)** is correct and was not changed:
`completed_dirty` / `completed_stale` → limbo; clean `completed` with a *missing
handoff* or a *missing review-queue receipt* → limbo; `completed` with
`review_status=pending/changes_requested` (unreviewed) → attention. Approved /
`review_state=reviewed` / remote-node tasks correctly fall through to done.

---

## 3. Recommended UX rules (the ruleset I implemented against)

1. **Headers always show truth; only auto-expansion is rationed.** Collapsing a
   bucket keeps its count (`Needs Review · N agents`) visible, so reducing noise
   never hides a blocker — the operator can always expand.
2. **Auto-expand only within the active working window.** A bucket should pop
   open for something you can act on *now*, not for an overnight backlog.
   - Running: always (∞).
   - Failed & Stopped (real blockers): 2 days (unchanged).
   - **Needs Review (review backlog): tightened 24h → 8h.**
   - Completed: never auto-expands (unchanged).
3. **Lead with liveness; mark idle explicitly.** A large historical count must
   not masquerade as an actionable queue. When nothing is running/RetryQueued,
   say so.
4. **Don't reorder or re-bucket** to chase the screenshot — running already
   sorts first. Reordering buckets risks hiding blockers; out of scope.
5. **One notification per run** (owned by the rattle lane; folded in here).

---

## 4. Changes made

All in `src/providers/agent-status-tree-provider.ts` + a new test block.

### 4a. Collapse stale "Needs Review" backlog
- New constant `LIMBO_RECENT_THRESHOLD_MS = 8 * 60 * 60 * 1000` (8h).
- `getStatusGroupRecentThresholdMs("limbo")` now returns it (was the `DAY_MS`
  fall-through). `attention` (2d) and `done` (always collapsed) unchanged.
- Effect: review lanes older than ~8h (the 21h–1d fable lanes) now render
  **collapsed-but-counted**; a just-completed needs-review lane still expands.

### 4b. Calm the idle "Symphony Status Surface" summary
- `formatSymphonyRootDescription()` appends `· none active` when
  `runs.length > 0 && running === 0 && retryQueued === 0`.
- Effect: `Symphony Status Surface: 101 standalone run attempts` →
  `… 101 standalone run attempts · none active`. When something is live the
  suffix is omitted and the existing `· N running` / `· N RetryQueued` parts
  show as before. Existing wording (incl. "standalone") is preserved, so the
  change is purely additive and test-safe.

### 4c. Folded-in (rattle lane, unmodified)
- `notifiedTerminalRuns` + `shouldNotifyTerminalTransition` notification dedup
  and its diff-notifications test. See §1.

### Tests added (`agent-status-tree-provider-rendering.test.ts`, +5)
- Needs Review collapses for a >8h-old review item.
- Needs Review stays expanded for a <8h-old review item.
- Failed & Stopped still expands a 10h-old blocker (proves the tightening is
  limbo-scoped, not global).
- Idle Symphony summary appends `none active`.
- Live Symphony summary omits it.

---

## 5. Gates

| Gate | Result |
|---|---|
| Focused tree/provider tests (rendering, diff-notifications, review-queue-gap, limbo-tier, openclaw-task-nodes) | **PASS** (130 + 58 + 116 across runs) |
| Symphony-label integration (`lane-registry-projection`, `tasks-json-startup-smoke`) | **PASS** |
| `just test-unit` | **PASS** (129 + 493) |
| `just fix` (biome format/lint) | clean |
| `just check` (biome ci + tsc + knip) | **PASS** — ✅ Checks complete |
| pre-commit hook (biome ci on staged files) | **PASS** (3 files, no fixes) |
| `git diff --check origin/main...HEAD` | clean (no whitespace/conflict markers) |
| `git status --porcelain` | clean |

> Note: `just check` surfaces **8 pre-existing biome warnings** (non-null
> assertions) in `test/tree-view/agent-status-perf-caches.test.ts` — an
> **unchanged** file, not touched by this task or the rattle lane. They are
> warnings (informational under `just check`), would trip strict `just ci`, and
> are unrelated to this work. The pre-commit hook only checks staged files, so
> they did not block the commit.

---

## 6. Deliberately NOT done (scoped out / future)

- **No bucket reordering / re-classification.** Running already sorts first;
  reordering risks demoting real blockers.
- **Failed & Stopped threshold untouched** (2 days). Old *stopped* lanes are
  mild noise but live alongside *failed* blockers in the same bucket; tightening
  could hide a failure. A future split of `stopped` vs `failed` recency is the
  cleaner fix if that bucket still feels noisy.
- **No "demote superseded fable review items" logic.** Truly demoting (vs
  collapsing) historical review-queue items needs a supersession/reconciliation
  signal that isn't modeled yet. Collapsing is the safe, no-data-loss step now.
  Follow-up: if launcher records review reconciliation, route reconciled limbo
  items to done.
- **8h threshold is a heuristic.** Chosen to sit below the overnight gap so
  21h–1d lanes collapse while same-session reviews stay open. Promote to a
  `commandCentral.agentStatus.reviewRecentHours` setting if operators want to
  tune it.

---

## 7. One-line RC call

Ship it in the next RC. Noise down (Needs Review backlog collapses; idle
Symphony count reads as history), zero blockers hidden, all gates green, clean
tree. Does **not** block CC RC.
