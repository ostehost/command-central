# RESULT — cc-agent-status-remote-review-source-truth-20260612

**Status:** success
**Commit:** f5cb3729 `fix(agent-status): stop false 'review queue pending' on resolved/remote tasks`
**Branch:** main

## Problem

Agent Status showed completed launcher tasks (`cc-worksystem-projection-reader-20260611`,
`symphony-http-decision-endpoint-readmodel-20260612`) as `review queue pending` even after
their review state was set to `review_state: reviewed` / `review_status: approved` in the
launcher registry. Hub `/tmp` mirroring did not fix it.

## Root cause (verified against live data)

Both records in `~/.config/ghostty-launcher/tasks.json` carry:

- `status: "completed"`, `review_status: "approved"`, `review_state: "reviewed"`
- `pending_review_path: "/tmp/oste-pending-review/<task>.json"`
- `exec_mode: "hub"`, `exec_node: null`, `exec_host: "Mike’s MacBook Pro"`

The current machine's ComputerName **is** `Mike’s MacBook Pro`, so these rows classified as
*local* — the existing remote gate (`isRemoteNodeTaskForCurrentHost`) correctly did not fire.
The receipt files are absent from `/tmp/oste-pending-review/` because the review flow
**consumes the receipt on approval** (archived under `reviewed/`).

The actual defect: the `reviewQueuePending` condition (description chip at
`agent-status-tree-provider.ts` `createTaskItem`, the detail row, and the limbo status-group
routing) only excluded `review_status` `pending`/`changes_requested`. An **approved** task fell
through to the filesystem probe, found the consumed receipt "missing", and was flagged. So the
manager's two hypotheses combine: review metadata was never consulted as the authority, and —
as a second, real architectural gap — node-execution records without a verifiable `exec_host`
would have probed local `/tmp` too (the old gate degraded to "local" in that case).

## Fix — source-of-truth model

Two ordered gates now protect every receipt/handoff probe:

1. **Review metadata wins first.** New `isReviewLifecycleResolved()` in
   `src/utils/review-queue-health.ts`: `review_status === "approved"` or
   `review_state ∈ {reviewed, no_review_expected}` (launcher vocabulary confirmed from
   `oste-complete.sh` / `oste-review-watchdog-runner.sh`) means the receipt was legitimately
   consumed — its absence is the expected steady state, never a queue gap.
2. **Local probes only for local tasks.** New `isLocalFileProbeAuthoritative()` in
   `src/providers/agent-task-classification.ts`: tasks with node-execution metadata
   (`exec_node`/`exec_host` set, or `exec_mode ∈ {spoke, node, remote}`) must have an
   `exec_host` matching the current machine (normalized: case, `.local` suffix, whitespace)
   before any local file probe counts. Node metadata **without** a verifiable host now fails
   closed (probe state `unknown`, never `missing`). This deliberately differs from
   `isRemoteNodeTaskForCurrentHost`, which degrades to "local" so users aren't shown
   unfollowable remote action menus — the right fail direction for menus is the wrong one for
   evidence. No host names are hardcoded; comparison is against `scutil --get ComputerName`
   (mirroring what the launcher writes) with the existing test seam.

Both the pending-review probe (`getPendingReviewQueueState`) and the handoff probe
(`getDeclaredHandoffState`) now use the probe-authority gate. A single shared helper
`isReviewQueueReceiptMissing()` applies gate 1 + 2 at all three former call sites
(description chip, detail row, limbo routing), so they can no longer drift.

**Local behavior is preserved:** a completed local-origin task with an advertised
`pending_review_path`, unresolved review metadata, and no receipt on disk still routes to
limbo and shows `review queue pending` (existing regression tests untouched and passing).

## Files changed

- `src/utils/review-queue-health.ts` — `isReviewLifecycleResolved()` + source-of-truth doc
- `src/providers/agent-task-classification.ts` — `isLocalFileProbeAuthoritative()` + TODO(work-system) design note
- `src/providers/agent-status-tree-provider.ts` — probe gates, shared `isReviewQueueReceiptMissing()`, 3 call sites
- `test/utils/review-queue-health.test.ts` — lifecycle-resolution unit tests
- `test/tree-view/agent-status-task-classification.test.ts` — probe-authority unit tests (incl. fail-closed vs degrade-to-local contrast)
- `test/tree-view/agent-status-review-queue-gap.test.ts` — screenshot reproduction: approved+reviewed task with consumed receipt → `done`, no chip, no detail row; remote node-origin task with `/tmp` path → no local gap; node metadata without host → fails closed
- `.claude/skills/command-central-vscode-extension/references/agent-status-sources.md` — "Source-of-Truth Rule" section

## Verification

| Gate | Result |
| --- | --- |
| `bun test` (focused: review-queue-health, review-queue-gap, task-classification) | 40 pass / 0 fail, exit 0 |
| `just test-unit` | 622 pass / 0 fail, exit 0 |
| `just ready` (biome fix + biome ci + tsc + knip + full suite) | 2035 pass / 1 skip / 0 fail, exit 0 |

## Longer-term note

The durable fix for hub/node drift is a hub-readable Work System / OpenClaw-native projection
carrying per-task review lifecycle, instead of raw per-machine launcher files. Recorded as
`TODO(work-system)` on `isLocalFileProbeAuthoritative()` and in the skill reference doc. Once
lanes carry review state in the projection, the host check becomes a fallback rather than the
gate.
