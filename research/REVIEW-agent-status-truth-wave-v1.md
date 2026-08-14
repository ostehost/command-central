---
title: REVIEW — Agent Status Truth Wave v1
date: 2026-04-10
lane: reviewer
scope: Slices 1–3 (material complete), Slice 4 (contract + collision only)
spec: research/SPEC-agent-status-truth-ux-v1.md
retro: research/RETRO-agent-status-truth-wave-v1.md
---

# REVIEW — Agent Status Truth Wave v1

## 0. Context and reading caveat

This is a reviewer-lane memo. No product code was changed.

**Critical framing.** HEAD of this worktree is `70b3cc5` (main, "docs: rationale
for WHATS_NEW_VERSION pin"). None of the slice commits are on the checked-out
branch — they are unmerged, reachable only via `git log --all`. Every code
reference below was read via `git show <sha>:<path>`, not from the working
tree. File paths are given for navigation once merged.

## 1. Slice topology (what you're actually merging)

```
                              64de485  SPEC v1 (5-tier advisory)
                                 │
                              88e1e02 ─ 29e077a ─ c06d863 ─ 83db428 ─ ade46bd ─ 3b011af  ◄── Slice 1 tip
                                 │                                              │
                    ┌────────────┼────────────┬──────────────────┐
                    │            │            │                  │
               0d932a8       1a666cd      fbceb20            (detached)
               1d5a6bc       41f7890      59e8095
               245279c       d3e4ea1    (wave retro)
               b9783ae       d0b9912
                │             bc26d5b
          Slice 3 tip         cfa0f0b
                              8c7d4d7  ◄── Slice 2 tip
                                 │
                       ┌─────────┴─────────┐
                       │                   │
                   a9e94d3             b4be359
                   48f91a2             4842a9c
                                       e22c579
                  Slice 4-A tip      Slice 4-B tip
                  (check, boolean)   (health, enum)
```

**Merge bases** (verified via `git merge-base`):
- Slice 2 base = Slice 3 base = `3b011af` (Slice 1 tip). **They are siblings.**
- Slice 4-A base = Slice 4-B base = `8c7d4d7` (Slice 2 tip). **They are siblings of each other.**
- Neither Slice 4 branch sees Slice 3's `agent-counts.ts` edits.

This topology is the headline finding: the wave is four siblings, not a chain.
Any merge order must actively reconcile Slice 2 ↔ Slice 3, and must pick one
of Slice 4-A / Slice 4-B before it can land at all.

---

## 2. Per-slice findings

### Slice 1 — limbo tier  *(material complete)*

Commits: `88e1e02`, `29e077a`, `c06d863`, `83db428`, `ade46bd`, `3b011af`.
Files: `src/utils/agent-counts.ts`, `src/providers/agent-status-tree-provider.ts`,
`test/tree-view/agent-status-limbo-tier.test.ts`, `test/utils/agent-counts.test.ts`,
`test/services/agent-status-bar-count.test.ts`, `research/DEV-NOTES-cc-agent-status-slice1-v1.md`.

**Spec alignment.** Spec defines a 5-tier model; Slice 1 lands 3 of the tiers
that matter today (`running` / `attention` / `limbo` / `done`) and defers
`historical`. `completed_dirty` and `completed_stale` both route to `limbo`
exactly as prescribed. ✓

**Code correctness.** `countAgentStatuses` is a tight switch with no dead
branches; the 8 known `AgentTaskStatus` values each route to exactly one
bucket. `TASK_STATUS_PRIORITY` is `{running: 0, attention: 1, limbo: 2,
done: 3}` — correct for display order. `formatCountSummary` hides the limbo
segment when zero. No overlap, no drift.

**Test coverage.** Positive and negative cases for each terminal status,
multi-status mix, ordering assertions, zero-suppression, and an explicit
`AgentStatusGroup` type tripwire. The slice also ships a **display-vs-badge
tripwire** in `test/tree-view/agent-status-limbo-tier.test.ts` at the block
starting line 132 — four tests that assert the badge count must **not** see
`review_status`. That tripwire is important for Slice 3 (see below).

**Nits.**

- **NIT** — `getNodeStatusGroup` at commit `c06d863` routes `review_status` in
  the display layer but `countAgentStatuses` intentionally does not. This is
  documented in `DEV-NOTES-slice1`, but the split is non-obvious. A comment
  in `agent-counts.ts` at the `case "completed":` line saying "display layer
  handles review_status separately" would have made Slice 3's reversal
  cheaper to review. Low priority — Slice 3 fixed the divergence.

**Verdict:** ship-ready. Merge first.

---

### Slice 2 — dead-process-running detection  *(material complete)*

Commits: `1a666cd`, `41f7890`, `d3e4ea1`, `d0b9912`, `bc26d5b`, `cfa0f0b`, `8c7d4d7`.
Files: `src/utils/tmux-pane-health.ts`,
`src/providers/agent-status-tree-provider.ts`,
`test/utils/tmux-pane-health.test.ts`,
`test/tree-view/agent-status-dead-process-running.test.ts`,
`research/DEV-NOTES-cc-agent-status-slice2-v1.md`.

**Mechanism.** `isTmuxPaneAgentAlive(sessionId, socket?)` validates the
session id against `^[a-zA-Z0-9._-]+$`, then `execFileSync("tmux", [...,
"list-panes", "-s", "-t", sessionId, "-F", "#{pane_current_command}|#{pane_pid}"],
{timeout: 500})`. Fast path: any pane whose `pane_current_command` is in
`AGENT_PROCESS_NAMES = ["claude","codex","cursor-agent","aider","ollama"]`
short-circuits to `true`. Slow path: BFS `pgrep -P` over the pane pids up to
depth 4 / cap 64, then a single `ps -p <csv> -o comm=` to check descendants.
Shell-injection surface is closed — array args to `execFileSync`, no
interpolation.

**Fail-open.** Two commits exist here (`41f7890` then `d3e4ea1`); the current
state (`d3e4ea1`) moves the early return to *right after* pane parsing:
`if (panePids.length === 0) return true`. This is the correct form. Empty
output, malformed output (no `|` separators), tmux throw, and ps throw all
fail open. Verified by unit tests.

**Provider wiring.** `_tmuxPaneAgentCache` (5s TTL) keyed by
`${socket ?? "__default__"}::${sessionId}` mirrors the existing session-health
cache pattern. The call site is `isRunningTaskHealthy` → `isTmuxPaneAgentHealthy(task)`
at line ~1309 of the post-`bc26d5b` provider, and `isTaskSessionConfirmedDead`
is refactored to consult the same signal. Cost: N cached pane checks per
tree refresh, ~5 ms uncached.

**Tests.** 17 unit + 7 integration cases cover the allowlist (all 5 binaries),
BFS depth, short-circuit, empty output, malformed output, tmux throw, ps
throw, socket forwarding, and — importantly — a regression guard that a live
pane with no stream file still counts as running (defends against the older
stream-file liveness heuristic).

**Warnings.**

- **WARN-2.1** — `pgrep` ambiguity. `pgrep -P <pid>` exits non-zero for both
  "no children" and "system error"; the catch block treats both as
  `continue`. On macOS self-process children this is fine. But if every
  pane's `pgrep` errors (hypothetical system fault), `descendantPids = []`
  → **returns `false`** (dead), not fail-open. The dev notes flag this as a
  known limitation; there is no test for it. Acceptable risk for macOS-only,
  but worth a comment in the helper and one "all pgrep throw → caller's
  choice" unit test before we trust it on a user's laptop under load.

- **WARN-2.2** — hardcoded 500 ms timeout (`tmux-pane-health.ts` top of file).
  Not tunable, not read from settings. A slow laptop or a busy tmux server
  can legitimately exceed this, and the thrown timeout fails open — which
  is correct but silent. No logging, no degraded-mode signal. Consider a
  debug log on timeout so the issue is diagnosable.

- **WARN-2.3** — platform. `pgrep -P` exists on macOS and Linux, not Windows.
  Command Central targets macOS first, but there is no explicit
  `process.platform === "darwin"` guard. On Windows, every `pgrep` throws,
  which triggers WARN-2.1's non-fail-open branch. Low priority — we don't
  ship Windows today — but worth a one-line guard at the top of the file
  that fails open on non-POSIX rather than relying on pgrep errors to no-op.

**Nit.** `AGENT_PROCESS_NAMES` is a private const. A future contributor adding
Gemini CLI or similar will need to read the file to know where to extend.
Export it (or at minimum doc-comment it in `DEV-NOTES`).

**Verdict:** ship-ready with the pgrep edge case documented. Merge after
Slice 1.

---

### Slice 3 — badge-truth routing  *(material complete)*

Commits: `0d932a8`, `1d5a6bc`, `245279c`, `b9783ae`.
Files: `src/utils/agent-counts.ts`, `test/utils/agent-counts.test.ts`,
`test/services/agent-status-bar-count.test.ts`,
`test/tree-view/agent-status-limbo-tier.test.ts` (updated),
`research/DEV-NOTES-cc-agent-status-slice3-v1.md`.

**What changed.** Exactly 10 lines inside `countAgentStatuses`' `case
"completed":` — the body is now

```ts
case "completed":
    if (
        task.review_status === "pending" ||
        task.review_status === "changes_requested"
    ) {
        counts.attention++;
    } else {
        counts.done++;
    }
    break;
```

This deliberately reverses Slice 1's display-vs-badge split. The badge now
mirrors the tree grouping: a completed task awaiting review bumps the
`attention` badge.

**Priority is deterministic.** A task with `status === "completed"` and
`review_status === "pending"` can never also be `"completed_dirty"`;
the switch branches are mutually exclusive. `completed_dirty`/`completed_stale`
continue to route to `limbo`. No overlap.

**The tripwire.** `245279c` rewrites the four Slice 1 tests in
`agent-status-limbo-tier.test.ts` that asserted "review_status does not
affect badge." Slice 1 called that a tripwire on purpose. Slice 3's commit
message ("update Slice 1 badge tests for Slice 3 review_status routing")
makes the reversal explicit and traceable — good.

**Test coverage.** Six new cases in `agent-counts.test.ts` (pending →
attention, changes_requested → attention, approved → done, null → done,
mixed scenario, format summary) plus two new `agent-status-bar-count.test.ts`
cases (mixed text, warning icon). Coverage is tight.

**Layering with Slice 1.** The Slice 1 subagent flagged this as a "HIGH
collision risk." Verified against the code — **it is not a collision, it is
a planned reversal**. Slice 1 explicitly documented the split as temporary
in its dev notes, and Slice 3 closes the gap. The only cost is the
tripwire-test rewrite, which is in `245279c` and passes.

**Nit.**

- **NIT-3.1** — the SPEC doc (`SPEC-agent-status-truth-ux-v1.md`, commit
  `64de485`) was written before Slice 1 and does not reflect the post-Slice-3
  invariant "badge mirrors display for review_status." It isn't wrong —
  just stale. A one-line amendment or an addendum note (similar to
  `research/NOTE-whats-new-version-policy-*`) would save the next reviewer
  from chasing ghosts.

**Verdict:** ship-ready. Because it does not touch the provider file, it has
a **zero-conflict merge** with Slice 2 and Slice 4. Can merge in any
order after Slice 1.

---

### Slice 4 — handoff-file detection  *(just launched — contract review only)*

Commits exist on **two unmerged parallel branches**, both rooted at Slice 2
tip `8c7d4d7`:

| | Branch A (check) | Branch B (health) |
|---|---|---|
| Commits | `a9e94d3`, `48f91a2` | `b4be359`, `4842a9c`, `e22c579` |
| Helper file | `src/utils/handoff-file-check.ts` | `src/utils/handoff-file-health.ts` |
| Helper API | `isDeclaredHandoffFileMissing(task): boolean` | `checkDeclaredHandoff(task): "absent" \| "present" \| "missing" \| "unknown"` |
| Failure mode | Fail-closed (boolean; unknown states collapse to "not missing") | **Fail-open** (explicit `"unknown"` enum value; only ENOENT / directory is `"missing"`) |
| Traversal guard | Not visible | Explicit `rel.startsWith("..") \|\| path.isAbsolute(rel)` → `"unknown"` |
| Provider cache field | `_handoffMissingCache: Map<string, {missing, checkedAt}>` | `_handoffFileCache: Map<string, {state, checkedAt}>` |
| Description chip | `"missing handoff"` (no path) | `` `missing handoff: ${task.handoff_file}` `` (relpath, suppressed when review pending/changes_requested) |
| DEV-NOTES file | none | none |

Both branches add `handoff_file` to `AgentTask` and `normalizeTask`, and both
extend `getNodeStatusGroup`'s `case "completed":` arm to route
"declared-but-missing" to `limbo`. Neither branch sees Slice 3's
`agent-counts.ts` edits (siblings from `8c7d4d7`).

#### 2.4.1 Blockers

- **BLOCKER-4.1 — two parallel implementations, pick one before merge.** This
  is the only actual merge-blocker in the whole wave. Both branches claim
  the Slice 4 mandate; only one can land. Recommend **Branch B** on
  substantive grounds:
  1. `checkDeclaredHandoff` returns an explicit `"unknown"` state. A boolean
     collapses "proven absent" and "can't tell" into the same answer; the
     enum keeps them separate. In a truth-wave that's the whole point.
  2. Branch B is **fail-open** by design (only ENOENT / directory → `missing`).
     EACCES, ELOOP, broken symlinks → `unknown` → stays in `done`. Branch A's
     fail-closed direction will falsely demote tasks whose handoff file lives
     on a read-restricted mount.
  3. Branch B has a path-traversal guard (`rel.startsWith("..") ||
     path.isAbsolute(rel)` → `unknown`); Branch A does not visibly guard.
     Handoff file names come from `.oste-report.yaml`, which is
     user-authored, so this matters.
  4. Branch B's description chip shows the relpath (`"missing handoff:
     research/FOO.md"`) and is suppressed when `review_status` is
     pending/changes_requested so the review chip isn't duplicated by the
     handoff chip. Branch A's chip is just `"missing handoff"`.
  5. Branch B's test file (`handoff-file-health.test.ts`) covers 12 cases
     including traversal, directory, vanishing file (stat is fresh),
     non-ENOENT error (EACCES path). Branch A's coverage is smaller per the
     earlier subagent survey and should be treated as a regression until
     verified case-by-case.

  Cost of picking Branch B: the abandoned files (`handoff-file-check.ts` and
  its test, `_handoffMissingCache` field) must be deleted, not merged. This
  is a ~5-minute cleanup in the merge PR, not a slice rewrite.

- **BLOCKER-4.2 — missing DEV-NOTES file.** Slices 1, 2, and 3 each ship
  `research/DEV-NOTES-cc-agent-status-slice{N}-v1.md`. Slice 4 has nothing.
  Per the wave retro's documented convention this is a contract failure.
  Write it as part of the merge commit. At minimum it must document (a) why
  Branch B won over Branch A, (b) the fail-open contract, (c) the 5-s TTL
  cache rationale, and (d) the known limitation list (symlink loops → unknown,
  EACCES → unknown, permission-changed-after-last-check → serves stale).

#### 2.4.2 Warnings

- **WARN-4.1** — **Slice 4 branches do not include Slice 3's badge routing.**
  Because both branches build from `8c7d4d7` not from `b9783ae`, the
  badge-count file in Slice 4 still has the Slice-1 form. After merging
  Slices 1→2→3→4, the final `countAgentStatuses` is whatever Slice 3 wrote —
  Slice 4 does not touch `agent-counts.ts`, so there is **no file-level
  conflict**, but also no test that proves the combined behavior. See §4.

- **WARN-4.2** — **routing priority review_status > handoff_missing is
  implicit, not asserted.** The final `getNodeStatusGroup` body in Branch B
  (commit `4842a9c`, lines 2923–2946) is:

  ```ts
  if (status === "completed") {
      if (review_status === "pending" || "changes_requested") return "attention";
      if (checkDeclaredHandoff(task) === "missing")          return "limbo";
      return "done";
  }
  ```

  The order is correct (review wins) but there is no test for the three-way
  case "completed + review_status pending + handoff missing → attention."
  Branch B's integration harness covers each dimension individually; the
  joint case is the one a user will trip on first. Add one assertion before
  merge.

- **WARN-4.3** — **description-chip suppression logic is cosmetic, but
  complex.** Lines 5778–5786 of `agent-status-tree-provider.ts` (post-`4842a9c`)
  check `task.status === "completed"`, `review_status` is not pending/
  changes_requested, `task.handoff_file` truthy, and
  `getDeclaredHandoffState(task) === "missing"`. Four conjunctions with no
  comment explaining *why* (avoid chip duplication when a review-attention
  chip will already render). Worth a one-line comment.

#### 2.4.3 Nits

- **NIT-4.1** — `path.isAbsolute(rel)` in the traversal guard is redundant on
  POSIX (`path.relative` never returns an absolute). Harmless belt-and-
  suspenders on Windows. No action.

- **NIT-4.2** — Branch B uses `fs.statSync` inside the tree provider's
  synchronous `getNodeStatusGroup`. Fine with a 5-s cache, but worth noting
  in DEV-NOTES alongside the slice 2 hardcoded 500 ms timeout — both slices
  introduce blocking I/O into a display hot path and both rely on caching
  for acceptable cost.

- **NIT-4.3** — The `checkDeclaredHandoff` helper trims whitespace but does
  not canonicalize case. On case-insensitive filesystems (default macOS!) a
  task that declares `research/FOO.md` and a file at `research/foo.md` will
  report `"present"` correctly because `statSync` is case-insensitive — but
  `"missing"` detection will be exactly as good as the filesystem is. No
  action, just an observation for the dev notes.

#### 2.4.4 Contract blessing

**The Branch B contract is small and clean**: one function, one
return-shape, no async, no side effects, no network. That is exactly the
kind of surface a reviewer can bless without blocking on full integration.
Contract: ✓ (assuming Branch B is the chosen one).

---

## 3. Recommended merge order

```
main
 └─ Slice 1         (no conflicts, foundation)
     └─ Slice 2     (linear add-on; cached provider method)
         └─ Slice 3 (agent-counts.ts only; zero conflict with Slice 2)
             └─ Slice 4-B (provider edits layer cleanly on Slice 2;
                           DELETE Slice 4-A artifacts;
                           WRITE DEV-NOTES-slice4;
                           ADD review+handoff joint test)
```

**Rationale for this order:**

1. **Slice 1 first.** Foundation tier, clean tests, zero conflicts.
2. **Slice 2 second, not third.** Slice 2 lands the provider-level caching
   pattern (`_tmuxPaneAgentCache`, 5 s TTL). Slice 4-B mirrors that pattern
   (`_handoffFileCache`, 5 s TTL). Landing Slice 2 first makes the Slice 4-B
   diff smaller and the review cheaper.
3. **Slice 3 third.** Touches only `agent-counts.ts`. Has zero file-level
   overlap with Slices 2 or 4. Could equally go fourth — the reason to land
   it here is that the tripwire-test reversal happens in the same commit
   range and is easier to audit without Slice 4's unrelated provider churn
   on top.
4. **Slice 4-B fourth.** After its branch is picked, its DEV-NOTES is
   written, and the combined review+handoff integration test is added.

**Slice 4-A is abandoned** with its helper and test deleted in the merge
commit. Do not try to cherry-pick the two branches into a union — the
helpers, caches, and chip strings differ and the resulting code would carry
dead state.

**Alternative order** (Slice 3 last) also works and has the same end state.
Pick whichever minimizes rebase pain when you actually do the merge. No
correctness difference.

---

## 4. What still lacks proof

These are not blockers, but they are gaps a skeptical reader will ask
about. Worth closing before the wave is declared "done":

1. **No combined integration test for Slices 2 + 3 + 4.** Each slice has
   its own test suite. The case "completed task with `review_status:
   pending` and missing handoff file in a dead tmux pane" (the maximal
   joint) is not asserted anywhere. Prediction: routes to `attention` via
   `review_status` priority, and the tmux-pane-health check never runs
   because `status !== "running"`. One test case in
   `test/tree-view/agent-status-dead-process-running.test.ts` or a new
   combined file would close this.

2. **No test for Slice 2's `pgrep`-throws-on-all-panes edge case.** See
   WARN-2.1. The code path exists, the behavior is documented, the test
   doesn't exercise it.

3. **No runtime cost measurement.** Slices 2 and 4 both add cached
   blocking I/O to `getNodeStatusGroup` / `isRunningTaskHealthy`. Nobody
   has measured the wall-clock hit on a tree with 50+ tasks and a cold
   cache. Cache TTLs are 5 s, so worst case is ~50 × (5 ms tmux + 1 ms
   statSync) = ~300 ms per refresh. That's tolerable but unverified.
   Suggest a one-off timing run in a dogfood session and a sentence in the
   retro.

4. **Slice 4-B has no DEV-NOTES.** Covered under BLOCKER-4.2 — listed here
   too so it doesn't fall off the punch list.

5. **Spec doc is pre-Slice-3.** NIT-3.1. The `SPEC-agent-status-truth-ux-v1`
   still describes the display-vs-badge split as intentional. After Slice 3,
   that's obsolete. Either amend the spec or add an addendum note.

6. **`AGENT_PROCESS_NAMES` is not exported/documented.** Slice 2 nit.
   Anyone adding a new agent binary (Gemini CLI, whatever) has to
   file-grep. One sentence in the Slice 2 DEV-NOTES pointing at the
   allowlist location fixes this.

---

## 5. Summary

| Slice | Status | Blockers | Warnings | Nits | Ship? |
|---|---|---|---|---|---|
| 1 — limbo tier | material complete | 0 | 0 | 1 | ✓ merge first |
| 2 — dead pane | material complete | 0 | 3 | 1 | ✓ merge second, document WARN-2.1 |
| 3 — badge truth | material complete | 0 | 0 | 1 | ✓ merge third (or fourth) |
| 4 — handoff file | in flight, two parallel branches | **2** | 3 | 3 | ⚠ pick Branch B, write DEV-NOTES, add joint test, then merge |

**The only actual merge blocker in the wave is BLOCKER-4.1** (pick one Slice 4
branch) and its documentation twin **BLOCKER-4.2** (write the Slice 4
DEV-NOTES). Everything else is warning/nit territory and can land in
follow-up commits without holding up the merge train.

The wave is solid. Slices 1–3 do what the spec says, tests prove it, the
retro is already written, and the collision surface between slices is
narrower than the initial topology suggested because the two "big" files
(`agent-counts.ts`, `agent-status-tree-provider.ts`) partition cleanly:
Slice 3 owns badge counts, Slice 2 owns running-health routing, Slice 4
owns completed-task routing. No function is rewritten twice.

Slice 4 is the only risk. Resolve the branch split, write the notes, add the
joint test — then ship the wave.

---

*Reviewer: Claude Opus 4.6 (reviewer lane), 2026-04-10.*
*Source of truth: `git log --all` on `cc-agent-status-wave-review-0410-200445`.*
*Slice commits are unmerged at review time; HEAD is `70b3cc5` on main.*
