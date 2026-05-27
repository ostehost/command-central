# Agent Status Data Sources

Complete reference for every data source the Agent Status tree reads from.

## Task Registry (tasks.json)

### Schema

```json
{
  "version": 2,
  "tasks": {
    "<task-id>": {
      "id": "string",
      "status": "running | completed | completed_dirty | completed_stale | failed | stopped | killed | contract_failure",
      "started_at": "ISO-8601",
      "completed_at": "ISO-8601 | null",
      "updated_at": "ISO-8601",
      "project_dir": "/absolute/path",
      "agent_backend": "string (freeform — never assume a specific value)",
      "cli_name": "string (freeform)",
      "model": "string",
      "actual_model": "string | null",
      "terminal_backend": "tmux | persist | applescript",
      "tmux_session": "string | null",
      "tmux_socket": "string | null",
      "stream_file": "/tmp/backend-stream-id.jsonl | null",
      "pending_review_path": "/path/to/receipt.json | null",
      "pr_number": "number | null",
      "review_status": "pending | approved | changes_requested | null",
      "flow_id": "string | null",
      "session_id": "string | null",
      "prompt_file": "string | null",
      "bundle_path": "string | null",
      "handoff_file": "string | null",
      "artifact_paths": "string[] | null",
      "start_sha": "string | null",
      "end_commit": "string | null",
      "attempts": "number",
      "max_attempts": "number"
    }
  }
}
```

The full AgentTask interface has ~85 fields. The above covers the most commonly used ones. Both version 1 and version 2 are supported; default to version 2 when creating new registries.

### Resolution Chain

The extension resolves the tasks.json file path in strict priority order:

1. **`TASKS_FILE` environment variable** — if set and the file exists.
2. **`commandCentral.agentTasksFile` VS Code setting** — user-configured explicit path.
3. **Workspace-local** — `.ghostty-launcher/tasks.json` relative to each workspace folder.
4. **Global XDG** — `~/.config/ghostty-launcher/tasks.json`.
5. **Global simple** — `~/.ghostty-launcher/tasks.json`.

For CLI scripts that cannot read VS Code settings: use `--tasks-file`, then `TASKS_FILE` env, then workspace-local, then global paths. If a user has a custom VS Code setting, they must pass `--tasks-file` explicitly.

### Read-Only Registries

`commandCentral.agentTasksFiles` (array) provides additional read-only registry files for multi-node or mirrored launcher setups. These are merged into the tree view but never written to.

### Terminal Statuses (Clearable)

These statuses are in `CLEARABLE_AGENT_TASK_STATUSES` and can be removed by `clearCompletedAgents`:
`completed`, `completed_dirty`, `completed_stale`, `failed`, `stopped`, `killed`.

Note: `contract_failure` is a valid `AgentTaskStatus` but is **not** in the clearable set — it requires manual intervention.

### Active Statuses (Not Clearable)

`running` is the only active status. There are no `queued` or `pending` statuses in `AgentTaskStatus`.

## Pending-Review Receipts

### Location

Directory: `${CC_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}`

The `CC_PENDING_REVIEW_DIR` environment variable is the portable override. The default path is machine-specific.

### File Format

One JSON file per task: `<dir>/<task_id>.json`

All keys are **snake_case** (matching the launcher's output and the extension's parser):

```json
{
  "task_id": "string",
  "project": "string",
  "project_path": "/absolute/path",
  "status": "completed | failed | canceled",
  "exit_code": 0,
  "completed_at": "ISO-8601",
  "last_commit": "string | null",
  "end_commit": "string | null",
  "agent_commit": "string | null",
  "manager_commit": "string | null",
  "actual_model": "string | null",
  "agent_summary": "string | null",
  "files_changed": ["string"] | null,
  "review_state": "pending | reviewed | reviewing | awaiting_fixup | blocked",
  "reviewed": false,
  "reported_to_user": false
}
```

### Directory Structure

The pending-review store has subdirectories beyond the top-level active queue:

```
${CC_PENDING_REVIEW_DIR}/
  *.json                  # Active receipts (top-level)
  reviewed/               # Archived reviewed receipts (snapshots after mark-reviewed)
    <task_id>.json
  quarantined/            # Stale entries moved by pending_review_quarantine()
    <task_id>.json
```

A fresh-slate reset must back up the entire directory tree (including `reviewed/` and `quarantined/`), not just top-level `*.json` files.

### Purpose

Ground-truth overlay. The launcher's completion hook writes this receipt immediately on task completion — before tasks.json is updated. When tasks.json still reports `running` due to write lag, the receipt provides the real status.

### Cache Behavior

In-memory cache with 5-second TTL per task. The extension re-reads the receipt file after TTL expiry.

## Reviewed-Task Tracking

### Location

`~/.config/command-central/reviewed-tasks.json`

### Schema

```json
{
  "version": 1,
  "reviewed": ["task-id-1", "task-id-2"]
}
```

Ordered oldest-first. Capped at 500 entries; oldest are pruned when the cap is exceeded.

### Behavior

- `markReviewed(taskId)` adds a task ID and prunes if over 500.
- `isReviewed(taskId)` checks membership.
- Tasks marked reviewed get a "reviewed" badge in the tree.
- Write failures are silent (best-effort persistence).

## Stream JSONL Files

### Resolution Order

Per-task transcript files are resolved in order:

1. Explicit `task.stream_file` field from tasks.json.
2. `/tmp/{agent_backend}-stream-{task_id}.jsonl`
3. `/tmp/claude-stream-{task_id}.jsonl`
4. `/tmp/codex-stream-{task_id}.jsonl`
5. `/tmp/gemini-stream-{task_id}.jsonl`

### Liveness Signal

Stream file mtime is used as a liveness signal. Agents with no stream file update for 5 minutes (`DISCOVERY_IDLE_STREAM_THRESHOLD_MS = 300000`) are marked stale.

### Claude Code Sessions

Claude Code stores session transcripts at:
`~/.claude/projects/{escaped-path}/{session-id}.jsonl`

Where `{escaped-path}` replaces `/` with `-` (e.g., `-Users-name-projects-command-central`).

## OpenClaw Integration

### Tasks

- **CLI:** `openclaw tasks list --json`
- **Database:** `~/.openclaw/tasks/runs.sqlite`
- **Lookback:** 7 days
- **Timeout:** 5 seconds
- **Debounce:** 150ms on database file change
- **Statuses:** `queued`, `running`, `completed`, `failed`

### Flows

- **CLI:** `openclaw tasks flow list --json`
- **Same database** as tasks
- **Statuses:** `queued`, `running`, `waiting`, `completed`, `failed`

### Configuration

- **File:** `~/.openclaw/openclaw.json`
- Provides per-agent model and thinking defaults.
- Watched for changes; agents section is parsed for `OpenClawAgentModel` records.

### Availability

OpenClaw is optional. All code paths must check `command -v openclaw` (scripts) or handle CLI errors gracefully (extension). When unavailable, OpenClaw tree sections are omitted.

## Discovery

### Sources and Priority

The AgentRegistry merges four discovery sources (highest priority first):

1. **ACP sessions** — `openclaw tasks --runtime acp`
2. **Launcher tasks.json** — richest metadata
3. **SessionWatcher** — monitors `~/.claude/sessions/` for new/removed session files
4. **ProcessScanner** — polls `ps`/`lsof` at configurable interval

Higher-priority sources override lower-priority ones when the same agent is detected by multiple sources.

### Configuration

- `commandCentral.discovery.enabled` — boolean, default `true`. Controls whether discovery runs.
- `commandCentral.discovery.pollInterval` — number (ms), default 5000, minimum 2000. ProcessScanner poll interval.

### Key Distinction: Historical vs Live

**Historical state** lives in tasks.json, reviewed-tasks.json, and pending-review receipts. It persists across VS Code sessions and represents completed/archived work.

**Live state** comes from discovery (session watcher, process scanner, ACP). It reflects currently running agents and disappears when agents stop.

When resetting or debugging Agent Status, always distinguish these two categories. A fresh-slate reset clears historical state. Live discovery may re-populate the tree immediately with running agents — this is correct behavior, not a reset failure.

## Safety Rules

### Backup and Move, Never Blind-Delete

When clearing or resetting Agent Status state:

1. **Always back up** before modifying. Move files into a timestamped backup directory.
2. **Never delete blindly** — `rm -rf` on task data is not acceptable.
3. **Never kill live sessions** unless explicitly asked. A reset clears history, not running agents.
4. **Recreate scaffolds** after moving: `{"version":2,"tasks":{}}` for tasks.json, `{"version":1,"reviewed":[]}` for reviewed-tasks.json.
5. **Print rollback instructions** — the backup path and how to restore.
6. **Refuse if running tasks exist** unless the user explicitly forces it. Running tasks in tasks.json represent active work.
7. **Never write VS Code settings.json** from scripts. Discovery is controlled via the VS Code configuration API or Settings UI.
