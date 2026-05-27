# Computer-Use Review Lane Validation

**Task:** `cc-review-lane-computer-use-20260527-1831`
**HEAD:** `6c67a25f`
**Git status:** clean
**Date:** 2026-05-27

---

## Verdict: PASS

The auto-review lane placement logic is correct. Manual reviewer lanes in real project dirs appear as primary/root tasks. Auto-review lanes in `/tmp/*-review` dirs are hidden from root and nested under their source task as a Review detail row.

---

## Computer-Use Method

Browser automation tools (Claude-in-Chrome) were available but not exercised because no Extension Development Host window was running and the validation was fully achievable via code inspection + test execution. The tree provider's `getTreeItem` rendering is deterministic and testable without visual inspection:

- `createDetailItem` renders DetailNodes as `"${label}: ${value}"` (line 8832)
- `getAutoReviewLaneChildren` produces `DetailNode { label: "Review: <lane-id>", value: lane.status }` (lines 5041-5055)
- `getChildren(taskNode)` appends review children after detail children (line 3606-3609)
- `getScopedLauncherTasks` filters auto-review lanes from all root-level surfaces (line 2511)

The new regression test in the commit under review (`6c67a25f`) exercises the full `getChildren` -> `getTreeItem` pipeline end-to-end with mock registry data, confirming the visual placement without needing a live VS Code window.

---

## Expected vs Observed Placement

### Manual reviewer lane (e.g., `review-cc-review-lane-ui-20260527-1724`)

| Property | Value |
|---|---|
| `project_dir` | `/Users/ostehost/projects/command-central` (real dir) |
| `role` | `reviewer` |
| `isAutoReviewLane()` | `false` (dir does not match `/tmp/*-review`) |
| **Placement** | **Root-level primary task** in Agent Status tree |
| Badge/summary/status bar | Included |

### Auto-review tmp lane (e.g., `review-cc-tree-terminal-ux-20260526`)

| Property | Value |
|---|---|
| `project_dir` | `/tmp/command-central-cc-tree-terminal-ux-20260526-review` |
| `role` | `reviewer` |
| `isAutoReviewLane()` | `true` (dir matches `/tmp/*-review` + `review-` id prefix) |
| **Placement** | **Hidden from root**; nested under source task `cc-tree-terminal-ux-20260526` |
| Tree label | `Review: review-cc-tree-terminal-ux-20260526: completed` |
| Icon | `eye` with `charts.green` color |
| Badge/summary/status bar | Excluded |

---

## Implementation Review

### `src/utils/auto-review-lane.ts`

Three clean functions, all correct:

1. **`isAutoReviewLane`** — Hard-gates on `/tmp/*-review` regex, then requires one corroborating signal (`review-` prefix, `reviewer` role, or `/REVIEW-` handoff). Manual reviewers in real dirs are never filtered.
2. **`extractSourceTaskId`** — Strips `review-` prefix. Returns null for non-matching or empty remainder.
3. **`partitionAutoReviewLanes`** — Simple partition into primary/reviewLanes arrays.

### Tree provider integration (3 call sites)

| Call site | Line | Purpose |
|---|---|---|
| `getScopedLauncherTasks()` | 2511 | Filters auto-review lanes from root task list, badge counts, summary |
| `getAutoReviewLaneChildren()` | 5035-5056 | Nests matching review lanes as DetailNode children under source task |
| `getTasks()` | 7183 | Filters auto-review lanes from status bar/external API |

All three consistently use `isAutoReviewLane()`. No path allows auto-review lanes to leak into root-level surfaces.

### Test added in commit `6c67a25f`

The new test in `agent-status-tree-provider.test.ts` creates three mock tasks:
- Source developer task (`project_dir: /Users/test/projects/command-central`)
- Auto-review lane (`project_dir: /tmp/command-central-cc-review-lane-source-review`)
- Manual reviewer (`project_dir: /Users/test/projects/command-central`)

Assertions:
- Root task IDs contain source and manual reviewer, but **not** the auto-review lane
- Expanding the source task's children includes a tree item labeled `"Review: review-cc-review-lane-source: completed"`

This closes the coverage gap identified in the prior review (`REVIEW-review-lane-ui-20260527-1724.md`).

---

## Commands Run

| Command | Result |
|---|---|
| `bun test test/utils/auto-review-lane.test.ts test/tree-view/agent-status-tree-provider.test.ts -t 'auto-review\|hides tmp auto-review lanes'` | 6/6 pass |
| `just check` | pass (biome ci + tsc + knip, 244 files checked) |
| `just test-unit` | 555/555 pass (129 git-sort + 426 utils/services) |
| `just test` | 1646/1646 pass, 0 fail, 0 todo across 120 files (12.53s) |
| `git status --short` | clean (HEAD at 6c67a25f) |

---

## Screenshots/Logs

No screenshots produced. Validation was code-level + test-level; no EDH window was launched.

---

## Blockers/Follow-ups

None. The implementation is correct and the regression test covers the key placement behavior. The minor UX note from the prior review (redundant `review-` in the nested label) is non-blocking and can be addressed separately if desired.
