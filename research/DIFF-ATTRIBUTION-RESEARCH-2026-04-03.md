# Diff Attribution Drift in Agent Status — Research Report

**Date:** 2026-04-03  
**Scope:** `src/providers/agent-status-tree-provider.ts`, `src/extension.ts`  
**Status:** Research + Implementation Recommendation

---

## 1. Current Implementation Audit

### The `AgentTask` schema (lines 100–128)

The task record in `tasks.json` has these commit-related fields:

| Field | Type | Populated by |
|---|---|---|
| `start_sha` | `string \| null` | Launcher at spawn (legacy field name) |
| `start_commit` | `string \| null` | Launcher at spawn (current field name) |
| `started_at` | `string` | Launcher at spawn (ISO timestamp) |
| `completed_at` | `string \| null` | Launcher or harness at completion |
| **`end_commit`** | **missing** | **Never written anywhere** |

There is no `end_commit` field in the schema. It is not parsed, not stored, and not used anywhere in the diff logic. This is the primary root cause of attribution drift.

### `getTaskDiffStartCommit` (lines 3338–3372)

```typescript
private getTaskDiffStartCommit(t: AgentTask): string | undefined {
    if (t.status === "running") return undefined;          // ← working tree diff

    if (t.start_commit && t.start_commit !== "unknown") {
        return t.start_commit;
    }
    if (t.start_sha && t.start_sha !== "unknown") {
        return t.start_sha;
    }

    if (t.started_at) {
        // timestamp heuristic: git log --before=<started_at> -1
        const commitHash = execFileSync("git", [
            "-C", t.project_dir, "log",
            `--before=${t.started_at}`, "-1", "--format=%H",
        ]).trim();
        if (commitHash) return commitHash;
    }

    return "HEAD~1";    // ← ultimate fallback, meaningless for old tasks
}
```

**Critical observation:** the returned `startCommit` is the start boundary only. The end boundary is always implicitly `HEAD`.

### `getPerFileDiffs` (lines 3691–3730) and async variant (lines 2250–2298)

Both variants build the git range as:

```
git diff --numstat ${startCommit}..HEAD
```

On failure or empty output, they fall back to:

```
git diff --numstat HEAD~1..HEAD
```

There is no `end_commit` bound. For completed tasks this means the diff keeps growing as `HEAD` advances.

### `showGitDiffAsFilePicker` in `extension.ts` (lines 2299–2330)

The manual "View Diff" command does the same thing — it computes a `sinceRef` (from `task.start_sha` or timestamp heuristic) and diffs `sinceRef..HEAD`. Same drift problem, same missing `end_commit`.

---

## 2. Failure Mode Catalogue

### 2.1 `start_commit..HEAD` instead of `start_commit..end_commit`

**Status: Confirmed present in every diff path.**

When task A completes at commit C3 and task B continues to C5, task A's diff panel now includes C4 and C5. The completed task's diff view mutates indefinitely. This is the primary symptom from dogfooding.

### 2.2 Missing `end_commit` capture on completion

**Status: Field does not exist in schema.**

Neither the task registry schema (`AgentTask` interface, line 100–128) nor the registry parser (`normalizeAgentTask`, lines 540–608) define or read an `end_commit`. The launcher's completion hook (which writes `completed_at`) does not write a corresponding `end_commit`. The entire end-boundary concept is absent.

### 2.3 Fallback to `HEAD~1` — meaningless for older tasks

**Status: Confirmed (line 3371, 3711, 3721).**

If `start_commit`/`start_sha` are absent (e.g., old task records written before the field existed), the fallback is `HEAD~1`, which reflects the single most recent commit regardless of which task created it. For any task more than one commit old, this is random garbage.

### 2.4 Timestamp-based `git log --before` — ambiguous on busy branches

**Status: Confirmed (lines 3350–3368).**

`git log --before=<ISO>` finds the newest commit strictly before the timestamp. On active multi-agent branches, many commits land within seconds of each other. The heuristic can land on the wrong commit or miss the boundary entirely — especially since agent clocks aren't perfectly synchronized with git author timestamps.

### 2.5 Same-branch multi-agent work — attribution drift is inevitable without explicit bounds

**Status: Architectural inevitability.**

When agents A and B both work on `main` sequentially, A's completed diff (bounded by `start..HEAD`) always expands to include B's commits. No amount of heuristic improvement can fix this without an explicit end-boundary commit SHA. The only complete solutions are:
- (a) capture `end_commit` at the moment the agent finishes, or
- (b) give each agent its own branch/worktree

### 2.6 Auto-commit/report files polluting diffs

**Status: Confirmed by dogfooding symptoms.**

Files like `.oste-report.yaml`, `research/COMPLETION-*.md`, and release digests are committed by orchestrator hooks after agent work finishes. Because completed tasks use `start..HEAD`, these report files appear in the agent's diff summary even though the agent never touched them. This creates false attribution and inflates per-file diff lists with noise.

---

## 3. The Right Attribution Model

### Model A: `start_commit` + `end_commit`, diff `start..end`

Store two SHA pointers per task. At spawn, record `start_commit = git rev-parse HEAD`. At completion (any terminal status: completed/stopped/failed), record `end_commit = git rev-parse HEAD` before any post-completion commits happen.

**Diff:** `git diff --numstat ${start_commit}..${end_commit}`

- Pros: Simple, exact, immutable after the task finishes. No heuristics. No drift. Works correctly for same-branch multi-agent work as long as `end_commit` is captured before the next commit.
- Cons: If the hook fires after an unrelated post-completion commit (e.g., orchestrator auto-commit), `end_commit` may include one extra commit. This is a timing race, not a fundamental flaw.
- Verdict: **Correct model for the immediate fix and the majority of workflows.**

### Model B: Explicit commit list per task (`commits: [sha1, sha2, ...]`)

Each task tracks the exact set of commit SHAs it created, probably by observing `git log` after each hook fires or by having the agent explicitly record commits.

- Pros: Perfect attribution even if other commits land on the same branch between two agent commits.
- Cons: Requires much deeper integration — the agent (Claude Code subprocess) would need to emit commit events, or the harness would need to poll `git log` continuously. Significantly more complex. Fragile if the agent amends commits.
- Verdict: **Ideal for the long term, but over-engineered for the immediate problem.**

### Model C: Timestamp/author/message heuristics

Infer attribution by filtering commits by timestamp window or author name matching task metadata.

- Pros: Works without changing the launcher schema.
- Cons: Fundamentally unreliable. Two agents running at overlapping times cannot be disambiguated. Timestamp precision is too coarse. Author is always "Claude Code" for every agent. Commit messages don't reliably encode task ID. This model cannot be made trustworthy.
- Verdict: **Reject. The current fallback heuristics are already Model C, and they are causing the problem.**

### Recommendation: Model A

**Store `start_commit` at spawn and `end_commit` at completion. Diff `start_commit..end_commit` for all terminal-state tasks.**

Model A is correct for the common case (sequential or non-overlapping agents on the same branch), simple to implement, and produces immutable, non-drifting diffs once a task completes. The timing race with post-completion commits is real but minor; it can be addressed later by capturing `end_commit` as the first action in the completion hook, before any report files are written.

---

## 4. Comparison to Prior Research and Architecture Context

### Same-branch vs. worktree isolation

The launcher architecture (evidenced by `tmux_session`, `worktree_path` fields in `AgentTask`) already contemplates per-task worktrees. The `DEV-NOTES-launcher-session-contract.md` shows the launcher controls spawning via tmux sessions per task.

If every task ran on its own branch/worktree:
- Attribution is trivially exact: diff the worktree branch vs. its merge base
- No timing races for `end_commit`
- Merging and reviewing becomes explicit

However, worktree-per-task is a significant infrastructure change. The task registry today does not universally enforce it. Until worktree isolation is the norm, `end_commit` capture is the correct interim model.

### dmux/cmux task ownership expectations

The existing `role` field (`developer`, `planner`, `reviewer`, `test`) implies tasks are scoped semantic units. Users comparing reviewer output vs. developer output expect the diffs to be bounded to those roles' actual work — not to everything that happened after each started. The current HEAD-relative model directly violates the role-scoped trust model.

### Terminal architecture decisions

The provider's `GIT_DIFF_TIMEOUT_MS` guard, the async port detection, and the `getLastOutputLine` tmux capture all show the provider is designed to handle concurrent, independent agents. The diff logic is the outlier — it was never updated to match the concurrent-agent model. Everything else uses task-specific state; diff attribution uses global branch state.

---

## 5. Implementation Roadmap

### Immediate patch — capture `end_commit` and use it for completed tasks

**Scope:** ~30 lines across two files, plus launcher schema change.

1. **`AgentTask` interface** (`agent-status-tree-provider.ts:128`): add `end_commit?: string | null`
2. **`normalizeAgentTask`** (`~line 603`): parse `end_commit: asString(raw["end_commit"]) ?? null`
3. **`getTaskDiffStartCommit`**: rename to `getTaskDiffRange` and return `{ start, end }`. For terminal-state tasks, use `end_commit` as the end if present; otherwise fall back to current `HEAD` (with a visible warning).
4. **All `..HEAD` diff calls**: replace `${startCommit}..HEAD` with `${range.start}..${range.end}`
5. **Launcher completion hook** (external, in ghostty-launcher): write `end_commit = $(git -C $project_dir rev-parse HEAD)` to `tasks.json` as the first action when transitioning a task to a terminal state.

This patch eliminates drift for all tasks where `end_commit` is captured. Older tasks without `end_commit` degrade gracefully to the current behavior (still wrong, but not a regression).

**Risk:** Low. The change is additive — new field, same fallback for missing data.

### Proper fix — per-task branch or worktree isolation

**Scope:** Medium infrastructure change in ghostty-launcher, smaller change in Command Central.

1. At spawn, create a task branch: `git checkout -b task/${task_id}` in the project dir or a linked worktree.
2. Record `branch: task/${task_id}` and `worktree_path` in `tasks.json`.
3. In `getPerFileDiffs`: if `task.branch` is present, diff `git diff main...task/${task_id}` (three-dot for merge-base comparison). Immune to timing races.
4. On completion, optionally merge back or leave for PR review.

This model makes attribution exact and immutable by construction. It also enables side-by-side multi-agent review in the sidebar (compare two task branches without the diffs overlapping).

**Risk:** Medium. Worktree management adds lifecycle complexity. Not all projects will support parallel worktrees. Some tasks (e.g., reviewers reading main) should not be on isolated branches.

### Nice-to-have — exclude orchestrator noise files from diffs

**Scope:** Small, independent improvement.

Add a configurable `diff_exclude_patterns` setting (or hard-code a short list) to filter files matching:
- `.oste-report.yaml`
- `research/COMPLETION-*.md`
- `research/DEV-NOTES-*.md`
- `releases/*.vsix`

Pass as `-- ':!.oste-report.yaml'` pathspec excludes to `git diff --numstat`. This reduces noise even under the current HEAD-relative model and remains useful under Model A.

---

## 6. Answers to Spec Questions

**1. Why is the current view misaligned?**

Completed tasks are diffed against the moving `HEAD` of the branch rather than against the commit that existed when the task finished. As new commits land (from other agents, from orchestrator hooks, from unrelated work), every completed task's diff silently expands to include them. The view mutates without user action.

**2. What exact metadata is missing?**

`end_commit` — a SHA recorded at the moment a task transitions to any terminal state (`completed`, `stopped`, `failed`). This field does not exist in `AgentTask`, is not written by the launcher, and is not read anywhere.

**3. What is the right attribution model?**

Model A: `git diff ${start_commit}..${end_commit}`. Both SHAs are captured at well-defined lifecycle events (spawn and completion). The diff range is immutable after task completion. No heuristics.

**4. What should we implement next?**

Immediate: add `end_commit` to the launcher's completion hook output and update `getPerFileDiffs` to use it for terminal-state tasks. This is a one-session fix with very low risk.

Medium-term: evaluate per-task worktree isolation as the default spawn strategy. This eliminates the end_commit timing race and makes the diff model trivially correct.

---

RESEARCH COMPLETE
