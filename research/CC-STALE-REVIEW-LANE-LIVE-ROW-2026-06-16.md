# Command Central — Stale Review-Lane Live Row Hardening

**Task:** `cc-stale-review-lane-live-row-20260616`
**Date:** 2026-06-16
**Host:** Mike MacBook Pro
**Parent HEAD:** `7a1c7e15`
**Predecessor fix:** `51068e7a` (reviewed receipt overrides stale **source-task** review_state projection)

## Problem (Symphony dogfood example)

During the Symphony dogfood, review lane
`review-symphony-visible-claude-entrypoint-20260616` completed: it wrote and
committed its review artifact (`research/REVIEW-symphony-visible-claude-entrypoint-20260616.md`,
commit `43cc008` in `symphony-daemon`), and the **source** task was marked
reviewed. But Command Central still showed the **REVIEW LANE ITSELF** under
Live / running / stale.

Observed pre-repair facts for the review-lane row:

- `tasks.json` row: `status=running`, `tmux_pane_id=%139`, `completed_at=null`,
  `pending_review_path=/tmp/oste-pending-review/review-symphony-visible-claude-entrypoint-20260616.json`,
  `end_commit=null`, `start_commit=null`, `role=reviewer`, `lane_kind=review`,
  `handoff_file=research/REVIEW-symphony-visible-claude-entrypoint-20260616.md`.
- The review pending-review JSON was **absent** (neither active nor in the
  `reviewed/` archive). A review lane is `no_review_expected` — it is never owed
  a review of *itself* ("the handoff IS the review artifact").
- The review artifact existed on disk and the repo carried the review commit.
- `scripts/oste-complete.sh review-… 0` repaired the projection to
  `status=completed`, `review_state=no_review_expected`, `pending_review_path=null`.

### Why CC kept it under Live/running

`toDisplayTask()`'s reconciliation hierarchy never demoted the row:

- **Tier 1b** (pending-review receipt) — no receipt for the review lane → skip.
- **Tier 2a** (staleness cache) — fresh, not yet cached → skip.
- **Tier 2b** (stream terminal event) — none → skip.
- **Tier 2c** (launcher completion fields) — `completed_at=null`, `exit_code=null` → skip.
- **Tier 3** (liveness) — the reviewing agent **lingers at its prompt after
  finishing** (per the harness contract: "send a final response and wait at the
  Claude Code prompt"), so the live `claude` process kept the pane "alive" and
  `isRunningTaskHealthy()` returned true → the row stayed `running`.

The decisive insight: a reviewer lane's **deliverable is the review artifact**.
Once that artifact (or a recorded review commit) exists, the lane is done
regardless of the at-prompt process. The lifecycle hook just failed to finalize
the row. `end_commit`/`start_commit` were both null, so the **artifact's
presence** — not a commit count — is the authoritative completion evidence.

## Change

Display-only reconciliation (no `tasks.json` mutation), in three small parts.

### 1. `isReviewOnlyLane(task)` — `src/utils/auto-review-lane.ts`

New pure predicate, broader than `isAutoReviewLane` (which is deliberately
narrow — it only matches `/tmp/*-review` worktrees so real-dir reviewer lanes
are never *hidden*). `isReviewOnlyLane` exists for **lifecycle reconciliation**,
not filtering, and fires for reviewer lanes wherever they ran:

- `role === "reviewer"`, OR
- `lane_kind === "review"` (the Work System canonical kind), OR
- `review-` id prefix **corroborated by** a `/REVIEW-` handoff artifact (the two
  weak heuristics are required together so an implementation task merely *named*
  `review-…` is not misclassified).

### 2. Tier 1c — `getDeliveredReviewLaneOverlay()` in `toDisplayTask()`

Runs inside the `status === "running"` block, right after the pending-review
receipt overlay (so it beats the staleness cache **and** the liveness inference).
Demotes a running reviewer lane to `completed` / `review_state=no_review_expected`
when **all** gates hold:

- `isReviewOnlyLane(task)` — only reviewer lanes are `no_review_expected`.
- `isLocalFileProbeAuthoritative(task)` — a remote node's lane is judged by its
  own metadata, never by a hub-local file probe (preserves remote reviewers).
- the self pending-review receipt is **not** genuinely `present` (a present
  active receipt is anomalous → defer rather than force-complete).
- **positive delivery evidence (any one):** the declared review handoff artifact
  exists on disk (`getDeclaredHandoffState === "present"`), OR a review commit is
  recorded (`end_commit` set and ≠ `"unknown"`).

A genuinely in-flight reviewer (no artifact yet, no commit) is preserved as
`running`. The result is an in-memory display row only — identical to every
other `toDisplayTask` overlay.

### 3. `isReviewQueueReceiptMissing()` hardening

Added `if (isReviewOnlyLane(task)) return false;` — a reviewer lane is never owed
a review of itself, so its absent self-referential `pending_review_path` is the
expected steady state, **not** a review-queue gap. This keeps already-`completed`
reviewer rows (that bypass Tier 1c) out of the "limbo / review receipt missing"
bucket.

### Outcome

The stale review-lane row now renders as **completed → Done /
no_review_expected** (not Live/running, not a false "review receipt missing"
limbo), matching what `oste-complete.sh` would have projected — without CC
writing to `tasks.json`.

## Files changed

| File | Change |
| --- | --- |
| `src/utils/auto-review-lane.ts` | New `isReviewOnlyLane()` predicate |
| `src/providers/agent-status-tree-provider.ts` | Tier 1c `getDeliveredReviewLaneOverlay()` in `toDisplayTask()`; import; `isReviewQueueReceiptMissing()` reviewer-lane gate |
| `test/tree-view/agent-status-review-lane-stale-row.test.ts` | New focused fixture/test suite (8 tests) |
| `test/utils/auto-review-lane.test.ts` | `isReviewOnlyLane` unit coverage (5 tests) |

## Tests

New suite `test/tree-view/agent-status-review-lane-stale-row.test.ts` builds the
Symphony-style row and asserts via the real display pipeline (`toDisplayTask`):

- **delivered review artifact → completed/no_review_expected, not running** (core case)
- recorded review `end_commit` → completed (no artifact field)
- `lane_kind=review` reviewer lane with delivered artifact → completed
- running reviewer with a declared-but-unwritten artifact → **stays running** (preserved)
- running reviewer with no declared artifact and no commit → **stays running** (preserved)
- implementation lane with a present handoff → **NOT** auto-completed (reviewer-only gate)
- node-origin running reviewer with a hub-local artifact → **stays running** (probe not authoritative)
- already-`completed` reviewer with absent self pending-review path → Done, not limbo, no "review receipt missing"

`test/utils/auto-review-lane.test.ts` adds 5 `isReviewOnlyLane` cases
(reviewer in a real dir, `lane_kind=review` only, `review-`+`/REVIEW-` corroboration,
normal developer task, and `review-` id alone NOT misclassified).

### Validation run

```
bun test test/tree-view/agent-status-review-lane-stale-row.test.ts   # 8 pass
bun test test/utils/auto-review-lane.test.ts                          # 21 pass
just test        # 2221 pass / 1 skip / 0 fail (155 files), quality + partition checks pass
just check       # biome + tsc + knip — passes (8 pre-existing perf-caches warnings, not from this change)
just test-validate  # 100% partition coverage
```

## Acceptance criteria → status

- ✅ Focused fixture/test for the `review-symphony-…` style row (running +
  review id + missing pending review + artifact/commit evidence) → not Live/running.
- ✅ Shows as completed / no_review_expected (preferred), not active live work;
  reviewer lanes also no longer surface a false "review receipt missing" limbo.
- ✅ Genuine running reviewer lanes preserved (no artifact/commit yet; remote-node lanes).
- ✅ No `tasks.json` mutation from display logic — overlay shapes the in-memory row only.
- ✅ No publish/push/tag/release.

## Notes / follow-ups

- Decisive evidence is the **artifact** (reviewer-specific deliverable), not
  `hasCommitsSinceStart` — the latter was intentionally **omitted** because
  reviewer lanes run in the *real repo* worktree (e.g. `symphony-daemon`), where
  commits-since-start can be polluted by sibling lanes; `end_commit` (the lane's
  own recorded commit) is used instead.
- Durable long-term fix remains the Work System / OpenClaw-native projection of
  per-lane review lifecycle (see `TODO(work-system)` in
  `agent-task-classification.ts`); this host-gated file probe is the interim
  bridge, consistent with predecessor `51068e7a`.
