# FIXUP RECEIPT — rc50-prep review provenance correction (2026-06-10)

Task: `command-central-rc50-fixup-fable-20260610` · Model: Fable 5 · Node: Mike MacBook Pro · Repo: `~/projects/command-central`

Resolves the single BLOCKER from the completion-note review of
`command-central-rc50-prep-review-20260610` (review handoff:
`/tmp/command-central-command-central-rc50-prep-review-20260610-review/research/REVIEW-command-central-rc50-prep-review-20260610.md`,
pending-review state `awaiting_fixup`).

## Root cause: mis-attributed commit, not a false summary and not a product bug

- The rc50-prep review lane (`command-central-rc50-prep-review-20260610`) ran in
  **test mode: read-only, zero commits**. Its completion summary truthfully said
  "nothing was mutated this lane" and that it intentionally wrote no `research/`
  receipt (test-mode contract requires a clean tree; the in-chat response was the
  receipt).
- The launcher's pending-review receipt recorded `last_commit` / `end_commit` /
  `agent_commit` = `cfd8c67d` — the **pre-existing HEAD at lane completion**, not a
  commit the lane made. There is no baseline/start-commit field, so a zero-commit
  lane is indistinguishable from a lane that authored HEAD.
- The completion-note reviewer was therefore handed the range
  `cfd8c67d^..cfd8c67d` and correctly observed that this commit mutates
  `research/` and carries a receipt for a *different* task. The review process
  worked; the input attribution was wrong.

## Corrected provenance (authoritative)

| Lane / task | Commits | Receipt / evidence | Review state |
|---|---|---|---|
| `command-central-rc-deps-stability-20260610` | `997c3d71`, `1665defe`, `cfd8c67d` (receipt) | `research/REVIEW-rc-deps-stability-20260610.md` + `research/prerelease-gate/prerelease-gate-2026-06-10T06-54-03.143Z.json` (cc `1665defe` × launcher `f4e5e493`, success) | **Clean** |
| `command-central-rc50-prep-review-20260610` | **None** — empty range; baseline = end = `cfd8c67d` | In-chat verdict only ("cut rc50 now"); no committed receipt by design (test mode) | Blocked solely on the mis-attributed commit — resolved by this note |
| rc50 cut (concurrent, see timeline) | `07fe65fb` chore(release): cut rc50 preview | `releases/digest-v0.6.0-rc.50.md`, `research/prerelease-gate/prerelease-gate-2026-06-10T08-23-47.816Z.json` (cc `cfd8c67d` × launcher `8f05d772`, success), preview-status lifecycle record | Cut succeeded, exit 0 |
| `command-central-rc50-fixup-fable-20260610` (this lane) | The docs commit carrying this file | This file | — |

The three files in `cfd8c67d` (`research/REVIEW-rc-deps-stability-20260610.md`,
`research/prerelease-gate/latest.json`,
`research/prerelease-gate/prerelease-gate-2026-06-10T06-54-03.143Z.json`) belong to
the rc-deps lane's mutation scope and are fully accounted for by that lane's clean
review. The rc50-prep lane's claims are accurate **for its own (empty) range**.

All three reviewer WARNINGs collapse into the same root cause: task identity
mismatch, docs-commit-vs-described-code-changes, and partially-committed gate
evidence are all properties of the **rc-deps lane's receipt commit** being reviewed
under the **rc50-prep lane's identity**. Under the corrected attribution, each is
already resolved by the rc-deps receipt and its clean review.

## Timeline (2026-06-10 UTC), including the concurrent rc50 cut

| Time | Event |
|---|---|
| 06:54 | rc-deps lane prerelease-gate green (cc `1665defe` × launcher `f4e5e493`) |
| ~06:55 | rc-deps lane commits receipt `cfd8c67d`; HEAD ahead 7, clean |
| 07:07 | rc50-prep review lane completes read-only, verdict "cut rc50 now" |
| 07:26–07:28 | Completion-note review runs against `cfd8c67d^..cfd8c67d` → 1 BLOCKER, state `awaiting_fixup` |
| ~08:22 | This fixup lane starts at HEAD `cfd8c67d`, clean tree |
| 08:22:57–08:23:55 | **Concurrent** `just cut-preview --prerelease` (separate actor) builds rc50; lifecycle record: state `succeeded`, version `0.6.0-rc.50`, artifact `releases/command-central-0.6.0-rc.50.vsix`, sha256 `32a10475c9317842d146819999f26f5dd0431b70cc48435552f692ca3eb1ce0f`, exit 0 — `--auto-artifact` (from `1665defe`) proven in production: no more `version: (none)` records |
| 08:25 | Cut commits `07fe65fb` (version bump, digest, gate JSONs, consumption JSON, 2 launcher helpers re-synced from launcher `8f05d772`); tree clean again, ahead 8 |
| after | This lane commits the fixup receipt on top |

Mid-lane the tree was transiently dirty with the in-flight cut's files
(`package.json`, gate JSONs, two `resources/bin/scripts/lib/` helpers, digest).
None of those changes were touched, staged, or committed by this lane; the cut
committed them itself as `07fe65fb`.

## This fixup's facts

- Start HEAD: `cfd8c67d` (clean)
- End HEAD: the single docs commit carrying this receipt, parent `07fe65fb` (the
  concurrent cut commit; not authored by this lane)
- Files changed by this lane: `research/REVIEW-rc50-fixup-fable-20260610.md` (added
  — this file). No product code touched; no product bug found in Command Central.
- Gates run this lane: `just check` (biome ci + tsc + knip) and `just test` (full
  suite) at post-cut HEAD — results in the commit message / `.oste-report.yaml`.
  Docs-only change; the heavy release gates already ran green inside the cut at
  08:23 (`research/prerelease-gate/prerelease-gate-2026-06-10T08-23-47.816Z.json`).
- External mutations: **none** — no cut, no push, no tag, no publish, no
  `--no-verify`, no edits to ghostty-launcher or the pending-review JSON.

## Pending review disposition

`/tmp/oste-pending-review/command-central-rc50-prep-review-20260610.json`
**should move out of `awaiting_fixup`** once this receipt is committed:

- The lone BLOCKER is an attribution defect, now corrected by a committed
  provenance record (this file). The rc50-prep summary was truthful for its actual
  (empty) mutation range.
- If the harness re-reviews, it should review the rc50-prep summary against an
  **empty range at baseline `cfd8c67d`** (or against this receipt), not against
  `cfd8c67d^..cfd8c67d`.
- Releasing the hold is launcher-/manager-owned; this lane deliberately did not
  edit the pending-review JSON (no self-certification).

## Remaining approvals / follow-ups

1. **Cut approval — moot**: rc50 was cut at 08:23 UTC by a concurrent approved lane
   (`07fe65fb`); nothing left to approve there.
2. **Push approval — still open and grown**: `main...origin/main` will be ahead 9
   after this commit. Hub/node sync debt keeps accumulating; approve a push/sync
   lane.
3. **Post-cut proofs** (carried from the rc-deps receipt): installed rc50 VSIX +
   reload proof of the Fable patch, and one manual ACP lane execution-test of the
   trailing `--model 'fable'` flag. `research/vscode-consumption-rc50-20260610.json`
   landed in the cut commit; verify whether it covers the installed proof before
   re-running.
4. **Launcher hardening (non-blocking, prevents recurrence)**: the pending-review
   recorder should capture a baseline/start commit per lane and mark zero-commit
   lanes explicitly, instead of attributing the pre-existing HEAD as
   `agent_commit`/`end_commit`. Until then, every read-only lane reviewed in
   `canonical-committed` mode will reproduce this class of false blocker. Belongs
   in `~/projects/ghostty-launcher` backlog; not changed from this lane by scope
   constraint.
