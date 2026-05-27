---
name: command-central-vscode-extension
description: "Use for Command Central VS Code extension work — Agent Status tree changes, TreeDataProvider behavior, launcher tasks.json registries, pending-review receipts, OpenClaw tasks/flows, discovery, fresh-slate resets, integration/VSIX tests, and model- or agent-agnostic implementation/debugging."
---

# Command Central VS Code Extension

## Overview

Command Central is a VS Code extension that surfaces agent orchestration state — launcher tasks, pending reviews, OpenClaw tasks/flows, and live discovery — in a unified Agent Status sidebar tree. This skill guides changes to the extension: tree provider logic, data source integration, testing, and operational scripts.

## Before You Start

Ground yourself in the current repo state before modifying any feature:

1. Read `package.json` `contributes` section for registered commands, views, configuration, menus, and keybindings.
2. Check `src/extension.ts` for command wiring — `registerCommand` calls and their handler imports.
3. Identify the provider or service you are changing:
   - `src/providers/` — TreeDataProviders (AgentStatusTreeProvider), WebviewProviders
   - `src/services/` — OpenClawTaskService, TaskFlowService, OpenClawConfigService, ReviewTracker, AcpSessionService, SessionStore, etc.
   - `src/utils/` — pending-review-probe, review-queue-health, tasks-file-resolver, agent-task-registry, etc.
4. Run `just test-unit` for a fast sanity check (~0.5s, 450+ tests).
5. Use `rg` or `grep` to find all references to the symbol or feature you are touching.
6. Check `src/types/` for relevant TypeScript interfaces — especially `AgentTask` (85+ fields).

## Agent and Model Neutrality

Command Central is agent-backend agnostic. Never hard-code assumptions about Claude, Codex, Gemini, or any specific model unless the existing code path already checks `agent_backend` or `cli_name` for backend-specific behavior.

Concrete rules:

- `agent_backend` in tasks.json accepts arbitrary strings — treat it as opaque.
- `cli_name` is freeform (e.g., "claude", "codex", "gemini", or custom names).
- Stream file convention is `/tmp/{backend}-stream-{task_id}.jsonl` — the backend prefix varies per agent.
- Discovery scans for any agent process, not a specific one.
- When adding features, test with at least two different `agent_backend` values in fixture data.
- Icon/label logic that branches on `agent_backend` must always include a sensible default for unknown backends.

## Extension Architecture

### TreeDataProvider Refresh

The Agent Status tree uses `vscode.EventEmitter<AgentNode | undefined | null>`:

- `scheduleTreeRefresh()` with no argument schedules a full tree rebuild.
- `scheduleTreeRefresh(element)` schedules a targeted refresh of a specific `AgentNode`.
- Refresh requests are coalesced — multiple calls within the same tick are batched, and a pending global refresh clears any element-level refreshes.
- The actual `_onDidChangeTreeData.fire()` is dispatched via `setTimeout(0)` to avoid re-entrant tree updates.
- Never call `scheduleTreeRefresh()` from within `getChildren()` or `getTreeItem()` — it causes infinite loops.
- The provider caches tree state internally; invalidate caches before scheduling refresh events.

### Command Registration and Wiring

Commands are registered in `src/extension.ts` via `vscode.commands.registerCommand()`:

- Each command must be listed in `package.json` `contributes.commands`.
- Handlers use dynamic `import()` for lazy loading — keeps activation fast.
- To add a command: declare in `package.json`, register in `extension.ts`, implement in `src/commands/`.
- Menu items and keybindings reference commands by ID in `package.json` `contributes.menus` and `contributes.keybindings`.

### File Watchers

- Use `vscode.workspace.createFileSystemWatcher()` for workspace-relative paths.
- Use `fs.watch()` / `fs.watchFile()` for absolute paths outside the workspace (e.g., tasks.json, OpenClaw database).
- Always debounce watcher callbacks (typically 150–500ms).
- Always dispose watchers in `deactivate()` or via `context.subscriptions`.
- Never watch broad globs like `**/*` — watch specific directories or file patterns.
- OpenClawTaskService watches the `~/.openclaw/tasks/` directory via `fs.watch` with 150ms debounce.

### Context Keys

- Set via `vscode.commands.executeCommand('setContext', key, value)`.
- Used in `package.json` `when` clauses for conditional menu items and view visibility.
- Prefix all keys with `commandCentral.` to avoid collisions.

## Agent Status Data Model

### Task Registry Resolution

The extension resolves `tasks.json` in this priority order:

1. `TASKS_FILE` environment variable (if file exists)
2. `commandCentral.agentTasksFile` VS Code setting
3. Workspace-local: `.ghostty-launcher/tasks.json` (per workspace folder)
4. Global XDG: `~/.config/ghostty-launcher/tasks.json`
5. Global simple: `~/.ghostty-launcher/tasks.json`

Additionally, `commandCentral.agentTasksFiles` provides read-only registry files for multi-node or mirrored launchers.

Schema: `{"version": 2, "tasks": {"<id>": <AgentTask>}}`. Versions 1 and 2 are both supported; default to 2 when creating.

### Pending-Review Receipts

Written to `${CC_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}/<task_id>.json` by the launcher's completion hook (`oste-complete.sh`). These are ground-truth overlays when tasks.json still reports `running` due to write race conditions. The `CC_PENDING_REVIEW_DIR` environment variable is the portable override. Cache TTL: 5 seconds per task.

### Reviewed-Task Tracking

Stored at `~/.config/command-central/reviewed-tasks.json`. Schema: `{"version": 1, "reviewed": ["<task_id>", ...]}`. Capped at 500 entries; oldest pruned first.

### Discovery Priority

The AgentRegistry merges four sources with descending priority:

1. **ACP sessions** — `openclaw tasks --runtime acp` (highest priority)
2. **Launcher tasks.json** — richest metadata
3. **SessionWatcher** — monitors `~/.claude/sessions/` directory
4. **ProcessScanner** — `ps`/`lsof` polling (lowest priority)

Controlled by `commandCentral.discovery.enabled` (default: `true`) with configurable poll interval `commandCentral.discovery.pollInterval` (default: 5000ms, min: 2000ms). Agents are marked stale after 5 minutes with no stream file update.

### Stream JSONL Files

Per-task transcript files resolved in order:

1. Explicit `task.stream_file` field from tasks.json
2. `/tmp/{agent_backend}-stream-{task_id}.jsonl`
3. `/tmp/claude-stream-{task_id}.jsonl` (fallback)
4. `/tmp/codex-stream-{task_id}.jsonl` (fallback)
5. `/tmp/gemini-stream-{task_id}.jsonl` (fallback)

Stream file mtime is the liveness signal — agents are marked stale after 5 minutes of inactivity.

### OpenClaw Integration

- **Tasks:** `openclaw tasks list --json` reads from `~/.openclaw/tasks/runs.sqlite`.
- **Flows:** `openclaw tasks flow list --json` from the same database.
- **Config:** `~/.openclaw/openclaw.json` provides per-agent model and thinking defaults.
- OpenClaw may not be installed — all code paths must handle its absence gracefully.

## Testing Strategy

### Fast Feedback Loop

1. `just test-unit` — ~0.5s, 450+ unit tests. Run after every change.
2. `bun test test/tree-view/` — focused tree provider tests.
3. `bun test <specific-file>` — single test file for targeted work.

### Full Validation

4. `just test` — full suite including typecheck (~5s).
5. `just test-validate` — ensures no orphaned tests (all tests in partitions).
6. `just check` — biome lint + typecheck + knip.
7. `just ready` — fix + check + test (one-shot pre-push gate).

### Proving the Extension Works

8. `just test-integration` — integration tests + discovery E2E.
9. Installed-VSIX proof suite: build with `just dist`, install with `code --install-extension`, run `just test-installed-vsix-agent-status`.
10. If Computer Use or browser automation is available, verify visible VS Code sidebar state directly. Otherwise rely on integration-test API snapshots and the installed-VSIX proof suite.

### Pre-Release

11. `just prerelease-gate` — cross-repo smoke before release builds.

## Scripts

Two operational scripts in `scripts/`:

- **`agent_status_audit.sh`** — Read-only audit of all Agent Status data sources. Reports task counts by status, pending-review state, reviewed-task count, stream files, OpenClaw status, and best-effort discovery setting. Use `--json` for machine-readable output. Requires `jq`.

- **`fresh_slate_reset.sh`** — Backup-first reset of Agent Status historical state. Dry-run by default; requires `--apply` for mutation. Never kills processes. Never edits VS Code settings. Moves historical data into a timestamped backup directory and recreates empty scaffolds. Requires `jq`.

Run `<script> --help` for full interface documentation.

## References

- **`references/agent-status-sources.md`** — Detailed data model for all Agent Status sources, schemas, file formats, and the backup/move/never-blind-delete rules.
- **`references/commands-and-tests.md`** — Full command reference, test strategies, and when to use each validation approach.
- **`references/vscode-extension-patterns.md`** — Extension contribution patterns, command wiring, provider/service architecture, and integration-test patterns.
