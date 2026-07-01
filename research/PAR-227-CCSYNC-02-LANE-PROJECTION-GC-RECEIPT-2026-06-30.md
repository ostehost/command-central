# PAR-227 · [CCSYNC-02] Lane-projection rebuild/GC receipt — closeout

- **Issue:** https://linear.app/partnerai/issue/PAR-227/ccsync-02-add-a-lane-projection-rebuildgc-receipt-so-stale-command
- **Date:** 2026-06-30
- **State on entry:** Linear `Todo`; ledger `partial` (2026-06-23 verification verdict `todo` — now stale).
- **State on exit:** Command-Central code-side deliverable **complete + green**. Cross-repo producer
  wiring (automated invocation from ghostty-launcher) remains deferred — see "Deferred".

## What the issue asks (4 acceptance criteria)

1. A deterministic lane-projection rebuild/GC command (dry-run + apply) that reconciles
   `~/.config/openclaw/lanes.json` against registry rows + pending-review receipts + live
   tmux/process evidence.
2. Receipt-missing rows are downgraded to a stale / reconcile-needed state (not silently kept).
3. A timestamped receipt enumerating each row as kept / downgraded / archived / removed.
4. Command Central surfaces that receipt **for audit**.

## Where each AC is satisfied

| AC | Implementation |
| --- | --- |
| 1 | `scripts/oste-lanes-gc.sh` — dry-run by default, `--apply` backs up `lanes.json` to `.gc.bak` then rewrites atomically (tmp+mv). Per-row verdict via `classify_lane` using pending-review receipt presence + `tmux has-session`. Exit codes: dry-run 0/2, apply 0/1. |
| 2 | `downgraded` verdict (reason `review-pending-receipt-missing`) for review-pending rows lacking a receipt and a live pane. Consumed by the provider → routed to Needs Review (limbo), never the action badge. |
| 3 | Receipt `{version:1, kind:"lane-projection-gc-receipt", generated_at, mode, rows:{<id>:{verdict,reason}}}` written on every pass (dry-run and apply). Parsed fail-closed by `parseLaneProjectionGcReceipt` in `src/utils/review-queue-health.ts`. |
| 4 | Provider consumption: `readLaneProjectionGcReceipt` (`src/utils/pending-review-probe.ts`) → `reconcileLanesAgainstGcReceipt` stamps `gc_reconcile`/`gc_reconcile_reason` (`src/types/agent-task.ts`). Classification honors the verdict in `isStaleReviewProjection`/`isGcReconciledRow`. **This closeout adds the visible audit surface** (below). |

## This lane's change (AC4 gap fix)

Before this lane, the GC verdict was consumed **silently** — a reconciled row moved to limbo but
carried no visible evidence of *why*, so it could not be audited from the tree. Added a visible
audit surface in `createTaskItem`:

- **Row description badge:** `♻ reconcile-needed` / `♻ archived (GC)` / `♻ removed (GC)`.
- **Tooltip line:** `$(history) Lane GC: <verdict> — <reason> (reconciled by lane-projection GC receipt)`.
- **Label helper:** `gcReconcileVerdictLabel(verdict)` in `src/utils/review-queue-health.ts`
  (kept in the sibling module that owns the GC receipt types, not re-declared in the god provider).

### Files changed

- `src/utils/review-queue-health.ts` — `gcReconcileVerdictLabel` helper.
- `src/providers/agent-status-tree-provider.ts` — import + description badge + tooltip line in `createTaskItem`.
- `test/tree-view/agent-status-lane-gc-receipt.test.ts` — 3 audit-surface tests (downgraded/archived/removed surfaced; unreconciled row shows nothing).

## Verification

- `just check` — biome CI + tsc + knip: clean (knip hints are pre-existing config notes).
- `just test` — 2627 pass / 1 skip / 0 fail (+3 new tests).
- `shellcheck scripts/oste-lanes-gc.sh` — exit 0.

## Deferred (cross-repo, out of scope here)

The GC emitter and its Command Central consumption are complete. What remains is **producer-side
automation**: wiring `oste-lanes-gc.sh` into ghostty-launcher's lane lifecycle (e.g. a periodic or
reaper-triggered GC pass) so `lanes.json` is reconciled without a manual run. That lives in
`~/projects/ghostty-launcher` and is a separate lane. Today the command is operator-invokable and
the receipt is consumed the moment it appears on disk.
