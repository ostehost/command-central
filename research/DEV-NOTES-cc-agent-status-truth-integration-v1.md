# DEV-NOTES: Agent Status Truth Wave — Integration (v1)

**Date:** 2026-04-10
**Task:** cc-agent-status-truth-integration-v1
**Lane:** integration (reviewer-authored notes)
**Branch:** `integration/agent-status-truth-wave-v1`
**Spec:** `research/SPEC-agent-status-truth-ux-v1.md` (advisory, pre-Slice-3)
**Reviewer memo:** `research/REVIEW-agent-status-truth-wave-v1.md` (sibling worktree)
**Slice notes:**
`research/DEV-NOTES-cc-agent-status-slice1-v1.md`,
`research/DEV-NOTES-cc-agent-status-slice2-v1.md`,
`research/DEV-NOTES-cc-agent-status-slice3-v1.md`,
`research/DEV-NOTES-cc-agent-status-slice4-v1.md`.

## 1. Summary

- Reconciled four parallel slice lanes (1 = limbo tier, 2 = dead-process-running
  detection, 3 = badge-truth routing, 4 = handoff-file detection) into a single
  integration branch cut from `main` (`70b3cc5`).
- Picked **Slice 4-B** (`handoff-file-health.ts`, enum contract, fail-open) and
  dropped **Slice 4-A** (`handoff-file-check.ts`, boolean contract,
  fail-closed). See §3.
- Added a joint regression test proving the final routing precedence where
  `review_status` and a missing declared handoff file can collide on the same
  completed task. See §5.
- Only real merge collision was a `tsc --noEmit` `noUnusedLocals` failure in
  `test/tree-view/agent-status-dead-process-running.test.ts`; fix was two
  deleted imports (commit `fd91eb2`). See §4.
- Wrote these dev notes and the completion report. Source and test files were
  not modified during the integration lane itself beyond the collision fix.

## 2. Merge order and why

The reviewer memo (`REVIEW-agent-status-truth-wave-v1.md` §3) recommended:

```
main (70b3cc5)
 └─ Slice 1  (tip: 3b011af)   limbo tier + provider routing foundation
     └─ Slice 2  (tip: 8c7d4d7)   dead-process-running detection
         └─ Slice 3  (tip: b9783ae)   badge-truth routing in agent-counts.ts
             └─ Slice 4-B (tip: 43522c1)   handoff-file health + provider wiring
```

This is the order this integration lane followed. Rationale (paraphrasing the
reviewer memo §3 and verified by reading the topology):

1. **Slice 1 first.** Foundation tier. Introduces the `limbo` bucket in
   `AgentStatusGroup`, sorts it into `TASK_STATUS_PRIORITY`, routes
   `completed_dirty` / `completed_stale` there, and seeds the display-vs-badge
   split that Slice 3 later closes. Zero conflicts with anything downstream
   because Slice 2, 3, and 4 all branch from its tip.
2. **Slice 2 second.** Lands `src/utils/tmux-pane-health.ts` and the
   provider-level `_tmuxPaneAgentCache` (5 s TTL). Slice 4-B mirrors this cache
   shape in `_handoffFileCache`, so landing Slice 2 first makes the Slice 4-B
   diff smaller.
3. **Slice 3 third.** Edits only `src/utils/agent-counts.ts` (plus the Slice 1
   tripwire tests it deliberately reverses). Zero file-level overlap with
   Slice 2 or Slice 4. Could have shipped fourth; going third keeps the Slice 1
   tripwire-test rewrite in the same audit window as the Slice 1 code it
   modifies.
4. **Slice 4-B fourth.** Provider edits layer cleanly on Slice 2 because
   `getDeclaredHandoffState` slots into `getNodeStatusGroup` alongside (and
   after) the `review_status` arm from Slice 1, and the helper lives in its
   own file. The Slice 4-A parallel branch is not merged — its files do not
   appear in the working tree at any point.

**Topology reminder** (verified against `git merge-base`):

- Slice 2 base = Slice 3 base = **`3b011af`** (Slice 1 tip). **Siblings.**
- Slice 4-A base = Slice 4-B base = **`8c7d4d7`** (Slice 2 tip). **Siblings of
  each other.** Neither sees Slice 3's `agent-counts.ts` edits at its base.

The wave was four sibling branches, not a chain. Any merge order had to pick
one of Slice 4-A / Slice 4-B and reconcile Slice 2 ↔ Slice 3 explicitly.
Because Slice 3 touches only `agent-counts.ts` and Slice 2 touches only the
provider + a new helper, that reconciliation was a no-op at the file level —
but it is asserted for the first time by the joint regression test in §5.

## 3. Why Slice 4-B won over Slice 4-A

The reviewer memo (§2.4.1, **BLOCKER-4.1**) recommended Branch B on
substantive grounds; this integration lane followed that recommendation
verbatim. The five reasons, closely paraphrased:

1. **Explicit `"unknown"` enum state.** Slice 4-B's
   `checkDeclaredHandoff` returns
   `"absent" | "present" | "missing" | "unknown"`. A boolean
   `isDeclaredHandoffFileMissing` (Slice 4-A) collapses "proven absent" and
   "can't tell" into the same answer. In a truth wave that is exactly the
   distinction worth preserving.
2. **Fail-open by design.** Slice 4-B only returns `"missing"` on a
   confirmed `ENOENT` or a directory at the expected path. `EACCES`, `ELOOP`,
   broken symlinks, non-ENOENT stat errors, and resolution throws all fall
   through to `"unknown"` → stays in `done`. Slice 4-A's fail-closed direction
   would have falsely demoted tasks whose handoff file lives on a
   read-restricted mount or behind a transient permission error.
3. **Path-traversal guard.** Slice 4-B explicitly rejects relative paths
   whose resolved form escapes `project_dir` via
   `rel.startsWith("..") || path.isAbsolute(rel)` → `"unknown"`. Handoff file
   names come from `.oste-report.yaml`, which is user-authored, so a path
   that escapes the project tree should not silently be read. Slice 4-A had
   no visible guard.
4. **Richer description chip with suppression.** Slice 4-B shows the
   relative path (`missing handoff: research/FOO.md`) and suppresses the chip
   when `review_status` is `"pending"` or `"changes_requested"`, so a
   task that will already render a review-attention signal does not
   double-label itself. Slice 4-A's chip was a bare `"missing handoff"`.
5. **Broader test coverage.** Slice 4-B ships 12 unit cases in
   `test/utils/handoff-file-health.test.ts` (nullish / empty / whitespace,
   relative present/missing/nested, absolute present, directory, traversal,
   non-ENOENT error, vanishing file) plus 8 tree-provider integration tests
   in `test/tree-view/agent-status-handoff-file.test.ts`. Slice 4-A's
   coverage was smaller and would have been a regression risk without a
   full case-by-case audit.

### Slice 4-A artifacts that are NOT on this branch

Explicitly verified absent on `integration/agent-status-truth-wave-v1` via
`Glob`, `Grep`, and direct `ls`:

| Artifact | Expected path | Verified |
|---|---|---|
| Helper file | `src/utils/handoff-file-check.ts` | ABSENT |
| Unit test | `test/utils/handoff-file-check.test.ts` | ABSENT |
| Provider cache field | `_handoffMissingCache` | `grep` returns no matches in `src/` |
| Helper API identifier | `isDeclaredHandoffFileMissing` | `grep` returns no matches anywhere |

If any of these ever reappear on this branch in a follow-up commit, the merge
has been contaminated and should be re-baselined.

## 4. Collisions actually encountered

**File-level conflicts: zero.** The four slices partition the touched files
cleanly:

| Slice | Owns (new / edited) |
|---|---|
| 1 | `AgentStatusGroup` enum + `TASK_STATUS_PRIORITY` + `getNodeStatusGroup` skeleton + `countAgentStatuses` skeleton + limbo-tier tests |
| 2 | `src/utils/tmux-pane-health.ts` (new), `_tmuxPaneAgentCache`, `isTmuxPaneAgentHealthy`, dead-process-running test suite |
| 3 | `src/utils/agent-counts.ts` `completed` arm + tripwire-test reversal |
| 4-B | `src/utils/handoff-file-health.ts` (new), `_handoffFileCache`, `getDeclaredHandoffState`, `getNodeStatusGroup` completed-arm extension, description-chip suppression, two new test files |

No function is rewritten by more than one slice. Slice 3's `case "completed":`
edit in `countAgentStatuses` and Slice 4-B's `case "completed":` edit in
`getNodeStatusGroup` modify different files.

**One real collision did surface** — from the TypeScript compiler, not from
git. After all four slices were laid down, `tsc --noEmit` failed with two
`noUnusedLocals` errors in
`test/tree-view/agent-status-dead-process-running.test.ts`:

- an unused `AgentNode` type import, and
- an unused `_realReadRegistry` capture.

Both were leftovers from the Slice 2 authoring path that only became
unreferenced after the integration rebase exposed them. Resolved by the
one-commit fix `fd91eb2` (`fix: reconcile integration collision — drop
unused test imports`), two deletions, no behavior change.

No other collisions. The git history is linear on top of `70b3cc5`.

## 5. Joint regression test added

The reviewer memo called this gap out twice (§2.4.2 **WARN-4.2** and §4 item
1): before integration, no test asserted the behavior of a task with *both*
a `review_status` signal and a declared-but-missing handoff file on the
same row.

**New file:** `test/tree-view/agent-status-review-and-handoff.test.ts` —
provider-level integration tests following the Slice 2 / Slice 4 harness
shape (`mock.module("vscode", ...)`, real tmp dir per test,
`realFs` preload cache). The describe block
`"review_status × missing-handoff routing precedence"` contains:

| Test | Asserts |
|---|---|
| `completed + review_status=pending + missing handoff → attention (review wins, badge agrees)` | Tree routes to `attention`, `countAgentStatuses` bumps `attention`, not `limbo`, not `done`. Proves review_status has precedence over handoff at both the tree and the badge layer. |
| `completed + review_status=changes_requested + missing handoff → attention (review wins)` | Same precedence, different review_status value. |
| `completed + review_status=approved + missing handoff → limbo (handoff precedence)` | With review clean, the handoff-missing signal acts as a fallback and demotes `done` → `limbo`. This is the `WARN-4.2` ordering the reviewer asked us to nail down. |
| `completed + review_status=approved + handoff present → done` | Negative control — neither signal fires, task stays in `done`. |

**Also extended** — `test/utils/agent-counts.test.ts` picked up three joint
cases in the `countAgentStatuses — review_status routing` block (lines
134 / 148 / 162):

- `completed + review_status=pending + handoff_file declared → attention`
- `completed + review_status=changes_requested + handoff_file declared → attention`
- `completed + review_status=approved + handoff_file declared → done (badge is fs-blind)`

The third is important: it pins the intentional asymmetry where the badge
count layer (`countAgentStatuses`) does **not** do filesystem I/O and
therefore does not see `"missing"` handoff state. Badge counts reflect
orchestration metadata; tree grouping reflects actionability. This matches
the slice 4 dev notes' "what was not changed" section.

Commit: `d158b3c test: add joint regression for review+handoff routing
precedence` (Task #2).

## 6. Routing precedence (final, post-integration)

Verified against the actual code at
`src/providers/agent-status-tree-provider.ts:2923-2946`
(method `getNodeStatusGroup`). The final `case "completed":` arm is:

```ts
private getNodeStatusGroup(node: SortableAgentNode): AgentStatusGroup {
    const status = this.getNodeStatus(node);
    if (status === "running") return "running";
    if (status === "completed") {
        if (
            node.type === "task" &&
            (node.task.review_status === "pending" ||
                node.task.review_status === "changes_requested")
        ) {
            return "attention";
        }
        if (
            node.type === "task" &&
            this.getDeclaredHandoffState(node.task) === "missing"
        ) {
            return "limbo";
        }
        return "done";
    }
    if (status === "completed_dirty" || status === "completed_stale") {
        return "limbo";
    }
    return "attention";
}
```

### The precedence chain

The `AgentTaskStatus` value that reaches `getNodeStatusGroup` is already the
**overlaid** status — `toDisplayTask` (line 1342) consults
`isRunningTaskHealthy` (line 1300) and rewrites a dead-running task into
`completed`, `completed_dirty`, `failed`, or `stopped` before the grouping
step sees it. So the effective priority chain, written end-to-end across the
overlay and the grouping step, is:

1. **`status === "running"` after the overlay (process is healthy)** →
   `running`. "Healthy" for tmux-backed tasks means: window alive **and**
   `isTmuxPaneAgentHealthy` returns true. A live tmux window whose pane runs
   an allowlisted agent binary (`claude` / `codex` / `cursor-agent` / `aider`
   / `ollama`) or one of their descendants qualifies. (Slice 2.)
2. **`status === "running"` but the pane's agent process is dead**
   (Slice 2) → overlay resolves the status to `completed` /
   `completed_dirty` / `failed` / `stopped` based on exit-code, completion
   timestamp, and git-commits-since-start evidence (lines 1357–1391). Those
   statuses then fall through to the rules below.
3. **`status === "completed"` and `review_status` is `"pending"` or
   `"changes_requested"`** (Slice 1 display routing + Slice 3 badge routing)
   → `attention`. Review wins. This is the first branch inside the
   `completed` arm.
4. **`status === "completed"` and `getDeclaredHandoffState(task) ===
   "missing"`** (Slice 4-B) → `limbo`. Only a confirmed `ENOENT` or a
   directory-at-expected-path triggers this; `"absent"` (no declaration),
   `"present"`, and `"unknown"` (any stat error, traversal, etc.) all fall
   through.
5. **`status === "completed"` otherwise** → `done`.
6. **`status === "completed_dirty"` or `status === "completed_stale"`**
   (Slice 1) → `limbo`. Independent of handoff state — these rows already
   have their own "limbo" justification and are not double-labeled.
7. **Everything else** (`failed`, `stopped`, `killed`, `contract_failure`)
   → `attention`.

**Not a branch of `getNodeStatusGroup`** but worth noting: there is no
`pending` or `in_progress` value in `AgentTaskStatus`. The "before it starts"
case is covered by the overlay + these seven rules alone.

### The badge layer

`countAgentStatuses` (`src/utils/agent-counts.ts`) runs on the same overlaid
tasks and applies a narrower version of the same chain, minus the filesystem
call. Its `case "completed":` arm only routes by `review_status`; a
`completed` task with a clean review lands in the `done` bucket regardless
of handoff state. This deliberate asymmetry is documented in the slice 4
dev notes under "what was not changed" and pinned by the joint
`agent-counts.test.ts` case at line 162.

## 7. Known limitations still open

These are all flagged by the reviewer memo and deferred out of scope for
this integration lane. None is a merge blocker; each should become a
follow-up task rather than silently accumulate.

1. **`pgrep` catch-all hides systemic failure (WARN-2.1).** In
   `isTmuxPaneAgentAlive`, `pgrep -P <pid>` exits non-zero for both "no
   children" and "system error", and the catch block treats both as
   `continue`. If every pane's `pgrep` errors (hypothetical system fault),
   the descendant list is empty and the function returns `false` — not
   fail-open. Acceptable on macOS today; needs a comment in the helper and a
   unit test before we trust it under load.
2. **Hardcoded 500 ms `tmux` timeout (WARN-2.2).** Top of
   `src/utils/tmux-pane-health.ts`. Not tunable, not read from settings,
   fails open silently on throw. Consider a debug-log on timeout so slow
   laptops are diagnosable.
3. **Platform guard missing on Slice 2 helper (WARN-2.3).** `pgrep -P`
   exists on macOS and Linux, not Windows. On Windows every `pgrep`
   throws, hitting WARN-2.1's non-fail-open branch. We do not ship Windows
   today, but a one-line `process.platform` guard that fails open on
   non-POSIX is cheap insurance.
4. **SPEC doc is pre-Slice-3 (NIT-3.1).**
   `SPEC-agent-status-truth-ux-v1.md` still describes the display-vs-badge
   split as intentional. Slice 3 closed that split. The spec is not wrong —
   just stale. One-line amendment or an addendum note (similar to
   `research/NOTE-whats-new-version-policy-*`) suffices.
5. **No runtime cost measurement (reviewer §4 item 3).** Slices 2 and 4
   both added cached blocking I/O to hot display paths. Estimated worst
   case on a 50-task tree with a cold cache is ~300 ms per refresh
   (`50 × (5 ms tmux + 1 ms statSync)`); cache TTL is 5 s. Tolerable but
   unverified. Want a one-off timing run in a dogfood session and a
   sentence in the next retro.
6. **`AGENT_PROCESS_NAMES` not exported (reviewer §4 item 6).** Private
   const in `tmux-pane-health.ts`. Anyone adding a new agent binary
   (Gemini CLI, etc.) has to file-grep. One sentence in the Slice 2 dev
   notes pointing at the location closes this.
7. **`_handoffFileCache` not reconciled on registry reload (Slice 4 dev
   notes, limitation 2).** Other caches
   (`_tmuxSessionHealthCache`, `_tmuxPaneAgentCache`) are cleared in
   `reconcileDuplicateRunningSessions`; the handoff cache is not. The 5 s
   TTL bounds staleness, but a follow-up registry-reload integration would
   be cleaner.
8. **Pre-existing test-suite gaps.** Three tests fail in
   `test/tree-view/agent-status-tree-provider.test.ts` at HEAD `fd91eb2`:
   1. `AgentStatusTreeProvider > runtime health overlay for running status
      > overlays stuck dead running tmux task as completed_stale for UI
      status/counts`
   2. `AgentStatusTreeProvider > visibility contract + launcher icon
      integration > screenshot fixture: stale running task is excluded
      from working count + dock badge`
   3. `AgentStatusTreeProvider > visibility contract + launcher icon
      integration > reload re-merges discovery against latest launcher
      state (restart/reconnect)`

   **Root cause** (implementer diagnostic): stale label-format assertions.
   The tests expect `"1 working"` / `"1 ✓"`; the current formatter emits
   `"2 agents · 1 working"` / `"2 agents · 1 ✓"`. The summary-label
   formatter was updated in a prior change and these specific tests were
   never refreshed.

   **Provenance:** none of the 13 slice commits touch this test file.
   The last commit to it (`0f10264 test: avoid discovered prompt disk
   scan in session-node assertion`) is an ancestor of `main`, verified
   via `git merge-base --is-ancestor`. **These failures are pre-existing
   on main and carried through the integration unchanged.** They are
   explicitly out of scope for this integration lane and are called
   out here only so the next reviewer doesn't chase them.

   Totals in that file at HEAD `fd91eb2`: **3 fail / 211 pass / 214
   total**. All 75 scoped tests from the Task #1 acceptance run plus
   the 21 joint tests from Task #2 are passing. A follow-up task should
   refresh the three stale label assertions to match the current
   summary-label format.

## 8. Merge-readiness checklist

- [x] Working tree clean (`git status --porcelain` empty at commit time).
- [x] Branch `integration/agent-status-truth-wave-v1` linear on top of
      `main@70b3cc5`; no merge commits, no rebases after integration.
- [x] TypeScript typecheck passes (`bunx tsc --noEmit`); Slice 2 test-import
      collision resolved by commit `fd91eb2`.
- [x] Scoped test suites pass: `test/utils/agent-counts.test.ts`,
      `test/utils/handoff-file-health.test.ts`,
      `test/utils/tmux-pane-health.test.ts`,
      `test/tree-view/agent-status-limbo-tier.test.ts`,
      `test/tree-view/agent-status-dead-process-running.test.ts`,
      `test/tree-view/agent-status-handoff-file.test.ts`,
      `test/tree-view/agent-status-review-and-handoff.test.ts`,
      `test/services/agent-status-bar-count.test.ts`.
- [x] Slice 4-A artifacts absent
      (`handoff-file-check.ts`, `handoff-file-check.test.ts`,
      `_handoffMissingCache`, `isDeclaredHandoffFileMissing`).
- [x] Joint regression test present:
      `test/tree-view/agent-status-review-and-handoff.test.ts` +
      three joint cases in `test/utils/agent-counts.test.ts`.
- [x] Per-slice dev notes present on branch:
      `DEV-NOTES-cc-agent-status-slice1-v1.md` through
      `DEV-NOTES-cc-agent-status-slice4-v1.md`.
- [x] This dev notes file written.
- [x] `.oste-report.yaml` updated to `task_id:
      cc-agent-status-truth-integration-v1`.
- [x] Pre-existing `agent-status-tree-provider.test.ts` failures confirmed
      as *not* introduced by this integration — stale label assertions,
      pre-existing on `main`, provenance verified via
      `git merge-base --is-ancestor`; documented in §7 item 8.

---

*Reviewer: Claude Opus 4.6 (reviewer lane), 2026-04-10.*
*Branch `integration/agent-status-truth-wave-v1` HEAD at write time:
 `d158b3c` (task #2 joint regression).*
