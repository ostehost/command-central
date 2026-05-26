# SPEC: Agent Status Reset — Fresh Slate (Backup-First)

**Task ID:** `cc-agent-status-reset-confirm-20260526-1856`
**Date:** 2026-05-26
**Role:** Planner / research confirmation
**Author:** Claude (planner), requested by Mike via Oste

---

## 1. Problem Statement

Command Central's Agent Status tree accumulates historical task data across
multiple data stores. After extended use, the tree shows 274 tasks (current
count in `tasks.json`), with 187 completed, 53 failed, 20 killed, 13
contract failures, and 1 running. The pending-review directory holds 22 active
receipts, 19 reviewed, and 10 quarantined.

Mike wants a "fresh slate" — a clean Agent Status tree showing only newly
spawned agents — without permanently losing historical data. The approach
must **move** data to a timestamped backup rather than deleting it.

---

## 2. Data Source Inventory

Every data source that Agent Status reads, merges, or displays, with evidence.

### 2.1. Launcher Task Registry — `tasks.json`

| Attribute | Value |
|-----------|-------|
| **Path** | `~/.config/ghostty-launcher/tasks.json` (779 KB, 274 tasks) |
| **Resolver** | `src/utils/tasks-file-resolver.ts:14-19` — auto-detect candidates |
| **Reader** | `src/providers/agent-status-tree-provider.ts:3147-3186` — `readRegistry()` |
| **Parser** | `src/utils/agent-task-registry.ts:18-28` — `parseTaskRegistry()` |
| **Merger** | `src/providers/agent-status-tree-provider.ts:3157-3170` — multi-registry merge |
| **Writer** | `src/extension.ts:1527-1570` — read-mutate-reread-backup-write pattern |
| **Backup pattern** | `.bak` created before every write (`src/extension.ts:1533`) |
| **Existing backups** | `tasks.json.pre-reap-20260412-184637.bak` (195 KB), `tasks.json.review-cleanup-20260526T184658.bak` (1 MB) |
| **Schema** | `{ version: 2, tasks: Record<string, AgentTask> }` |

**Verdict: MOVE.** This is the primary historical data store. All 274 entries represent completed/terminal work.

### 2.2. Pending-Review Receipts — `/tmp/oste-pending-review/`

| Attribute | Value |
|-----------|-------|
| **Path** | `/tmp/oste-pending-review/` (override: `CC_PENDING_REVIEW_DIR` env var) |
| **Active** | 22 JSON receipt files |
| **Reviewed** | `/tmp/oste-pending-review/reviewed/` (19 files) |
| **Quarantined** | `/tmp/oste-pending-review/quarantined/` (10 files) |
| **Reader** | `src/utils/pending-review-probe.ts:55-73` — `readPendingReviewReceipt()` |
| **Status tier** | Tier 1b in display hierarchy (`src/providers/agent-status-tree-provider.ts:2067-2078`) |
| **Schema** | `PendingReviewReceipt` — status, exitCode, completedAt, commits, agentSummary, filesChanged |
| **Writer** | External — launcher's `oste-complete.sh` |

**Verdict: MOVE.** These are completion signals for historical tasks. New agent completions will create new receipts.

### 2.3. CC Local State — Review Tracker

| Attribute | Value |
|-----------|-------|
| **Path** | `~/.config/command-central/reviewed-tasks.json` |
| **Reader** | `src/services/review-tracker.ts:77-96` |
| **Writer** | `src/services/review-tracker.ts:55-66` |
| **Size** | Currently 0 reviewed entries |
| **Cap** | 500 entries, oldest pruned |
| **Schema** | `{ version: 1, reviewed: string[] }` |

**Verdict: MOVE (or skip — currently empty).** Contains task IDs that have been
reviewed. If tasks.json is reset, these orphan IDs are harmless but useless.

### 2.4. CC Local State — Session Store

| Attribute | Value |
|-----------|-------|
| **Path** | `~/.config/command-central/sessions.json` |
| **Reader** | `src/services/session-store.ts:103-116` |
| **Writer** | `src/services/session-store.ts:90-96` |
| **Size** | ~40 KB |
| **TTL** | 30-day auto-prune |
| **Schema** | `{ version: 1, sessions: Record<string, SessionEntry> }` |

**Verdict: DO NOT MOVE by default.** This maps project directories to Ghostty
bundles. It is not task data — it enables focus-to-terminal for future agents too.
Moving it would degrade UX with no benefit. See Section 4 for optional inclusion.

### 2.5. JSONL Stream Files

| Attribute | Value |
|-----------|-------|
| **Path** | `/tmp/codex-stream-*.jsonl` and per-task `stream_file` paths |
| **Reader** | `src/providers/agent-status-tree-provider.ts:2195-2254` — `getStreamTerminalState()` |
| **Resolver** | `src/providers/agent-status-tree-provider.ts:8361-8380` — `resolveStreamFilePath()` |
| **Status tier** | Tier 2b in display hierarchy |
| **Current count** | 5 files on disk (all for review-type tasks) |

**Verdict: MOVE.** Historical stream data. New tasks will create new streams.
These are ephemeral `/tmp` files that OS reboot would remove anyway.

### 2.6. Launcher Staleness Cache (In-Memory)

| Attribute | Value |
|-----------|-------|
| **Location** | `src/providers/agent-status-tree-provider.ts:1321` — `staleTaskReasons: Map<string, string>` |
| **Persistence** | None — in-memory only, cleared on extension reload |
| **Status tier** | Tier 2a |

**Verdict: NO ACTION NEEDED.** Cleared automatically when the extension reloads
after tasks.json changes. The file watcher triggers a tree refresh.

### 2.7. tmux / Persist Session Health (Live Discovery)

| Attribute | Value |
|-----------|-------|
| **tmux check** | `src/providers/agent-status-tree-provider.ts:1770-1900` — `isTmuxSessionAlive()`, `isTmuxWindowAlive()` |
| **Persist check** | `src/utils/persist-health.ts:4-15` — socket existence |
| **Pane evidence** | `src/utils/tmux-pane-health.ts:69-180` — pgrep/BFS process tree |
| **Caches** | `_tmuxSessionHealthCache`, `_tmuxPaneAgentCache`, `_tmuxPaneAgentEvidenceCache`, `_persistSessionHealthCache` |

**Verdict: NO ACTION NEEDED.** These are live runtime probes, not historical data.
After reset, any running tmux sessions are still live and should still be discoverable.

### 2.8. Agent Registry — Process Discovery

| Attribute | Value |
|-----------|-------|
| **Registry** | `src/discovery/agent-registry.ts` — merges 4 sources |
| **Sources** | ACP sessions, launcher tasks, SessionWatcher (`~/.claude/sessions/`), ProcessScanner (`ps`) |
| **Session files** | `~/.claude/sessions/<PID>.json` — 23 files currently |
| **Dedup** | `isSuppressedByLauncherTask()` — PID, sessionId, or projectDir matching |

**Verdict: DO NOT MOVE.** Session files are Claude Code-owned (written by running
Claude Code processes). ProcessScanner reads live `ps` output. These are
**live discovery** sources, not historical data.

### 2.9. OpenClaw Tasks — `openclaw` CLI

| Attribute | Value |
|-----------|-------|
| **Database** | `~/.openclaw/tasks/runs.sqlite` (53 KB) |
| **CLI calls** | `openclaw tasks list --json`, `openclaw tasks flow list --json` |
| **Services** | `src/services/openclaw-task-service.ts:39`, `src/services/acp-session-service.ts:46`, `src/services/taskflow-service.ts:39` |
| **Watcher** | fs.watch on `~/.openclaw/tasks/` directory |
| **Integration** | CodexRunObserverService projects into CodexRunView (`src/services/codex-run-observer-service.ts:118-146`) |

**Verdict: DO NOT MOVE.** OpenClaw owns this data. CC reads it through the CLI.
Resetting it requires OpenClaw's own tools, and doing so would affect all OpenClaw
consumers, not just CC Agent Status.

### 2.10. OpenClaw Config & Cron

| Attribute | Value |
|-----------|-------|
| **Config** | `~/.openclaw/openclaw.json` — model/thinking defaults |
| **Cron** | `~/.openclaw/cron/jobs.json` — scheduled jobs |
| **Services** | `src/services/openclaw-config-service.ts:45`, `src/services/cron-service.ts:20` |

**Verdict: DO NOT MOVE.** Configuration and active job definitions. Not task history.

### 2.11. Launcher Supplementary Files

| Attribute | Value |
|-----------|-------|
| **Spawn scripts** | `~/.config/ghostty-launcher/pending/*.spawn.sh` (20 files) |
| **Tokens** | `~/.config/ghostty-launcher/tokens/` |
| **Boot ID** | `~/.config/ghostty-launcher/tasks.json.last-boot-id` |
| **Watchdog log** | `~/.config/ghostty-launcher/watchdog.log` |

**Verdict:**
- `pending/*.spawn.sh` — **DO NOT MOVE** by default. These are reusable spawn templates. See Section 4.
- `tokens/` — **NEVER MOVE.** Credentials.
- `last-boot-id` — **DO NOT MOVE.** Boot tracking, not task data.
- `watchdog.log` — **OPTIONAL MOVE.** Low risk, logs only.

### 2.12. VS Code Extension State (globalState / workspaceState)

| Key | Location | Purpose |
|-----|----------|---------|
| `commandCentral.hasActivatedBefore` | `src/extension.ts:235` | First-run flag |
| `commandCentral.whatsNewVersion` | `src/extension.ts:246` | What's New shown version |
| `commandCentral.groupingViewVisible` | `src/ui/grouping-view-manager.ts:98` | View toggle |
| `commandCentral.extensionFilter.visible` | `src/providers/extension-filter-view-manager.ts:85` | View toggle |
| `INSTALLED_TAG_KEY` | `src/ghostty/BinaryManager.ts:182` | Ghostty installed version |
| `AUTO_DETECTED_LAUNCHER_PATH_KEY` | `src/ghostty/TerminalManager.ts:573` | Launcher path cache |
| `commandCentral.agentStatusSettings.migrationVersion` | `src/utils/agent-status-settings-migration.ts:66` | Migration tracker |
| Extension filter state | `src/services/extension-filter-state.ts:48` | Per-workspace filters |

**Verdict: DO NOT MOVE.** These are UI preferences and extension metadata, not
agent task data. Clearing them would force the user to re-configure UI state.

### 2.13. Existing Backup Files

| File | Size |
|------|------|
| `tasks.json.pre-reap-20260412-184637.bak` | 195 KB |
| `tasks.json.review-cleanup-20260526T184658.bak` | 1 MB |

**Verdict: MOVE.** Stale backups from prior operations should go to the same
backup location to keep the launcher directory clean.

---

## 3. Proposed Backup-First Reset Procedure

### 3.1. Backup Directory

```
~/.config/ghostty-launcher/backups/fresh-slate-YYYYMMDD-HHMMSS/
```

Example: `~/.config/ghostty-launcher/backups/fresh-slate-20260526-190000/`

**Rationale:** Colocated with the launcher directory. Not in `/tmp` (survives reboot).
Timestamped to allow multiple resets without collision. The `backups/` parent
provides a clean namespace for future backup types.

### 3.2. Files to Move

| # | Source | Destination (relative to backup dir) | Required? |
|---|--------|--------------------------------------|-----------|
| 1 | `~/.config/ghostty-launcher/tasks.json` | `tasks.json` | **YES** |
| 2 | `~/.config/ghostty-launcher/tasks.json.*.bak` | `tasks.json.*.bak` (all) | YES |
| 3 | `/tmp/oste-pending-review/*.json` | `pending-review/` | YES |
| 4 | `/tmp/oste-pending-review/reviewed/` | `pending-review/reviewed/` | YES |
| 5 | `/tmp/oste-pending-review/quarantined/` | `pending-review/quarantined/` | YES |
| 6 | `~/.config/command-central/reviewed-tasks.json` | `cc-state/reviewed-tasks.json` | YES |
| 7 | `/tmp/codex-stream-*.jsonl` | `streams/` | OPTIONAL |
| 8 | `~/.config/ghostty-launcher/watchdog.log` | `watchdog.log` | OPTIONAL |

### 3.3. Files to Recreate (Empty)

After moving, these empty scaffolds must exist for the launcher and extension to
operate correctly:

| File | Content |
|------|---------|
| `~/.config/ghostty-launcher/tasks.json` | `{"version":2,"tasks":{}}` + newline |
| `~/.config/command-central/reviewed-tasks.json` | `{"version":1,"reviewed":[]}` |

The `/tmp/oste-pending-review/` directory does NOT need to be recreated — the
launcher's `oste-complete.sh` creates it on demand (`pending-review-probe.ts:22`
uses `resolveDefaultDir()` which just checks `process.env`).

### 3.4. Example Commands

```bash
# === Variables ===
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$HOME/.config/ghostty-launcher/backups/fresh-slate-${TS}"
LAUNCHER_DIR="$HOME/.config/ghostty-launcher"
PENDING_DIR="/tmp/oste-pending-review"
CC_DIR="$HOME/.config/command-central"

# === Step 1: Create backup directory ===
mkdir -p "${BACKUP_DIR}/pending-review" "${BACKUP_DIR}/cc-state" "${BACKUP_DIR}/streams"

# === Step 2: Move launcher task data ===
mv "${LAUNCHER_DIR}/tasks.json" "${BACKUP_DIR}/tasks.json"
# Move all existing backup files
for bak in "${LAUNCHER_DIR}"/tasks.json.*.bak; do
  [ -f "$bak" ] && mv "$bak" "${BACKUP_DIR}/"
done
# Optional: move watchdog log
mv "${LAUNCHER_DIR}/watchdog.log" "${BACKUP_DIR}/watchdog.log" 2>/dev/null || true

# === Step 3: Move pending-review receipts ===
mv "${PENDING_DIR}"/*.json "${BACKUP_DIR}/pending-review/" 2>/dev/null || true
# Move subdirectories (reviewed, quarantined)
[ -d "${PENDING_DIR}/reviewed" ] && mv "${PENDING_DIR}/reviewed" "${BACKUP_DIR}/pending-review/"
[ -d "${PENDING_DIR}/quarantined" ] && mv "${PENDING_DIR}/quarantined" "${BACKUP_DIR}/pending-review/"

# === Step 4: Move CC local state ===
[ -f "${CC_DIR}/reviewed-tasks.json" ] && mv "${CC_DIR}/reviewed-tasks.json" "${BACKUP_DIR}/cc-state/"

# === Step 5: Optional — move JSONL streams ===
mv /tmp/codex-stream-*.jsonl "${BACKUP_DIR}/streams/" 2>/dev/null || true

# === Step 6: Recreate empty scaffolds ===
echo '{"version":2,"tasks":{}}' > "${LAUNCHER_DIR}/tasks.json"
echo '{"version":1,"reviewed":[]}' > "${CC_DIR}/reviewed-tasks.json"

# === Step 7: Trigger CC reload ===
# The file watcher on tasks.json fires automatically (debounced 150ms).
# In-memory caches (staleness, tmux health, diff summary) are cleared
# on tree rebuild. No manual extension reload required.

echo "✓ Fresh slate created. Backup at: ${BACKUP_DIR}"
echo "  Tasks backed up: $(python3 -c \"import json; d=json.load(open('${BACKUP_DIR}/tasks.json')); print(len(d.get('tasks',{})))\")"
```

### 3.5. Rollback Commands

```bash
# === Full rollback ===
TS="20260526-190000"  # adjust to actual timestamp
BACKUP_DIR="$HOME/.config/ghostty-launcher/backups/fresh-slate-${TS}"

# Restore tasks.json (overwrites the empty one)
cp "${BACKUP_DIR}/tasks.json" "$HOME/.config/ghostty-launcher/tasks.json"

# Restore pending-review receipts
cp "${BACKUP_DIR}/pending-review/"*.json /tmp/oste-pending-review/ 2>/dev/null || true
[ -d "${BACKUP_DIR}/pending-review/reviewed" ] && cp -r "${BACKUP_DIR}/pending-review/reviewed" /tmp/oste-pending-review/
[ -d "${BACKUP_DIR}/pending-review/quarantined" ] && cp -r "${BACKUP_DIR}/pending-review/quarantined" /tmp/oste-pending-review/

# Restore CC state
[ -f "${BACKUP_DIR}/cc-state/reviewed-tasks.json" ] && cp "${BACKUP_DIR}/cc-state/reviewed-tasks.json" "$HOME/.config/command-central/"

# Note: use cp, not mv, so the backup dir remains intact as a safety net.
# CC's file watcher will pick up the restored tasks.json automatically.
```

---

## 4. Data That Should NOT Be Moved by Default

### 4.1. Never Move (Critical / External Systems)

| Data | Owner | Why |
|------|-------|-----|
| `~/.config/ghostty-launcher/tokens/` | Launcher | API credentials. Moving = auth failure. |
| `~/.claude/sessions/*.json` | Claude Code | Active PID session files. CC reads but does not own. Moving = breaking running agents. |
| `~/.openclaw/tasks/runs.sqlite` | OpenClaw | CC reads via CLI. Moving breaks OpenClaw for all consumers. |
| `~/.openclaw/openclaw.json` | OpenClaw | Configuration, not task data. |
| `~/.openclaw/cron/jobs.json` | OpenClaw | Active cron job definitions. |
| VS Code globalState keys | VS Code | UI preferences and extension metadata. Clearing requires `context.globalState.update()` calls, not file moves. |
| `~/.config/ghostty-launcher/tasks.json.last-boot-id` | Launcher | Boot-cycle tracking. Moving could confuse the launcher's reap-on-boot logic. |

### 4.2. Risky Optional Steps

**WARNING: Pending spawn scripts**

| Data | Path | Risk |
|------|------|------|
| Spawn scripts | `~/.config/ghostty-launcher/pending/*.spawn.sh` | These are reusable agent spawn templates (20 files). Moving them removes the ability to re-launch agents via launcher. However, they reference old task IDs and project states, so they may be stale. |

If the user wants a truly clean launcher state, these can be moved:
```bash
# OPTIONAL — RISKY: move spawn templates
mkdir -p "${BACKUP_DIR}/pending"
mv "${LAUNCHER_DIR}/pending/"*.spawn.sh "${BACKUP_DIR}/pending/" 2>/dev/null || true
```

**WARNING: Session store**

| Data | Path | Risk |
|------|------|------|
| Session store | `~/.config/command-central/sessions.json` | Maps project dirs to Ghostty bundles. Moving it means newly discovered agents can't be focused-to-terminal until the mapping rebuilds. Low risk but degraded UX. |

```bash
# OPTIONAL — LOW RISK: move session store
mv "${CC_DIR}/sessions.json" "${BACKUP_DIR}/cc-state/" 2>/dev/null || true
echo '{"version":1,"sessions":{}}' > "${CC_DIR}/sessions.json"
```

---

## 5. Verification Steps After Reset

### 5.1. Immediate (Within 1 Second)

1. **tasks.json watcher fires:** CC's native `fs.watch` on tasks.json detects the
   file change (debounce: 150ms — `src/providers/agent-status-tree-provider.ts:1721`).
   The tree provider calls `readRegistry()` which reads the empty `{"version":2,"tasks":{}}`.

2. **Agent Status tree empties:** `getChildren()` returns no launcher task nodes.
   The tree should show only the discovery section (if any running processes exist)
   and the OpenClaw/Codex Run section (if OpenClaw has data — this is unaffected
   by the reset).

3. **In-memory caches stale but harmless:** `staleTaskReasons`, `previousStatuses`,
   `_diffSummaryCache` etc. reference task IDs that no longer exist in the registry.
   The next tree rebuild drops them because `toDisplayTask()` only processes tasks
   present in the registry.

### 5.2. After Extension Reload (Optional, But Clean)

Run `Developer: Reload Window` in VS Code to clear all in-memory caches:
- `_tmuxSessionHealthCache`, `_tmuxPaneAgentCache`, `_tmuxPaneAgentEvidenceCache`
- `_handoffFileCache`, `_reviewQueueCache`, `_persistSessionHealthCache`
- `pendingReviewProbe` module-level cache (`src/utils/pending-review-probe.ts:47`)
- `staleTaskReasons`, `previousStatuses`, `previousStuckStates`

This is not required but produces the cleanest state.

### 5.3. Expected Agent Status Tree State

```
Agent Status (empty — no tasks)
├── (No launcher tasks)
├── Discovered Agents (if any running processes exist)
│   └── <any currently running Claude/Codex processes>
└── Codex Runs (OpenClaw data — unaffected by reset)
    └── <any recent OpenClaw tasks>
```

### 5.4. Launcher Health

- The launcher reads `tasks.json` to register new tasks. An empty `{"version":2,"tasks":{}}` is a valid registry.
- The `last-boot-id` file is preserved, so boot-cycle tracking continues.
- The `tokens/` directory is preserved, so auth continues working.
- New `oste-spawn.sh` invocations will create entries in the fresh `tasks.json`.

**NIT:** If the launcher has an in-memory copy of the registry, it may not
pick up the reset until its next read cycle or restart. This is harmless —
newly spawned tasks write to the file, and concurrent-write logic in
`src/extension.ts:1527-1570` handles this gracefully.

### 5.5. New Agent Appearance

When a new agent is spawned after reset:
1. Launcher writes a new entry to `tasks.json`
2. CC file watcher detects the change (150ms debounce)
3. `readRegistry()` parses the new entry
4. `toDisplayTask()` applies the status hierarchy
5. Tree renders the new agent in the Agent Status view
6. On completion, `oste-complete.sh` writes a new receipt to `/tmp/oste-pending-review/`

This is identical to normal operation. No special handling needed post-reset.

---

## 6. Risk Assessment

### BLOCKER: None

There are no blockers for the backup-first reset approach. The procedure is
inherently safe because:
- All data is moved, never deleted
- Rollback is a simple copy
- The launcher and extension both handle empty registries gracefully
- File watchers trigger automatic UI updates

### WARNING: Running Agents During Reset

**Severity: WARNING**

If agents are currently running when the reset executes:
- Their entries in `tasks.json` will be moved to backup
- The agents continue running (tmux/process are unaffected)
- CC's process discovery (`AgentRegistry`) will re-discover them as "discovered agents"
- When they complete, `oste-complete.sh` will write a receipt to `/tmp/oste-pending-review/`
- BUT: the launcher's completion hook may try to update `tasks.json` with a
  task ID that no longer exists, potentially re-creating that one entry

**Mitigation:** Run the reset only when no agents are actively running, or
accept that running agents may re-appear in the fresh registry upon completion.

### WARNING: `/tmp` Ephemerality

**Severity: WARNING**

Pending-review receipts and JSONL streams live in `/tmp`. On macOS, `/tmp` is
periodically cleaned (though not on reboot — macOS uses `/private/tmp` which
persists across reboots but is cleaned by periodic maintenance). If the user
waits too long after reset, old receipts in `/tmp` may already be gone.

**Mitigation:** Run the reset as a single atomic script. The backup captures
the current state regardless of future `/tmp` cleanup.

### NIT: OpenClaw History Remains Visible

**Severity: NIT**

The Codex Run / OpenClaw section of Agent Status is unaffected by this reset
because it reads from `~/.openclaw/tasks/runs.sqlite` via CLI. Users who want
a truly empty tree would need to also clear OpenClaw history, which is out of
scope for this procedure.

### DOC-CONFLICT: `clearCompletedAgents` vs. Fresh Slate

**Severity: NIT**

CC already has a `commandCentral.clearCompletedAgents` command
(`src/extension.ts:2301`, `src/utils/agent-task-registry.ts:65-83`) that
removes terminal-status tasks from `tasks.json`. This is a softer version
of the fresh slate — it preserves running tasks but removes completed/failed/
killed/stopped entries. The fresh slate differs in that it:
1. Also clears pending-review receipts
2. Also clears CC local state (reviewed-tasks)
3. Backs up data instead of deleting entries
4. Removes ALL tasks (including running, if any)

These are complementary operations, not conflicting ones.

---

## 7. Implementation Recommendation

### Should This Be a Command, Script, or Manual Ops?

**Recommendation: Launcher command (`oste-fresh-slate` or `launcher reset --backup`)**

**Justification:**

1. **Not a CC extension command.** The extension runs inside VS Code and
   manipulates `tasks.json` through its read-mutate-write pattern. A "reset"
   that moves files on disk and recreates them is a filesystem operation,
   not a tree data provider concern. Adding it to the extension would require
   handling edge cases with file watchers reacting to the mid-reset state.

2. **Not a one-off script.** Mike will likely want to reset again. The procedure
   has enough steps (8 files/directories, scaffolding, verification) that a
   repeatable tool is warranted.

3. **A launcher command is the natural owner.** The launcher owns `tasks.json`,
   the `pending/` directory, spawn scripts, and the completion hooks. It already
   has infrastructure for backup files (`.bak` pattern). A `launcher reset
   --backup` subcommand (or `oste-fresh-slate` script in the launcher's bin)
   would:
   - Know all the paths it owns
   - Refuse to run if agents are active (check tmux sessions)
   - Create the backup directory
   - Move files atomically
   - Recreate scaffolds
   - Print a verification summary
   - Optionally accept `--include-spawn-scripts` and `--include-streams` flags

4. **CC should add a "Reload Registry" command** (if one doesn't exist) as a
   complement — a lightweight VS Code command that re-reads `tasks.json` and
   clears all in-memory caches without requiring a window reload. This is a
   smaller, extension-appropriate concern.

### Implementation Owner

| Step | Owner |
|------|-------|
| Launcher `reset --backup` command | Ghostty Launcher repo |
| CC in-memory cache clear on registry reload | Command Central repo |
| Documentation of the procedure | Launcher repo (with CC cross-reference) |

### Estimated Effort

- Launcher command: ~2 hours (paths are well-known, backup/scaffold logic is straightforward)
- CC cache-clear enhancement: ~30 minutes (fire `_onDidChangeTreeData` with full cache purge)
- Testing: ~1 hour (verify fresh slate → spawn new agent → appears in tree)

---

## 8. Summary

| Question | Answer |
|----------|--------|
| Is backup-first reset safe? | **Yes.** All data is moved, never deleted. Rollback is a copy operation. |
| What gets moved? | `tasks.json`, existing `.bak` files, pending-review receipts (active + reviewed + quarantined), CC reviewed-tasks state, optionally JSONL streams and watchdog log. |
| What stays? | Claude sessions, OpenClaw data, launcher tokens, spawn scripts, boot ID, VS Code globalState, session store. |
| Who owns the implementation? | Launcher repo (primary), CC repo (cache-clear complement). |
| Any blockers? | **None.** The procedure can be run manually today with the commands in Section 3.4. |
| Pre-requisites before implementation? | Confirm no agents are running. Mike/Oste agreement on whether spawn scripts should be included by default. |

---

SPEC COMPLETE
