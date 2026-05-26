# Dogfood Audit: Agent Status Launch Visibility

**Task ID:** `cc-dogfood-agent-status-20260525-2008`
**Host:** Mike MacBook Pro (Mike's MacBook Pro)
**Repo:** command-central @ `/Users/ostehost/projects/command-central`
**Branch:** main
**Model:** claude-opus-4-7

---

## What Command Central Should Show for This Lane

In the Agent Status tree view, this task should render as:

| Field | Expected Value |
|-------|---------------|
| **Label** | `[project-icon] [role-icon] cc-dogfood-agent-status-20260525-2008` |
| **Status icon** | Green play (running) |
| **Description** | `opus · [activity] · [surface-tag] · 🔗 103adcc6` |
| **Tooltip** | Full detail: model, started_at, runtime breadcrumb, resume target |
| **Lifecycle** | running → completed (on exit with handoff + report) |
| **Changed files** | Diff from `start_sha` (2f5de21a) to `end_commit` once completed |

## Data Sources Reporting This Task

### 1. Launcher tasks.json (PRIMARY)

**Path:** `~/.config/ghostty-launcher/tasks.json`
**Key:** `cc-dogfood-agent-status-20260525-2008`
**Status:** `running`

Verified fields:
- `task_id` / `id` / `flow_id`: all set to `cc-dogfood-agent-status-20260525-2008`
- `project_dir`: `/Users/ostehost/projects/command-central`
- `model`: `claude-opus-4-7`
- `agent_backend`: `claude`
- `role`: `developer`
- `exec_host`: `Mike’s MacBook Pro` (U+2019 curly apostrophe)
- `exec_node`: `Mike MacBook Pro`
- `exec_visible`: `true`
- `exec_mode`: `spoke`
- `claude_session_id`: `103adcc6-9f03-4c75-aa89-b74e1573f794`
- `handoff_file`: `research/DOGFOOD-AGENT-STATUS-LAUNCH-2026-05-25.md`
- `stream_file`: `/tmp/claude-stream-cc-dogfood-agent-status-20260525-2008.jsonl`
- `start_sha`: `2f5de21aec2260a63212ee249b2588f064efd90d`
- `terminal_backend`: `tmux`
- `tmux_socket`: `/Users/ostehost/.local/state/ghostty-launcher/tmux/command-central.sock`
- `tmux_session`: `agent-command-central`
- `pending_review_path`: `/tmp/oste-pending-review/cc-dogfood-agent-status-20260525-2008.json`
- `artifact_paths`: `["research/DOGFOOD-AGENT-STATUS-LAUNCH-2026-05-25.md"]`

### 2. Process Scanner

The process scanner should detect this Claude process (running inside tmux).
The agent registry then **correctly suppresses** it via `matchesLauncherTask()` because `session_id` matches — preventing duplicate entries.

### 3. Session Files

Claude's session files at `~/.claude/projects/` provide session metadata. The `claude_session_id` field (`103adcc6-...`) ties back to the session file for resume targeting.

### 4. Pending Review

**Path:** `/tmp/oste-pending-review/cc-dogfood-agent-status-20260525-2008.json`
Not yet written (task still running). The launcher's finalizer will produce this after completion.

## Issues Found

### No Bugs — Pipeline Is Coherent

1. **Host name comparison:** `isLocalExecutionHost()` correctly matches. Both `scutil --get ComputerName` and `exec_host` return `Mike’s MacBook Pro` with U+2019 curly apostrophe. `normalizeHostName()` lowercases both identically.

2. **Model alias resolution:** `getModelAlias("claude-opus-4-7")` correctly returns `"opus"` via the includes-fallback at line 28. (Now also has exact match after our fix.)

3. **UUID link rendering:** `claude_session_id` is a valid UUID, so `getValidClaudeSessionId()` passes and the description shows `🔗 103adcc6`.

4. **Discovery suppression:** Launcher task with matching `session_id` correctly suppresses duplicate discovery entries via `AgentRegistry.matchesLauncherTask()`.

### Pre-existing Flaky Test (not introduced by this lane)

`test/tree-view/agent-status-tree-provider-discovery.test.ts:708` — asserts "Registry: 4 tasks (1 running, 3 completed/archived)" but the test reads the live `tasks.json` whose counts shift over time. This is a pre-existing instability unrelated to model-aliases.

## Code Change Made

**Rationale:** The `EXACT_MODEL_ALIASES` map was missing entries for `claude-opus-4-7` and `claude-sonnet-4-6` (the latest Claude models, one of which powers this very lane). While the includes-fallback handled them, adding explicit entries keeps the map current and self-documenting.

**Files:**
- `src/utils/model-aliases.ts` — Added 4 entries (prefixed + unprefixed forms)
- `test/utils/model-aliases.test.ts` — Added 2 test cases covering the new entries

## Tests/Checks Run

| Command | Result |
|---------|--------|
| `just check` (biome ci + tsc + knip) | PASS |
| `bun test test/utils/model-aliases.test.ts` | 4 pass, 0 fail |
| `just test` (full suite) | 1571 pass, 1 skip, 1 fail (pre-existing) |

## Final State

```
$ git status --short --branch
## main...origin/main [ahead 1]

$ git rev-parse --short HEAD
1570f21e

$ git log --oneline -3
1570f21e feat(model-aliases): add claude-opus-4-7 and claude-sonnet-4-6 exact entries
2f5de21a chore(prerelease): cut command central rc38
eede07bd fix(agent-status): swap $(link) codicon for 🔗 emoji in row description
```

Tree is clean. No untracked files. No push performed.
