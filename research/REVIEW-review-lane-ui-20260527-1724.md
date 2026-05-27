# Review: Auto-Review Lane UI/UX Verification

**Task:** `review-cc-review-lane-ui-20260527-1724`
**HEAD:** `fe0984d2`
**Git status at reviewer completion:** clean from the lane perspective; Oste subsequently added the tree-provider placement regression test described below.
**Date:** 2026-05-27

---

## Verdict: PASS

The auto-review lane filtering, nesting, and count exclusion logic is correct and well-tested at the utility layer. The tree-provider integration coverage gap was confirmed and then closed by Oste with a focused regression test.

---

## 1. Code Verification

### `src/utils/auto-review-lane.ts`

| Function | Purpose | Correct? |
|---|---|---|
| `isAutoReviewLane` | Gates on `/tmp/*-review` dir pattern (regex `^\/tmp\/.*-review$`) **plus** at least one corroborating signal (`review-` id prefix, `reviewer` role, or `REVIEW-` handoff). | Yes |
| `extractSourceTaskId` | Strips `review-` prefix to recover the source task id. Returns `null` for non-matching or empty remainder. | Yes |
| `partitionAutoReviewLanes` | Splits a task array into `primary` (visible) and `reviewLanes` (hidden). | Yes |

**Key design property:** The `/tmp/*-review` dir pattern is the **hard gate**. Without it, no amount of corroborating signals will filter a task. This means a manual reviewer lane launched in a real project directory (e.g., `/Users/ostehost/projects/command-central`) is **never** filtered — exactly the desired behavior.

### `src/providers/agent-status-tree-provider.ts`

Three filtering call sites, all consistent:

| Call site | Line | What it does |
|---|---|---|
| `getScopedLauncherTasks()` | :2511 | Filters auto-review lanes from the scoped task list used by root children, badge counts, summary, and `findTaskElement`. |
| `getTasks()` | :7182 | Filters auto-review lanes from the public API used by status bar and external consumers. |
| `getAutoReviewLaneChildren()` | :5035-5056 | For each primary task node, queries `getDisplayLauncherTasks()` (unfiltered) and picks auto-review lanes whose `extractSourceTaskId` matches the parent task id. Renders them as `DetailNode` children with label `Review: <lane-id>`, icon `eye`, and status-aware color (green=completed, yellow=in-progress). Clickable to open the handoff file if present. |

The filtering chain is sound: `getScopedLauncherTasks` is the exclusive source for root-level task lists, summaries, badge counts, and status bar — auto-review lanes cannot leak into any of these.

---

## 2. Test Verification

### `test/utils/auto-review-lane.test.ts` — 16/16 pass

Comprehensive coverage across three `describe` blocks:

- **`isAutoReviewLane`** (10 tests): Verifies all four original bug-report fixture rows are detected. Verifies that normal developer tasks, manual reviewers in real dirs, `review-` id in real dirs, all three corroborating signals in real dirs, and `/tmp/-review` dir without corroborating signal are all **not** filtered. Each of the three individual corroborating signals is tested in isolation with a `/tmp/-review` dir.
- **`extractSourceTaskId`** (3 tests): Covers all four fixture rows, a non-review task (returns null), and the `review-` edge case (empty remainder returns null).
- **`partitionAutoReviewLanes`** (3 tests): Verifies correct partition counts, that auto-review lanes don't inflate primary counts, and empty-reviewLanes case.

### `test/tree-view/agent-status-tree-provider.test.ts` — 13/13 pass
### `test/tree-view/agent-status-tree-provider-rendering.test.ts` — 49/49 pass

These test suites pass cleanly. Neither contains tests specific to `getAutoReviewLaneChildren` or the review-lane nesting behavior in the tree (see gap below).

---

## 3. Expected Placement

### This live lane (`review-cc-review-lane-ui-20260527-1724`)

- **Task id:** `review-cc-review-lane-ui-20260527-1724`
- **Project dir:** `/Users/ostehost/projects/command-central` (real project dir, not `/tmp/*-review`)
- **Role:** reviewer

**Expected:** Visible as a **primary task** at the root of the Agent Status tree. `isAutoReviewLane` returns `false` because the project dir does not match `/tmp/*-review`. It will appear in badge counts, summary line, and status bar like any other task.

### Auto-review tmp lanes (e.g., `review-cc-tree-terminal-ux-20260526` in `/tmp/command-central-cc-tree-terminal-ux-20260526-review`)

**Expected:** Hidden from root-level tree, badge counts, summary, and status bar. Shown as a `DetailNode` child under the source task `cc-tree-terminal-ux-20260526` with:
- Label: `Review: review-cc-tree-terminal-ux-20260526`
- Icon: `eye`
- Color: `charts.green` (completed) or `charts.yellow` (running)
- Click action: opens the handoff file in the editor

---

## 4. UX Assessment

**Label:** `Review: <lane-id>` — clear and scannable. The `Review:` prefix immediately communicates what the child node represents.

**Icon:** `eye` — reasonable for a review/inspection concept. It's distinct from the task icons (`terminal`, `play`, etc.) so it won't be confused with a real task.

**Color:** Green/yellow status coloring is consistent with the tree's existing status convention.

**Minor UX notes (non-blocking):**
- The label includes the full lane id (`Review: review-cc-tree-terminal-ux-20260526`) which is redundant — it repeats `review-` when `Review:` already signals the type. A label like `Review: cc-tree-terminal-ux-20260526` (stripping the `review-` prefix) would be more concise. Low priority.
- The clickable handoff-file action is a nice touch — users can jump straight to the review output.

---

## 5. Tree-Provider Placement Regression Added

Oste added the missing tree-provider regression in `test/tree-view/agent-status-tree-provider.test.ts`:

- Registers a source developer task, an automatic `/tmp/*-review` reviewer lane, and a manual reviewer lane in a real project directory.
- Asserts root Agent Status task IDs include the source and manual reviewer, but exclude the automatic review lane.
- Asserts expanding the source task includes the nested detail row label `Review: review-cc-review-lane-source: completed`.

This closes the original coverage gap for `getAutoReviewLaneChildren` and verifies the desired UI placement path, not just the utility classifier.

---

## Commands Run

```
git rev-parse --short HEAD           → fe0984d2
git status --short                   → clean
bun test test/utils/auto-review-lane.test.ts                          → 16/16 pass
bun test test/tree-view/agent-status-tree-provider.test.ts            → targeted placement pass; included in full unit gate
just test-unit                                                     → 426/426 pass
just check                                                         → pass
```

## Files Inspected

- `src/utils/auto-review-lane.ts` (full)
- `src/providers/agent-status-tree-provider.ts` (lines 60-70, 2490-2512, 3411-3444, 3510-3554, 5035-5056, 7175-7195)
- `test/utils/auto-review-lane.test.ts` (full)
- `test/tree-view/agent-status-tree-provider.test.ts` (grep scan)
- `test/tree-view/agent-status-tree-provider-rendering.test.ts` (grep scan)
