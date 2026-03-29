# REVIEW: Agent Status Sorting & Grouping Redesign

> **Reviewer:** Review agent · **Date:** 2026-03-29
> **Reviewing:** `research/SPEC-agent-status-sorting-roadmap.md`
> **Verdict:** Conditionally approve with blockers below

---

## Executive Summary

The spec correctly identifies the core problem: status-priority sorting buries recency, and alphabetical project grouping is disconnected from the user's actual workflow. The proposed fix — recency-first default with a sort-mode enum — is directionally right. However, the roadmap has gaps that could ship a different flavor of the same confusion if not addressed.

This review is organized into: (1) current UX failure modes ranked, (2) what Git Changes gets right, (3) where the spec still fails users, and (4) specific findings.

---

## 1. Current UX Failure Modes (ranked by severity)

### Severity 1: Recency is unreachable without expert knowledge

The flat recency view requires disabling *two* independent booleans (`sortByStatus=false` AND `groupByProject=false`). Neither setting is surfaced in the view toolbar — both require opening VS Code Settings and knowing the exact setting names. A new user who just wants "show me the latest run" has no discoverable path to get there.

### Severity 2: Status-priority sorting creates a stale-failure ceiling

`TASK_STATUS_PRIORITY` puts `failed` at priority 0. A task that failed 6 hours ago permanently occupies slot #1 until manually cleared or pushed down by another failure. The user's mental question is "what just happened?" but the tree answers "what went wrong at some point in the past?" This is the single biggest contributor to the "hard to find latest runs" complaint.

### Severity 3: Alphabetical project groups destroy temporal signal

Projects sorted by `a.projectName.localeCompare(b.projectName)` mean the project you just ran an agent in could be at position 5 of 8, with no visual indicator that it has fresh activity. Users have to expand every group to find the latest run. This is O(n) visual scanning where Git Changes gives O(1).

### Severity 4: Discovered agents don't interleave with launcher tasks

In flat mode (`groupByProject=false`), discovered agents are appended *after* all launcher tasks. A discovered agent that started 5 seconds ago appears below a launcher task that completed 2 hours ago. The two populations live in separate visual zones with incompatible sort orders (status-priority vs. time-only).

### Severity 5: No completed_at in sort key

`sortTasks()` uses `started_at` exclusively (line 1574). A task that started 30 minutes ago but just completed 2 seconds ago is sorted as "30 minutes old." The spec correctly identifies `completed_at ?? started_at` as the right key, but the current code doesn't have this — meaning even if you disable status sorting today, the recency you get is *start-time recency*, not *completion-time recency*.

---

## 2. What Git Changes Gets Right

Git Changes (Source Control) in VS Code succeeds because:

1. **Recency is implicit.** Files you just changed appear because they *are* the changes. There's no sorting decision — the data is inherently recent-first by nature of being uncommitted.

2. **Grouping is lightweight and optional.** You can view changes flat or grouped by folder. Groups don't add cognitive overhead because the group label IS the context (the folder path), not a status category.

3. **One-click toggling.** Sort-by-name vs sort-by-path vs sort-by-status is a single toolbar button that cycles through modes. No settings.json needed.

4. **Group headers carry signal.** A folder group in Source Control shows its change count. You can scan group headers alone to find where the action is.

5. **No zombie entries.** Once you commit or discard, the entry disappears. There's no stale-failure ceiling because the view is self-cleaning.

Agent Status cannot fully replicate #1 and #5 (tasks are historical, not ephemeral), but it should absolutely borrow #2, #3, and #4.

---

## 3. Where Project Grouping Helps vs. Hurts

### Helps

- **Multi-project orchestration.** When running 5+ agents across 3 repos, grouping avoids a wall of interleaved task names that all look similar. You want to see "what happened in `api-gateway`" as a unit.
- **Mental model alignment.** Developers think in project boundaries. Grouping matches how they'd describe their work: "I had agents running on frontend and backend."
- **Diff context.** File changes under a task node make more sense when you know which project they belong to.

### Hurts

- **Single-project users.** If you only work in one repo, grouping adds a useless nesting level. Every task is under the same group — one extra expand click for zero information gain.
- **Alphabetical sort kills the "what just happened" question** (see Severity 3 above).
- **Folder groups add even more nesting.** The `buildGroupedRootNodes()` hierarchy (folder group → project group → task → details) creates 4 levels deep. VS Code tree views degrade in usability past 3 levels.
- **Group collapse state is fragile.** If the tree reloads (agent completes, refresh button), collapse state may reset, forcing the user to re-expand to find where they were.

**Bottom line:** Grouping should be off by default and on by choice. The spec gets this right. But when enabled, groups MUST sort by recency, not alphabetically. The spec says this too but doesn't address the nesting-depth problem.

---

## 4. Should Status-Priority Sorting Remain?

**Recommendation: Keep as opt-in mode, not default.**

Status-priority sorting answers "what needs attention?" which is a valid question — but it's the *second* question users ask, not the first. The first question is always "what just happened?" Status sorting should be available as the `"status"` sort mode, but not the default.

The spec's `"status-recency"` hybrid mode (running pinned top, rest by recency) is the right compromise for users who want both signals. However, see BLOCKER-2 below for a concern about its behavior.

---

## 5. Recommended Default Mode for Launch

**`recency` sort + `groupByProject=false`** (matching the spec's recommendation).

This is the right call. Rationale:
- Matches the Git Changes mental model
- Running agents are naturally near the top (they started recently)
- Completed agents surface by completion time, answering "what just finished?"
- One flat list is scannable without expand/collapse friction
- Power users who want status sorting or grouping can opt in with one-click toolbar buttons

---

## 6. Findings

### BLOCKER-1: `completed_at` field may not exist in task data

The spec assumes `completed_at` is available for recency sorting (Section 3.2, 4.1). The current `sortTasks()` only uses `started_at`. Before implementing the spec, verify:
- Does `AgentTask` have a `completed_at` field in its type definition?
- Do all task status writers populate it?
- What about discovered agents — do they have an equivalent?

If `completed_at` doesn't exist or is unreliably populated, the entire recency-first default degrades to start-time sorting, which is a much weaker signal. A task that started 2 hours ago and just finished would still appear as "2 hours old."

**Action required:** Audit `AgentTask` type and all status-transition writers before implementation begins.

### BLOCKER-2: `status-recency` mode has an undefined pinning boundary

The spec describes `status-recency` as "Pin running agents to top, sort everything else by recency." But what about `stopped` agents? They were recently running. What about `failed` agents that failed 5 seconds ago — are they pinned or in the recency zone?

The current `TASK_STATUS_PRIORITY` puts `running` at priority 3 (below `failed`, `killed`, `contract_failure`). If `status-recency` only pins `running`, then a just-failed agent drops into the recency pool — which may actually be the right behavior, but it's not specified. If it pins all "attention-needed" statuses (failed, killed, contract_failure, running), it becomes nearly identical to full status sort for most users.

**Action required:** Define exactly which statuses are "pinned" in `status-recency` mode and document the rationale.

### BLOCKER-3: Sort mode cycle button has no visible state indicator

The spec proposes cycling through 3 sort modes with a single toolbar button whose icon changes. But VS Code tree view toolbar buttons are small, and icon-only state indicators are notoriously hard to read. The difference between `$(history)`, `$(warning)`, and `$(pin)` is subtle at 16px.

Users will click the button, see the list reorder, and not understand what mode they're now in. This is the same discoverability problem the current UX has — just with a different coat of paint.

**Action required:** Either (a) add the sort-mode indicator to the summary node (the spec mentions this in 5.3 but lists it as P1 — it should be P0), or (b) use a quickpick menu on click instead of blind cycling.

### WARNING-1: Changing two defaults simultaneously is risky

The spec changes both `sortByStatus` and `groupByProject` defaults in the same release. Existing users who never touched settings will see a radically different view: flat instead of grouped, recency instead of status-priority. This is a double-disruption.

**Recommendation:** Ship in two phases. Phase 1: change `sortByStatus` default to `false` (recency sort) while keeping `groupByProject=true`. This gives users the recency signal they asked for without removing the project structure they may rely on. Phase 2 (next release): change `groupByProject` default to `false` after validating that recency sort is well-received.

### WARNING-2: The spec doesn't address list length / pagination

The current view shows ALL historical tasks. As users accumulate hundreds of agent runs, even recency-sorted flat lists become unwieldy. Git Changes doesn't have this problem because it's inherently bounded (only uncommitted changes).

The spec has no concept of:
- Maximum visible items (e.g., show last 50 runs, "Show more..." node at bottom)
- Time-based windowing (e.g., show last 24 hours by default)
- Archival / cleanup of old tasks

Without this, the recency-first view will eventually degrade to scrolling through hundreds of entries, and the "find the latest run" problem returns as a "find the latest run in a giant list" problem.

**Recommendation:** Add a P0 requirement for a default item cap (e.g., 50 most recent) with an expandable "Show older runs" node.

### WARNING-3: Group recency sort may surprise users in multi-project setups

When grouping is enabled under recency sort, project groups are sorted by their most recent child's timestamp. This means project groups will reorder every time an agent completes. A user who had mentally mapped "frontend is the second group" will find it jumping to position 1 when its agent finishes.

Git Changes avoids this because folder grouping is spatially stable (folders don't reorder). Agent Status groups reordering on every state change could feel chaotic.

**Recommendation:** When grouped, consider sorting groups by most-recent-activity but with "sticky" positioning — groups only reorder on manual refresh, not on live updates. Or document this behavior explicitly and let telemetry validate whether users find it disorienting.

### WARNING-4: Migration path assumes settings are writable

Section 8 says: "if user has explicit `sortByStatus=true` in settings, auto-migrate to `sortMode: status`." This writes to the user's settings on activation. If the settings file is read-only (e.g., managed by MDM or dotfiles repo), this will fail silently or throw. The migration should be a read-time shim, not a write-time transformation.

### WARNING-5: Folder group nesting depth

`buildGroupedRootNodes()` creates up to 4 levels: folder group → project group → task → details/file changes. VS Code's tree view is not designed for this depth. With recency-sorted groups that reorder, users will spend more time managing tree expand/collapse state than actually reading task information.

**Recommendation:** When folder groups are active, consider auto-expanding project groups that contain running or recently-completed agents (last 5 minutes).

### NIT-1: Summary node sort indicator icons are non-standard

The spec proposes `↓`, `⚠`, `▶` as sort indicators in the summary node text. These are Unicode characters that may render differently across platforms and font configurations. Use VS Code codicons (`$(arrow-down)`, `$(warning)`, `$(play)`) in the `ThemeIcon` for the tree item instead, or use plain text labels like `[Recent]`, `[Status]`, `[Active]`.

### NIT-2: `Cmd+Shift+S` conflicts with "Save As"

The proposed keyboard shortcut `Cmd+Shift+S` for cycling sort mode conflicts with the universal "Save As" shortcut in VS Code. Even scoped to "when Agent Status focused," this will confuse muscle memory.

**Recommendation:** Use `Cmd+Shift+O` (sort/order) or drop the shortcut entirely — toolbar button + command palette is sufficient.

### NIT-3: Three sort modes may be one too many

`recency` and `status` cover the two main use cases. `status-recency` is a hybrid that's hard to explain and hard to predict. Users will try it, not understand how it differs from `status`, and go back. Consider shipping with two modes and adding the third only if telemetry shows demand.

### NIT-4: Telemetry success criteria are untestable without baseline

Section 9.2 says "User complaints about finding recent runs: Decrease to zero." Without a current baseline count, "decrease to zero" is unmeasurable. Establish a baseline from current feedback channels before shipping.

---

## 7. Risks & Regressions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `completed_at` not reliably populated | Medium | High — breaks core sort | Audit before implementation |
| Existing users confused by double-default change | High | Medium — support burden | Phase the rollout (WARNING-1) |
| Flat recency list becomes unmanageable at scale | Medium | High — recreates the original problem | Add item cap (WARNING-2) |
| Sort mode cycling feels random without visible state | High | Medium — discoverability regression | Make summary indicator P0 |
| Group reordering on live updates feels chaotic | Medium | Low-Medium | Sticky positioning or document behavior |
| `Cmd+Shift+S` shortcut conflict | Certain | Low | Change shortcut |
| Migration writes fail on read-only settings | Low | Low — but noisy | Use read-time shim |

---

## 8. Summary Recommendation

The spec is 80% right. The diagnosis is accurate, the sort-mode enum is the correct abstraction, and recency-first is the right default. Fix the three blockers (verify `completed_at`, define pinning boundary for `status-recency`, make sort indicator P0), address the phased rollout concern, and add an item cap for long lists. Then ship it.

The biggest risk is not the sort logic itself — it's that users accumulate history and any sort order degrades without a bounded viewport. Solve that alongside the sort redesign, not after.
