# Command Central — Review-State Projection Hardening

**Task ID:** `cc-review-state-projection-hardening-20260616`
**Date:** 2026-06-16
**Host:** Mike MacBook Pro (hub)
**Branch:** `main` · base HEAD `584a3591`
**Repo:** `~/projects/command-central`

## Objective

Harden Command Central's Agent Status / review-state projection so a **reviewed**
pending-review receipt is reflected accurately even when the tasks.json task-row
projection is stale **or** auto-review dispatch failed but a manual review later
marked the source receipt reviewed.

## Symphony dogfood receipt scenario (the bug)

During Symphony dogfood, implementation task
`symphony-visible-claude-dispatch-20260616` finished and manual review
passed/committed (`4436555` in `symphony-daemon`), but Command Central / launcher
projection still showed the implementation as **pending/reviewing** because:

1. **Auto-review dispatch failed (`spawn_failed`)**, leaving the source
   pending-review JSON in `review_state:"reviewing"`.
2. **A separate manual review lane** later passed and marked the **source
   receipt** reviewed — the launcher's `pending_review_mark_reviewed`
   (ghostty-launcher `scripts/lib/pending-review.sh`) updates the active receipt
   in place to `review_state:"reviewed", reviewed:true` **and** snapshots a copy
   to `${PENDING_REVIEW_DIR}/reviewed/<task_id>.json`.
3. **The task-row projection** in `~/.config/ghostty-launcher/tasks.json` never
   refreshed — its `review_state` stayed `reviewing`/`pending`.

Main manually repaired the source receipt and task projection. This visibility
gap is the class of regression this change closes: **the pending-review receipt
is the review-lifecycle source of truth and must win over a stale task row.**

## Root cause in Command Central

Before this change, the Agent Status tree decided review state **only** from the
tasks.json task row:

- `isReviewLifecycleResolved(task)` (`src/utils/review-queue-health.ts`) read
  only the row's `review_status`/`review_state`. A stale `review_state:"reviewing"`
  → unresolved.
- The "reviewed" ✓ badge and Attention-bucket clearing read only the local
  `ReviewTracker` sidecar (`~/.config/command-central/reviewed-tasks.json`),
  which a **separate-machine / separate-lane** manual review never writes.
- `isReviewQueueReceiptMissing` flagged "review receipt missing" whenever the
  active receipt file was gone — even though the launcher archives a reviewed
  snapshot under `reviewed/`.

So a reviewed task whose row went stale rendered as pending/reviewing or
"review receipt missing", never reaching done/✓.

## The fix (data-source precedence: receipt truth > stale task row)

### `src/utils/pending-review-probe.ts`
- `PendingReviewReceipt` now carries `reviewState: string | null` and
  `reviewed: boolean`, parsed from the receipt JSON (`review_state`, `reviewed`).
- `isReceiptReviewed(receipt)` — **narrow** reviewed predicate: `reviewed === true`
  **or** `review_state === "reviewed"` (case/space-insensitive). `reviewing`,
  `awaiting_fixup`, `blocked`, `no_review_expected`, `pending` are **not**
  reviewed, so true in-flight/blocker states are preserved.
- `readReviewedReceipt(taskId, opts)` — reads the active receipt, then falls
  back to the `reviewed/` archive snapshot (`REVIEWED_ARCHIVE_SUBDIR`) when the
  active entry has been consumed/relocated.

### `src/providers/agent-status-tree-provider.ts`
- `isPendingReviewReceiptReviewed(task)` — receipt-reviewed truth for a task,
  gated on a declared `pending_review_path` (nothing to reconcile otherwise) and
  `isLocalFileProbeAuthoritative(task)` (a `/tmp/oste-pending-review` path is only
  meaningful on the host that ran the task).
- `isTaskReviewed(task)` — `ReviewTracker.isReviewed(task.id)` **OR** the receipt
  truth. Now drives both the ✓ badge / `.reviewed` contextValue and the
  Attention-bucket clearing for a completed task with a stale `review_status`.
- `isReviewQueueReceiptMissing(task)` — when the active receipt is missing, it now
  consults the reviewed archive before flagging a gap; a reviewed snapshot
  suppresses the false "review receipt missing" limbo routing.

Net effect: a completed task whose row says `review_state` pending/reviewing but
whose receipt (active **or** reviewed archive) says `review_state:"reviewed",
reviewed:true` renders **done + ✓**, not pending — while genuine
pending/reviewing/awaiting_fixup/blocked states and true review-queue gaps are
preserved.

## Files changed

| File | Change |
| --- | --- |
| `src/utils/pending-review-probe.ts` | Parse `review_state`/`reviewed`; add `isReceiptReviewed()`, `readReviewedReceipt()`, `REVIEWED_ARCHIVE_SUBDIR` |
| `src/providers/agent-status-tree-provider.ts` | Add `isPendingReviewReceiptReviewed()` + `isTaskReviewed()`; wire into Attention bucket, ✓ badge, and receipt-missing gate |
| `test/utils/pending-review-probe.test.ts` | Unit tests: parse review fields, `isReceiptReviewed`, `readReviewedReceipt` active/archive fallback |
| `test/tree-view/agent-status-review-state-projection.test.ts` | New: Symphony stale-projection regression suite |

## Tests

New regression suite `test/tree-view/agent-status-review-state-projection.test.ts`
covers the exact Symphony case and the preservation guards:

- stale `review_state:"reviewing"` + **active** receipt reviewed → done, ✓, no gap
- stale `review_state:"reviewing"` + active file gone + **reviewed archive** → done, ✓, no gap
- stale `review_status:"pending"` + reviewed receipt → done (Attention cleared)
- active receipt still `reviewing` → keeps `review_status:"pending"` in Attention, no ✓ (preserved)
- `awaiting_fixup` / `blocked` receipts never count as reviewed (preserved)
- `review_state:"reviewing"` + active gone + **no** archive → "review receipt missing" / limbo (true gap preserved)
- node-origin task does **not** trust a hub-local reviewed receipt (host gating)

Probe unit tests added for field parsing, `isReceiptReviewed` truth table, and
`readReviewedReceipt` active/archive/none resolution.

### Commands run

```
bun test test/utils/pending-review-probe.test.ts              # 11 pass
bun test test/tree-view/agent-status-review-state-projection.test.ts  # 7 pass
just check        # biome + tsc + knip — Checks complete (8 pre-existing warnings, 0 errors)
just test         # full suite — 2208 pass, 1 skip, 0 fail (154 files)
just test-validate # 100% partition coverage
```

## Constraints honored

- No live CC settings mutated; no publish, push, tag, or release.
- No `--no-verify`; hooks pass.
- Receipt truth is gated to local-host authoritative probes; cross-host receipts
  are never read as truth (consistent with the existing source-of-truth rules in
  `agent-task-classification.ts`).

## Follow-ups / notes

- The durable fix remains the Work System / OpenClaw-native projection of
  per-task review lifecycle (see `TODO(work-system)` in
  `agent-task-classification.ts`). This change hardens the file-receipt path
  until that projection lands; once lanes carry review lifecycle, the receipt
  probe becomes a fallback rather than the reconciliation gate.
- `isReceiptReviewed` is intentionally narrow (reviewed-only). If a future need
  arises to also resolve `no_review_expected` from the receipt, extend there
  rather than broadening the Attention/✓ semantics.
