# DESIGN: Agent Activity Timeline (v0.3.0 P1)

> What did agents do while you were away?

## Problem Statement

Command Central already shows **live agent status** (running/completed/failed) via `AgentStatusTreeProvider` reading `tasks.json`. What's missing is a **historical timeline** — a chronological view of *what* agents actually accomplished: commits made, files changed, PRs opened, and task outcomes, grouped by time period so you can scan your morning and catch up on overnight agent work in seconds.

## 1. Data Model

### ActivityEvent (core unit)

```typescript
interface ActivityEvent {
  /** Unique ID (commit SHA, task ID, or generated) */
  id: string;

  /** When this happened */
  timestamp: Date;

  /** Which agent performed this action */
  agent: {
    name: string;          // e.g. "claude-opus-4-6", "cc-test-badge"
    role?: AgentRole;      // "developer" | "planner" | "reviewer" | "test"
    sessionId?: string;    // links back to tasks.json entry
  };

  /** What happened */
  action: ActivityAction;

  /** Which project/workspace */
  project: {
    name: string;
    dir: string;
  };
}

type ActivityAction =
  | { type: "commit"; sha: string; message: string; filesChanged: number; insertions: number; deletions: number }
  | { type: "task-completed"; taskId: string; exitCode: number; duration: string }
  | { type: "task-failed"; taskId: string; exitCode: number; error?: string }
  | { type: "pr-opened"; prNumber: number; title: string; url: string }
  | { type: "pr-updated"; prNumber: number; reviewStatus: string }
  | { type: "task-started"; taskId: string; prompt: string };
```

### TimelineGroup (display grouping)

Reuses the existing `timePeriod` taxonomy from `tree-element.ts`:

```typescript
type TimelinePeriod = "lastHour" | "today" | "yesterday" | "last7days" | "older";

interface TimelineGroup {
  type: "timelineGroup";
  period: TimelinePeriod;
  label: string;            // "Last Hour", "Today", "Yesterday", etc.
  events: ActivityEvent[];
  collapsibleState: vscode.TreeItemCollapsibleState;
}
```

### Tree structure

```
Agent Activity
├─ Last Hour (3 events)
│  ├─ 🔨 cc-test-badge committed: "fix: align test workspace folders" (3 files)
│  ├─ ✅ task-12 completed (developer · 23m)
│  └─ 🔄 task-15 started (reviewer · my-project)
├─ Today (8 events)
│  ├─ 🔨 claude-opus committed: "feat: migrate agent status tree" (5 files)
│  └─ ...
├─ Yesterday (5 events)
└─ Last 7 Days (12 events)
```

## 2. Data Sources

### Primary: Git log with co-author parsing

The most reliable data source. Agent commits include `Co-Authored-By` trailers.

```bash
git log --all --format="%H%x00%aI%x00%s%x00%b%x00%an" --numstat --since="7 days ago"
```

**Extraction logic:**
1. Parse `Co-Authored-By: <name> <email>` from commit body
2. If email matches known agent patterns (`noreply@anthropic.com`, bot emails), classify as agent commit
3. Extract `--numstat` for file change counts
4. Run per workspace folder (multi-root support)

**Advantages:**
- Always available — no external dependencies
- Immutable history — won't lose data
- Works across all agent tooling (Claude Code, Cursor, Copilot)

**Detection heuristics:**
```typescript
const AGENT_PATTERNS = [
  /Co-Authored-By:.*<noreply@anthropic\.com>/i,           // Claude Code
  /Co-Authored-By:.*<.*\+claude@users\.noreply\.github\.com>/i,
  /\[cc-test-badge\]/,                                      // CC convention
  /^(bot|agent|claude|copilot)\b/i,                        // Author name prefix
];
```

### Secondary: tasks.json (Ghostty Launcher registry)

Already read by `AgentStatusTreeProvider`. Provides richer metadata than git alone:
- Task start/end times and duration
- Agent role (developer/planner/reviewer/test)
- PR linkage
- Prompt files
- Attempt counts and exit codes

**Integration:** Read the same file path from `commandCentral.agentTasksFile` config. Correlate task `session_id` with git author metadata where possible.

### Optional future: completions.jsonl (OpenClaw)

Not for v0.3.0. Could provide token usage, model info, and conversation summaries in a future iteration. Flagged as a future data source to keep the model extensible.

### Real-time updates: FileSystemWatcher

- Watch `tasks.json` for task state changes (reuse existing watcher pattern from `AgentStatusTreeProvider`)
- Watch `.git/refs/heads/*` for new commits arriving
- Debounce at 200ms (consistent with existing 150ms pattern in agent status provider)

## 3. UI Design

### 3a. TreeView Provider

New `ActivityTimelineTreeProvider` implementing `TreeDataProvider<TimelineNode>`:

```typescript
type TimelineNode = TimelineGroupNode | ActivityEventNode | EventDetailNode;

interface TimelineGroupNode {
  type: "timelineGroup";
  period: TimelinePeriod;
  label: string;
  eventCount: number;
}

interface ActivityEventNode {
  type: "activityEvent";
  event: ActivityEvent;
}

interface EventDetailNode {
  type: "eventDetail";
  label: string;
  value: string;
  parentEventId: string;
}
```

**Tree hierarchy:**
- Level 1: `TimelineGroupNode` — time period headers
- Level 2: `ActivityEventNode` — individual events
- Level 3: `EventDetailNode` — commit files, PR details (collapsed by default)

### 3b. Tree item rendering

| Event Type | Icon | Label | Description |
|---|---|---|---|
| commit | `$(git-commit)` | `fix: align test workspace...` | `claude-opus · 3 files · 2m ago` |
| task-completed | `$(check)` | `task-12 completed` | `developer · my-project · 23m` |
| task-failed | `$(error)` | `task-7 failed` | `reviewer · exit 1 · 45m` |
| pr-opened | `$(git-pull-request)` | `PR #42 opened` | `feat: add timeline view` |
| task-started | `$(play)` | `task-15 started` | `planner · my-project` |

Use `vscode.ThemeIcon` (not emoji) for consistency with VS Code native UI. Reserve emoji for the existing agent status view to avoid visual conflict.

### 3c. Interactions

| Action | Trigger | Effect |
|---|---|---|
| Click commit event | `TreeItem.command` | Open diff of that commit (`git show <sha>`) |
| Click task event | `TreeItem.command` | Open prompt file or jump to agent status |
| Click PR event | `TreeItem.command` | Open PR URL in browser |
| Expand commit | `getChildren()` | Show changed files list |
| Click changed file | `TreeItem.command` | Open file diff (reuse `openChange` command) |
| Refresh | Title bar button | Re-scan git log + tasks.json |
| Filter by agent | QuickPick dropdown | Filter timeline to specific agent |

### 3d. View placement

Register under the existing `commandCentral` Activity Bar container:

```jsonc
// package.json contributes.views.commandCentral
{
  "id": "commandCentral.activityTimeline",
  "name": "Agent Activity",
  "when": "commandCentral.activityTimeline.enabled",
  "visibility": "visible"
}
```

Position: below the existing `agentStatus` view, above `extensionFilter`.

## 4. Integration Points

### 4a. Existing AgentStatusTreeProvider

- **Reuse, don't replace.** Agent Status shows *current state*; Activity Timeline shows *history*.
- Share the tasks.json reading logic. Extract `readRegistry()` and `normalizeTask()` into a shared `TaskRegistryReader` service that both providers consume.
- Cross-link: clicking a task event in the timeline can reveal the corresponding node in Agent Status (if still present).

### 4b. Multi-workspace support

- Run git log per workspace folder (like `SortedGitChangesProvider` does per-workspace)
- Merge events from all workspaces into a single timeline, sorted chronologically
- Show `project.name` in event descriptions to disambiguate
- Use `ProjectViewManager.getAllProviders()` to discover active workspace folders

### 4c. Change grouping (GitSort)

- Commit events in the timeline link to the same file URIs that `SortedGitChangesProvider` displays
- Clicking a file in a commit's expanded children should open the same diff view (reuse `openChange` command infrastructure from `tree-view-utils.ts`)

### 4d. Extension filter

- No direct integration needed. The timeline shows events, not files — filtering by extension doesn't apply.

### 4e. Configuration

```jsonc
{
  "commandCentral.activityTimeline.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Show Agent Activity timeline view"
  },
  "commandCentral.activityTimeline.lookbackDays": {
    "type": "number",
    "default": 7,
    "description": "How many days of history to show"
  },
  "commandCentral.activityTimeline.agentPatterns": {
    "type": "array",
    "default": ["noreply@anthropic.com"],
    "description": "Email patterns to identify agent commits"
  }
}
```

## 5. Implementation Plan

### Phase 1: Data layer (2 files, ~200 lines)

| Step | File | Action | Notes |
|---|---|---|---|
| 1.1 | `src/services/activity-event-types.ts` | **Create** | `ActivityEvent`, `ActivityAction`, `TimelinePeriod` types |
| 1.2 | `src/services/activity-collector.ts` | **Create** | `ActivityCollector` service: git log parsing, tasks.json reading, event merging. Exports `collectEvents(workspaceFolders, lookbackDays): ActivityEvent[]` |

### Phase 2: Tree provider (2 files, ~250 lines)

| Step | File | Action | Notes |
|---|---|---|---|
| 2.1 | `src/providers/activity-timeline-tree-provider.ts` | **Create** | `ActivityTimelineTreeProvider` implementing `TreeDataProvider<TimelineNode>`. Groups events by time period. Handles tree item rendering, expand/collapse, click commands. |
| 2.2 | `src/providers/activity-timeline-view-manager.ts` | **Create** | Lifecycle manager (following `ExtensionFilterViewManager` pattern). Sets up FileSystemWatcher, debounced refresh, view visibility tracking. |

### Phase 3: Shared task registry reader (1 file, 1 file modified, ~80 lines)

| Step | File | Action | Notes |
|---|---|---|---|
| 3.1 | `src/services/task-registry-reader.ts` | **Create** | Extract `readRegistry()`, `normalizeTask()` from `AgentStatusTreeProvider` into shared service |
| 3.2 | `src/providers/agent-status-tree-provider.ts` | **Modify** | Delegate to `TaskRegistryReader` instead of inline implementation |

### Phase 4: Wiring (2 files modified, ~50 lines)

| Step | File | Action | Notes |
|---|---|---|---|
| 4.1 | `package.json` | **Modify** | Add view declaration, commands (`refreshActivityTimeline`, `filterActivityByAgent`), configuration properties, `when` clauses |
| 4.2 | `src/extension.ts` | **Modify** | Instantiate `ActivityCollector`, `ActivityTimelineTreeProvider`, `ActivityTimelineViewManager`. Register TreeView, commands, disposables. Wire to `onProvidersReady` event. |

### Phase 5: Commands (1 file, ~60 lines)

| Step | File | Action | Notes |
|---|---|---|---|
| 5.1 | `src/commands/activity-timeline-commands.ts` | **Create** | `refreshActivityTimeline`, `filterActivityByAgent` (QuickPick), `openCommitDiff` (shell out to `git show`) |

### Phase 6: Tests (2 files, ~300 lines)

| Step | File | Action | Notes |
|---|---|---|---|
| 6.1 | `src/test/activity-collector.test.ts` | **Create** | Git log parsing, agent detection heuristics, event merging, edge cases |
| 6.2 | `src/test/activity-timeline-tree-provider.test.ts` | **Create** | Tree structure, time grouping, rendering, empty states |

### Summary

| Phase | Files Created | Files Modified | Est. Lines |
|---|---|---|---|
| 1. Data layer | 2 | 0 | ~200 |
| 2. Tree provider | 2 | 0 | ~250 |
| 3. Shared registry | 1 | 1 | ~80 |
| 4. Wiring | 0 | 2 | ~50 |
| 5. Commands | 1 | 0 | ~60 |
| 6. Tests | 2 | 0 | ~300 |
| **Total** | **8** | **3** | **~940** |

## 6. Open Questions / Risks

| # | Item | Severity | Notes |
|---|---|---|---|
| 1 | Git log performance on large repos | WARNING | Mitigate with `--since` flag and caching. Re-scan only on watcher events, not on every tree expansion. |
| 2 | Agent detection false positives | NIT | Some human developers might have bot-like email patterns. The `agentPatterns` config lets users tune this. |
| 3 | Cross-workspace event ordering | NIT | Events from different repos may have clock skew. Use commit author date, not committer date. |
| 4 | tasks.json cleanup/rotation | WARNING | Old tasks accumulate. Timeline should handle large registries gracefully (cap at `lookbackDays`). |
| 5 | No tasks.json configured | NIT | Timeline still works — shows git-only events. Degrade gracefully. |

SPEC COMPLETE
