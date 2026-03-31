# SPEC: Cron Jobs + Agent Status Integration

Date: 2026-03-31
Task ID: `cc-cron-integration-research`

## Goal

Make scheduled OpenClaw cron runs visible in Command Central's Agent Status sidebar alongside launcher-managed agent runs, without breaking the existing `tasks.json`-based lifecycle model.

## Executive Summary

Current state:

- The Cron Jobs view is a thin OpenClaw wrapper. It reads job state from `openclaw cron list --json`, watches `~/.openclaw/cron/jobs.json`, and renders job metadata only.
- The Agent Status sidebar is centered on Ghostty Launcher's `tasks.json`, then augmented by session/process discovery for agents not already tracked by the launcher.
- There is no shared identifier or merge path between OpenClaw cron jobs/runs and Agent Status rows today.

Recommendation:

- Keep launcher `tasks.json` as the source of truth for launcher-managed/manual runs.
- Add a second runtime source for OpenClaw cron runs, backed by `~/.openclaw/cron/runs/*.jsonl`.
- Merge cron-backed synthetic rows into Agent Status with clear precedence:
  launcher task > cron-backed synthetic run > generic discovered process.
- Phase the work so completed/failed cron runs appear first, then add live running cron correlation once active-run metadata is available.

This avoids forcing OpenClaw cron through `oste-spawn.sh` immediately, while still preserving an optional future path for launcher-backed cron tasks.

## Current State: Cron Jobs View

### Files

- `src/extension.ts`
- `src/services/cron-service.ts`
- `src/providers/cron-tree-provider.ts`
- `src/types/cron-types.ts`
- `package.json`

### Initialization

The Cron Jobs tree is always initialized in `src/extension.ts`. The extension creates:

- `CronService`
- `CronTreeProvider`
- tree view `commandCentral.cronJobs`

It then wires:

- `cronService.start(() => cronTreeProvider.refresh())`
- commands for refresh, run now, enable, disable
- placeholder commands for create, edit, delete, history

Important finding:

- `commandCentral.cron.enabled` exists in `package.json`, but there is no code path that uses it. The view is initialized unconditionally.

### Data Source

`CronService` is an OpenClaw wrapper, not a scheduler:

- Reads jobs via `openclaw cron list --json`
- Watches `~/.openclaw/cron/jobs.json`
- Mutates jobs only through CLI:
  - `openclaw cron enable <id>`
  - `openclaw cron disable <id>`
  - `openclaw cron run <id>`

It never writes `jobs.json` directly.

### What the Cron Tree Shows

Root states:

- OpenClaw missing
- No scheduled jobs
- Summary node: `Cron Jobs (X active, Y disabled)`

Per job:

- Label: job name, with `[disabled]` suffix when disabled
- Description:
  - humanized schedule
  - last run relative time, or
  - next run relative time
- Icon:
  - green check for normal
  - yellow warning for consecutive errors
  - red error for last error
  - paused icon when disabled

Job detail children:

- `Schedule`
- `Model`
- `Agent` when `agentId` exists
- `Delivery` when delivery is configured
- `Last`
- `Next`

### Cron Data Model in Command Central

`src/types/cron-types.ts` models a subset of OpenClaw's schema:

- `CronJob`
  - `id`
  - `agentId?`
  - `name`
  - `description?`
  - `enabled`
  - `schedule`
  - `sessionTarget`
  - `payload`
  - `delivery?`
  - `state`
- `CronSchedule`
  - `cron`
  - `every`
  - `at`
- `CronPayload`
  - `agentTurn`
  - `systemEvent`
- `CronState`
  - last/next run timing
  - last status/error
  - consecutive error count

Observed OpenClaw job files contain more fields than Command Central currently types:

- `createdAtMs`
- `updatedAtMs`
- `sessionKey`
- `wakeMode`
- delivery/account details
- extra state fields such as `lastDeliveryStatus`, `lastDelivered`

These are currently ignored by Command Central.

### Run History Today

Run history is not integrated into the UI.

Evidence:

- `CronService.getRunHistory()` is a stub
- `commandCentral.cron.viewHistory` is a placeholder
- local OpenClaw data exists in `~/.openclaw/cron/runs/*.jsonl`

Observed run history records include:

- `jobId`
- `status`
- `summary`
- `error`
- `sessionId`
- `sessionKey`
- `runAtMs`
- `durationMs`
- `nextRunAtMs`
- `model`
- `provider`
- `deliveryStatus`

This run history is the missing bridge for sidebar integration.

### Refresh Behavior

Cron refresh has two paths:

- Real reload on file change or manual refresh
- Tree repaint timer in `CronTreeProvider`

Important finding:

- `CronTreeProvider`'s interval refresh only fires `onDidChangeTreeData`; it does not call `service.reload()`.
- In practice, fresh data depends on the OpenClaw file watcher or manual refresh.

## Current State: Agent Status Data Flow

### Files

- `src/providers/agent-status-tree-provider.ts`
- `src/discovery/agent-registry.ts`
- `src/discovery/session-watcher.ts`
- `src/discovery/process-scanner.ts`
- `src/discovery/types.ts`
- `src/utils/tasks-file-resolver.ts`
- `src/extension.ts`

### Primary Source: Ghostty Launcher `tasks.json`

The sidebar's primary data source is the launcher registry resolved from:

1. `${workspaceFolder}/.ghostty-launcher/tasks.json`
2. `~/.config/ghostty-launcher/tasks.json`
3. `~/.ghostty-launcher/tasks.json`

Or an explicit `commandCentral.agentTasksFile` setting.

`AgentStatusTreeProvider.readRegistry()`:

- reads JSON directly from disk
- accepts registry version `1` or `2`
- normalizes tasks to version `2`
- falls back to an empty registry on malformed/missing data

### Agent Task Model

`AgentTask` includes launcher lifecycle metadata such as:

- `id`
- `status`
- `project_dir`
- `project_name`
- `session_id`
- `prompt_file`
- `stream_file`
- `agent_backend`
- `role`
- `started_at`
- `completed_at`
- `exit_code`
- `model`
- `persist_socket`
- `ghostty_bundle_id`
- `prompt_summary`

This is materially richer than the cron job model for anything related to terminal lifecycle and output.

### How Tasks Reach the Sidebar

Flow:

1. Resolve `tasks.json` path
2. Read and normalize registry
3. Convert raw registry tasks to display tasks
4. Overlay runtime status fixes
5. Merge non-launcher discovered agents
6. Render tree, status bar, dashboard, notifications

`getDisplayRegistryTasks()` is launcher-only.

`getTasks()` returns:

- display launcher tasks
- synthetic "running" rows for discovered agents

That merged list feeds:

- status bar counts
- dashboard panel
- tree summary counts

### Discovery Merge Rules

`AgentRegistry` merges three sources conceptually:

1. launcher `tasks.json`
2. session watcher
3. process scanner

Actual precedence:

- launcher tasks are authoritative
- discovery only fills gaps when the launcher is not already tracking the agent

`getDiscoveredAgents(launcherTasks)` suppresses discovered agents when a running launcher task matches by:

- PID, or
- `session_id`, or
- project/backend/start-time heuristic

`filterLiveAgents()` also suppresses discovered agents when a matching launcher task is already in a terminal state.

This matters for cron integration:

- if a cron-triggered run ever becomes a launcher task, the sidebar already knows how to prefer the launcher row
- if not, cron needs its own synthetic row type instead of pretending to be a discovered process

### Discovery Internals

Session watcher:

- watches `~/.claude/sessions`
- extracts `pid`, `sessionId`, `cwd`, `startedAt`
- filters to actual agent-mode invocations

Process scanner:

- polls `ps` + `lsof`
- resolves cwd
- detects claude/codex/gemini backends
- parses model/session hints from CLI arguments

Polling interval:

- default `commandCentral.discovery.pollInterval = 5000`
- minimum 2000 ms

### Refresh Behavior

`tasks.json` refresh:

- file watcher via VS Code `createFileSystemWatcher`
- native `fs.watch` fallback
- 150 ms debounce

Auto-refresh:

- only runs while there are running launcher tasks
- interval from `commandCentral.agentStatus.autoRefreshMs`
- default 5000 ms

Important finding:

- the auto-refresh timer only fires tree updates and stuck checks
- it does not reread `tasks.json`
- fresh lifecycle data still depends on file changes from the launcher

## Launcher Contract Relevant to Integration

Ghostty Launcher already gives Command Central exactly the data it wants.

`oste-spawn.sh`:

- registers a task in `TASKS_FILE`
- writes `prompt_file`, `session_id`, `stream_file`, `agent_backend`, `model`, `role`, `persist_socket`, `prompt_summary`

`oste-complete.sh`:

- updates final task status
- sets `completed_at`, `exit_code`
- emits completion markers and notifications

Conclusion:

- any cron workflow that ultimately calls `oste-spawn.sh` will appear in Agent Status automatically, because the existing sidebar is already built around launcher tasks

## Integration Questions

### 1. Does the cron view connect to OpenClaw's cron API or a file?

Both.

- Reads live state via `openclaw cron list --json`
- Watches `~/.openclaw/cron/jobs.json`
- Mutates only via OpenClaw CLI

So the view is OpenClaw-backed, not a standalone file reader.

### 2. How do agents get from `tasks.json` to the sidebar?

Path:

- launcher writes `tasks.json`
- `AgentStatusTreeProvider` watches and reads it
- provider normalizes and overlays runtime state
- discovered non-launcher agents are merged in after launcher tasks
- tree, status bar, and dashboard all consume the merged provider output

### 3. How do discovered agents merge?

Merge strategy today:

- launcher tasks first
- session/process discovery second
- launcher suppresses discovered duplicates

That is the correct pattern to reuse for cron-backed rows.

### 4. What is the refresh interval?

- Agent Status discovery polling: 5000 ms by default
- Agent Status running-task repaint timer: 5000 ms by default
- Cron tree repaint timer: 30000 ms by default
- Cron file reload depends on `jobs.json` watch or manual refresh

### 5. Can cron jobs trigger `oste-spawn.sh` tasks that then appear in `tasks.json`?

Not with the current integration.

Current OpenClaw cron jobs are modeled as:

- `payload.kind = "agentTurn"`
- `payload.kind = "systemEvent"`

They execute through OpenClaw session routing (`sessionTarget`, `sessionKey`), not through Ghostty Launcher's task registry.

So today:

- cron-triggered OpenClaw runs do not create launcher `tasks.json` rows
- therefore they do not appear in Agent Status as launcher tasks

Technical possibility:

- yes, if a future cron job mode or wrapper script invokes `oste-spawn.sh`
- no, based on today's Command Central code and observed OpenClaw cron artifacts

### 6. Can the cron view show "next scheduled run"?

Yes, it already does.

It uses:

- `job.state.nextRunAtMs` in the job description
- a `Next` detail child in expanded rows

### 7. Can completed cron runs link back to their agent task in the sidebar?

Not today.

Missing pieces:

- no cron run history ingestion in Command Central
- no cron-to-task identifier in launcher `tasks.json`
- no sidebar node type for cron-native runs

## Proposed Architecture

### Decision

Treat OpenClaw cron as a second runtime source for Agent Status, instead of forcing it into launcher `tasks.json` immediately.

Why:

- matches current reality: OpenClaw already persists cron run history
- avoids coupling cron scheduling to Ghostty Launcher before the data model is ready
- preserves launcher `tasks.json` as authoritative for manual and launcher-managed runs
- gives a clean path to show both completed and live scheduled work

### New Concepts

Add a new internal model:

- `CronRunRecord`
  - parsed from `~/.openclaw/cron/runs/*.jsonl`
- `ScheduledAgentRun`
  - synthetic sidebar row produced from cron job + latest run + optional discovery correlation

Suggested shape:

```ts
interface ScheduledAgentRun {
  id: string; // `${jobId}:${runAtMs}`
  source: "cron";
  jobId: string;
  jobName: string;
  scheduleKind: "cron" | "every" | "at";
  sessionTarget: string;
  sessionKey?: string;
  sessionId?: string;
  runAtMs: number;
  durationMs?: number;
  status: "running" | "completed" | "failed";
  nextRunAtMs?: number;
  summary?: string;
  error?: string;
  model?: string;
  provider?: string;
  deliveryStatus?: string;
  linkedTaskId?: string;
  linkedDiscoveredPid?: number;
}
```

### Merge Rules

Sidebar precedence should become:

1. launcher task
2. cron synthetic run
3. discovered generic process

Dedup rules:

- if a launcher task explicitly declares `cron_job_id`/`cron_run_id` in the future, prefer launcher task and attach cron metadata as decoration
- else if a cron run can be matched to a discovered process by `sessionId` or `sessionKey`, prefer the cron synthetic row and enrich it with live process data
- otherwise keep the cron run as its own synthetic completed/failed row

### New Service Layer

Add `CronRunService` or expand `CronService` to include:

- `getJobs()`
- `getRecentRuns(jobId?)`
- watcher on `~/.openclaw/cron/runs/`
- parsing of JSONL-backed run history

Do not overload `CronTreeProvider` with sidebar merge logic. Keep parsing/services reusable.

### Agent Status Provider Integration

`AgentStatusTreeProvider` should ingest three streams:

1. launcher tasks
2. cron synthetic runs
3. discovered processes

Recommended internal pipeline:

1. load launcher registry
2. load cron jobs
3. load recent cron runs
4. correlate cron runs to launcher/discovery
5. build merged display nodes
6. compute counts and grouped nodes

### Cron UI Cross-Linking

Add navigation in both directions:

- Cron Jobs view:
  - `Reveal Latest Run in Agent Status`
- Agent Status cron-backed row:
  - `Reveal Cron Job`
  - `Run Job Now`
  - `View Run History`

This gives the user one operational surface instead of two disconnected trees.

## Data Flow Diagram

```text
                    OpenClaw
         +------------------------------+
         | ~/.openclaw/cron/jobs.json   |
         | ~/.openclaw/cron/runs/*.jsonl|
         +---------------+--------------+
                         |
                         v
                 +---------------+
                 | CronService   |
                 | CronRunService|
                 +-------+-------+
                         |
                         v
Ghostty Launcher         |                Discovery
+-------------------+    |    +-------------------------------+
| ~/.config/...     |    |    | SessionWatcher + ProcessScan  |
| tasks.json        |    |    | discovered live agent gaps    |
+---------+---------+    |    +---------------+---------------+
          |              |                    |
          v              v                    v
   +--------------------------------------------------+
   | AgentStatusTreeProvider                           |
   | precedence: launcher > cron synthetic > discovered|
   +----------------------+---------------------------+
                          |
                          v
          +-------------------------------------------+
          | Agent Status tree / status bar / dashboard|
          +-------------------------------------------+
```

## Implementation Phases

### Phase 1: Completed/Failed Cron Runs in Agent Status

Scope: Medium

Deliverables:

- parse `~/.openclaw/cron/runs/*.jsonl`
- create synthetic sidebar rows for recent cron runs
- show completed/failed cron runs grouped with normal agent history
- link cron rows back to Cron Jobs view
- expose latest cron run from Cron Jobs view

Why first:

- uses existing persisted data
- no need to solve live active-run correlation yet
- immediately makes scheduled work visible in the sidebar

Risks:

- recency cap needs to avoid flooding the sidebar for high-frequency cron jobs
- run history records do not currently map to launcher task IDs

### Phase 2: Live Running Cron Correlation

Scope: Medium to Large

Deliverables:

- correlate active OpenClaw cron sessions to live sidebar rows
- show `running` scheduled jobs in the same section as manual running agents
- decorate with cron badge/job name/next run

Preferred dependency:

- OpenClaw exposes active run metadata through `cron status`/`cron list` or session metadata

Fallback:

- correlate via `sessionId` or `sessionKey` where available

Main risk:

- current observed job files do not expose a first-class "current active run" record

### Phase 3: Optional Launcher-Backed Cron Interop

Scope: Large

Deliverables:

- add an explicit contract for cron jobs that intentionally launch `oste-spawn.sh`
- propagate cron metadata into launcher `tasks.json`
  - `cron_job_id`
  - `cron_run_at_ms`
  - `cron_source = "openclaw"`
- dedupe launcher-backed cron tasks against synthetic cron rows

Why optional:

- this is useful for tasks that should support launcher-specific actions like capture/kill/restart
- but it should not block the core visibility integration

## Tests To Add

### Cron Service / Run Parsing

- parse JSONL cron run history into typed records
- handle malformed run lines without breaking the whole job history
- ignore unsupported/non-agent cron payloads where appropriate
- watch `~/.openclaw/cron/runs/` and refresh on append/change

### Agent Status Merge Logic

- launcher task suppresses matching cron synthetic row when explicit linkage exists
- cron synthetic row suppresses plain discovered row when correlation exists
- completed cron runs appear even when no launcher task exists
- current-project scope filters cron synthetic rows by resolved project
- max-visible-agents behavior does not let frequent cron jobs starve manual history

### Tree UX

- cron-backed Agent Status row renders distinct icon/context value
- `Reveal Cron Job` command locates the right job
- Cron Jobs view can reveal latest Agent Status row
- summary counts include running cron-backed rows once live correlation ships

### Integration Fixtures

- fixture for `jobs.json`
- fixture for `runs/<jobId>.jsonl`
- fixture for launcher `tasks.json`
- fixture for discovered process/session overlap

## Open Questions

1. What should qualify as a sidebar-visible cron run?
   - only `agentTurn`
   - or also `systemEvent` jobs that represent real autonomous work

2. How many cron runs should be visible per job by default?
   - latest only
   - latest N
   - or unified recency list across all jobs

3. What stable field should be used for live correlation?
   - `sessionId`
   - `sessionKey`
   - future explicit `activeRunId`

4. Should cron-backed rows support restart/resume?
   - probably no in Phase 1
   - maybe only "Run Now" and "Reveal Cron Job"

## Recommended Implementation Notes

- Do not write cron data into `tasks.json` from Command Central.
  - `tasks.json` should remain launcher-owned.
- Do not bolt cron parsing into `CronTreeProvider`.
  - keep service/model logic reusable across views.
- Add explicit context values for cron-backed sidebar rows.
  - this keeps actions and icons clean.
- Cap or collapse high-frequency cron jobs.
  - otherwise 2-minute or 5-minute jobs will dominate history.

## Final Recommendation

Ship Phase 1 first.

That gives Command Central an immediately useful, low-risk answer to the current gap:

- scheduled work becomes visible in Agent Status
- completed cron runs are no longer invisible
- Cron Jobs and Agent Status become navigationally connected

Then solve live running cron correlation in Phase 2, when there is a reliable active-run/session identifier to merge against discovery.
