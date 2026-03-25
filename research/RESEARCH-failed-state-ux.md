# Failed State UX — Competitive Analysis & Recommendations

**Date:** 2026-03-25
**Author:** Researcher 2 (automated research)

---

## 1. Competitive Analysis

### 1.1 GitHub Actions Extension (vscode-github-actions)

The official GitHub Actions VS Code extension displays failed workflow runs in a tree view with the following patterns:

- **Visual indicator:** Red X icon (`$(x)` ThemeIcon) for failed jobs and steps
- **Hierarchy:** Workflow → Run → Job → Step; failure state propagates up — a failed step causes the job and run to show failure icons
- **Actions on failure:**
  - "Re-run failed jobs" option (mirrors GitHub web UI)
  - "View logs" opens the terminal output panel
  - Context menu includes "Open in GitHub" to navigate to the web UI
- **Inline description:** Shows the conclusion reason (e.g., "failure", "timed_out") alongside elapsed time
- **No dismiss/hide:** Failed runs stay visible until the branch is deleted or the history scrolls off

**Key takeaway:** Failure state propagates hierarchically. The primary action on failure is "re-run" or "view logs". Items are not individually dismissable.

---

### 1.2 Test Explorer (VS Code built-in)

VS Code's built-in testing UI is the most mature model for failed-state UX in tree views:

- **Visual indicator:** Red circle with X (`$(testing-failed-icon)`), shown inline on the item and propagated to the parent test suite
- **Grouping:** After a run, results are grouped into "Failed Tests", "Passed Tests", "Skipped Tests", "Not Run Tests" sections
- **Filter buttons:** Dedicated toolbar buttons to show only failing tests, passed tests, or skipped tests
- **Actions on failure:**
  - **Run/Debug test** — re-run the specific failing test
  - **Go to test** — navigates to the source file with the failure highlighted
  - **Show output** — opens the test output panel
  - **Fix Test Failure (Copilot)** — Copilot sparkle suggests a code fix
- **Inline error message:** Failure reason appears as a child node under the failed test
- **Persistent until rerun:** Failed state persists across sessions; cleared only when the test is rerun and passes

**Key takeaway:** Filter-by-status is a standard, expected pattern. Inline error detail as a child node is the VS Code idiomatic way to surface failure reason without cluttering the primary label.

---

### 1.3 GitLens

GitLens focuses on git operations rather than async job management. Its "failed state" patterns apply to paused rebase/merge operations:

- **Visual indicator:** Warning icon with contextual tooltip explaining the paused state
- **Paused operation status UI:** Shows clickable references that jump to the specific commit or branch in the Commit Graph
- **No retry per-item:** Operations are continued/aborted at the operation level, not the item level
- **Error display:** Inline in the tree item description (e.g., "merge conflict — 3 files")

**Key takeaway:** For operation errors, GitLens shows clickable context (links to commits/branches) rather than generic retry buttons. Context-sensitive actions outperform generic ones.

---

### 1.4 Docker Extension (vscode-docker / Container Tools)

The Docker extension manages containers that can be in exited/failed states:

- **Visual indicator:** Red "exited" status shown in the label description with exit code
- **Always visible:** Exited containers appear in the "Containers" tree view alongside running ones — no automatic hiding
- **Actions available in context menu:**
  - **Start** — restart a stopped/exited container
  - **Remove** — delete the container entry from the list
  - **View Logs** — opens log output
  - **Inspect** — shows full container metadata
- **Grouping by status:** Containers are grouped by running vs stopped at the top level
- **Remove is prominent:** Cleanup action is first-class, not buried

**Key takeaway:** Stopped/failed items are individually removable. "Remove" is a top-level action, not a secondary one. Grouping by status is used at the list level.

---

### 1.5 CI/CD Dashboards (CircleCI, Jenkins)

**CircleCI:**
- "Rerun from failed" re-runs only the jobs that failed (not the whole pipeline) — targeted retry reduces waste
- "Rerun from beginning" is available but secondary
- Failed workflows show exit code and error message in the job detail
- No individual item dismissal — items persist in run history
- Flaky/failed jobs are visually distinct with a "Rerun" button inline in the row

**Jenkins:**
- "Build Again" appears on failed builds as the primary call-to-action
- "Wipe out workspace and build" is a secondary, more aggressive option
- Console output link is always prominent on failed builds
- Builds are never dismissed; they scroll off the history list over time

**Key takeaway:** CI/CD tools consistently offer targeted retry (only failed jobs, not whole pipeline). Console/log output link is always present on failures. History is not dismissable — it persists for auditability.

---

## 2. Current State in Command Central

From reading `src/providers/agent-status-tree-provider.ts` and `package.json`:

### What already exists

**Status representation:**
- `AgentTask.status` supports: `"running" | "stopped" | "killed" | "completed" | "failed"`
- `AgentTask.exit_code` is available (shown in "Result" detail child node)
- `AgentTask.attempts` and `max_attempts` are tracked and displayed
- Failed status uses red error icon (`charts.red` color, `error` ThemeIcon)

**Existing context menu actions on failed tasks (`viewItem =~ /agentTask\.failed/`):**
- `commandCentral.restartAgent` — restart (requires `commandCentral.hasLauncher`)
- `commandCentral.resumeAgentSession` — resume the session
- `commandCentral.showAgentOutput` — view output
- `commandCentral.viewAgentDiff` — view diff
- `commandCentral.openAgentDirectory` — open directory
- `commandCentral.viewGitLog` — view git log

**Notification on failure:**
- `checkCompletionNotifications()` fires a `showWarningMessage` with "Show Output" and "View Diff" actions when a task transitions `running → failed`

**Missing:**
- No "Remove/Dismiss" action to remove individual failed tasks from the list
- No filter to hide completed/failed tasks and show only running
- No grouping by status in the tree view (all tasks sorted by start time descending)
- No inline error summary as a child detail node specific to failure reason
- `exit_code` is shown in the "Result" detail but only for terminal states — no distinct "Error" detail node
- No "Retry" that targets only failed tasks (vs. restart which re-queues the whole task)

---

## 3. Recommended MVP Features (Prioritized)

### Priority 1 — High value, low complexity

#### 1a. "Dismiss" / Remove failed task from list
**What:** Context menu item "Remove" (or "Dismiss") on `agentTask.failed`, `agentTask.stopped`, `agentTask.killed`, `agentTask.completed` nodes.
**Why:** Docker extension pattern — users naturally want to clean up terminal-state items. Currently there is no way to remove a task entry from the tree short of editing `tasks.json` manually.
**Implementation:**
- New command `commandCentral.removeAgentTask`
- Writes updated `tasks.json` without that task key
- `contextValue` filter: `viewItem =~ /agentTask\.(failed|stopped|killed|completed)/`

#### 1b. Inline exit code / error reason as a child detail node for failed tasks
**What:** When `task.status === "failed"` and `task.exit_code != null`, show a dedicated "Error" child detail node: `Error: Exit 1 · 3/3 attempts exhausted`
**Why:** The current "Result" node shows this but only for completed/failed/stopped uniformly. A red-labeled, visually distinct "Error" detail node (using `error` ThemeIcon) follows the Test Explorer pattern and draws attention to the failure reason without requiring the user to open output.
**Implementation:**
- In `getDetailChildren()`, add an "Error" `DetailNode` with the error ThemeIcon when status is `failed`
- Separate from the existing "Result" node

---

### Priority 2 — Medium value, medium complexity

#### 2a. Filter toggle: "Hide completed/failed" in tree view title bar
**What:** A toggle button in the Agent Status tree view title bar to show only `running` tasks (hide all terminal states).
**Why:** Test Explorer pattern — when you have many agents in various states, focusing on running-only is the most common workflow. Reduces cognitive load.
**Implementation:**
- New config key `commandCentral.agentStatus.showOnlyRunning` (boolean, default false)
- Title bar button that toggles this config
- `getChildren()` filters tasks by status when enabled
- Uses `$(filter)` ThemeIcon; when active, uses `$(filter-filled)` or applies a color

#### 2b. Inline "Retry" action in the tree item inline menu for failed tasks
**What:** Show a `$(debug-restart)` inline icon button on `agentTask.failed` items.
**Why:** CircleCI / GitHub Actions pattern — the primary CTA on failure is "retry". Currently `restartAgent` exists but is only in the right-click context menu, not the inline icon group.
**Implementation:**
- Add `commandCentral.restartAgent` to the `view/item/context` group with `"group": "inline"` for `viewItem == agentTask.failed`
- Requires `commandCentral.hasLauncher` guard (same as existing)

---

### Priority 3 — Lower value or higher complexity

#### 3a. "Clear all terminal-state tasks" (bulk remove)
**What:** Title bar button to remove all `completed`, `failed`, `stopped`, `killed` tasks at once.
**Why:** After a batch of agents completes, clearing them all at once is faster than removing individually.
**Implementation:**
- New command `commandCentral.clearTerminalTasks`
- Filters `tasks.json` to only keep `running` tasks
- Requires confirmation dialog if any `completed` tasks have PRs (to avoid losing PR references)

#### 3b. Status grouping in tree view (Failed at top)
**What:** Optional grouping: Failed tasks appear at the top, followed by Running, then Completed.
**Why:** When debugging, you want failures immediately visible, not buried chronologically.
**Note:** The current sort is by `started_at` descending. Simple reordering (failed→running→completed→other) is lower complexity than full grouping. Docker extension does this at the status group level.
**Implementation:**
- Sort key: `status priority` (failed=0, killed=1, running=2, stopped=3, completed=4) then `started_at` descending within each group

---

## 4. Text Mockup — Ideal Failed State UX in Tree View

```
AGENT STATUS                                          [filter] [refresh]
  2 running · 1 failed · 3 completed

  ❌ 🔨 task-abc123              my-project · Failed after 12m       [↺]
    Error: Exit 1 · 3/3 attempts exhausted
    Prompt: Fix the authentication bug in login flow
    Git: feature/auth-fix → a1b2c3d (Fix: update token validation)
    Changes: 2 files, +45 -12

  🔄 🔬 task-def456              other-project · Running for 5m      [⊗]
    Prompt: Add unit tests for the payment module
    Ports: detecting...

  ✅ task-ghi789                 my-project · Completed in 8m        [×]
    PR: #142 (approved)
```

**Legend:**
- `[↺]` = Retry (inline icon, only for failed, requires launcher)
- `[⊗]` = Kill (inline icon, only for running)
- `[×]` = Remove/Dismiss (inline icon, for terminal states)
- `[filter]` = Toggle "show only running" filter
- Error detail node uses `$(error)` ThemeIcon with `charts.red` color

---

## 5. Implementation Plan — File-Level Changes

### Phase 1 (MVP — Priority 1 items)

| File | Change |
|---|---|
| `src/providers/agent-status-tree-provider.ts` | Add "Error" detail node in `getDetailChildren()` for `failed` status; use `error` ThemeIcon on that detail item |
| `src/extension.ts` | Register `commandCentral.removeAgentTask` command; write updated `tasks.json` excluding removed task |
| `package.json` | Add `commandCentral.removeAgentTask` command definition; add to `view/item/context` menu for `agentTask.(failed|stopped|killed|completed)` |

### Phase 2 (Priority 2 items)

| File | Change |
|---|---|
| `package.json` | Add inline `commandCentral.restartAgent` to `view/item/context` with `"group": "inline"` for `viewItem == agentTask.failed` |
| `package.json` | Add title bar filter toggle button command |
| `src/extension.ts` | Register `commandCentral.agentStatus.toggleRunningFilter` command |
| `src/providers/agent-status-tree-provider.ts` | Filter `getChildren()` based on config toggle |

### Phase 3 (Priority 3 items)

| File | Change |
|---|---|
| `src/providers/agent-status-tree-provider.ts` | Add sort-by-status option in `getChildren()` |
| `src/extension.ts` | Register `commandCentral.clearTerminalTasks` with confirmation for tasks with PRs |
| `package.json` | Add `clearTerminalTasks` to title bar actions |

---

## 6. Sources Referenced

- [GitHub Actions Extension — VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-github-actions)
- [VS Code Testing Documentation](https://code.visualstudio.com/docs/debugtest/testing)
- [Test Explorer UI — VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer)
- [CircleCI Automatic Reruns](https://circleci.com/docs/guides/orchestrate/automatic-reruns/)
- [GitLens Side Bar Views](https://help.gitkraken.com/gitlens/side-bar/)
- [VS Code Container Tools Overview](https://code.visualstudio.com/docs/containers/overview)
