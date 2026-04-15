# DEV-NOTES: Agent Status Slice 2 — Dead-Process-Running Detection

**Date:** 2026-04-10
**Task:** cc-agent-status-slice2-v1
**Scope:** Display-layer only — no schema changes, no new data sources

## Summary

Shipped a second truthfulness pass for the Agent Status tree view. The core problem: lanes with status `running` were staying in the running group even when the underlying agent process had exited, as long as the tmux session itself remained alive. The existing `isTmuxSessionAlive` check (a `tmux has-session` probe) confirmed the session/window existed but gave no information about what process was actually executing inside it. This pass adds pane-level process truth: walk the tmux panes for the session, check `pane_current_command` against a known agent CLI allowlist, then BFS-walk descendant pids via `pgrep`/`ps` to catch agents running under a shell wrapper. A lane is downgraded to unhealthy only when all of these checks come back negative.

## Dogfood Motivation

The concrete case that motivated this slice: task `cc-review-whats-new-version`, started 2026-04-07, still displayed as `running` on 2026-04-10 (3+ days). The tmux session `agent-command-central` was alive, so `isTmuxSessionAlive` returned `true`. But `tmux list-panes -t agent-command-central -F '#{pane_current_command}'` returned `bash` — not `claude`. The agent had exited; the session was just sitting at a shell prompt. Slice 2 detects exactly this case.

## Design Principle: Process Truth, Not Stream Files

**Stream file presence is NOT a reliable liveness signal for team-mode runs.** This was an explicit finding from slice 1 and was reinforced as an orchestrator-level constraint for slice 2. A tmux session can be alive and a task can be genuinely running without a corresponding stream file being registered (team-mode orchestration does not always create per-lane stream files).

The authoritative signal is **live process truth**: does the tmux pane (or a descendant process) match a known agent CLI name? This is determined by direct OS calls — `tmux list-panes`, `pgrep -P`, `ps -o comm=` — not by any file presence check. The `isTmuxPaneAgentAlive` helper implements this and must remain the sole liveness probe for this concern.

## Implementation

### New helper: `src/utils/tmux-pane-health.ts`

Exports `isTmuxPaneAgentAlive(sessionId, tmuxSocket?)` and the `AGENT_PROCESS_NAMES` allowlist.

Algorithm:
1. Validate `sessionId` against `/^[a-zA-Z0-9._-]+$/` — if invalid, return `true` (fail-open).
2. Run `tmux [-S socket] list-panes -s -t <sessionId> -F '#{pane_current_command}|#{pane_pid}'` via `execFileSync` (500ms timeout). On any throw → return `true`.
3. If output parses to zero pane lines → return `true` (no data, fail-open).
4. For each pane: if `pane_current_command` is in `AGENT_PROCESS_NAMES` → return `true`.
5. BFS over descendant pids via `pgrep -P <pid>` (max depth 4, cap 64 total pids). For each discovered pid batch-check `ps -p pid1,pid2,... -o comm=`. If any comm is in `AGENT_PROCESS_NAMES` → return `true`.
6. `ps` throw → return `true` (fail-open; pids may have exited between pgrep and ps).
7. Only after all panes and all descendants check negative → return `false`.

`AGENT_PROCESS_NAMES = ["claude", "codex", "cursor-agent", "aider", "ollama"]`

### Wiring: `src/providers/agent-status-tree-provider.ts`

- **New field:** `_tmuxPaneAgentCache: Map<string, { alive: boolean; checkedAt: number }>` alongside the existing `_tmuxSessionHealthCache`.
- **New method:** `isTmuxPaneAgentHealthy(task)` — 5s TTL cache keyed on `${socket ?? "__default__"}::${sessionId}`, calls `isTmuxPaneAgentAlive`.
- **`isRunningTaskHealthy`:** In the tmux branch, after `windowAlive` check passes: `if (!this.isTmuxPaneAgentHealthy(task)) return false;` — placed before `return !looksStale`.
- **`isTaskSessionConfirmedDead`:** Tmux branch refactored to return `true` when session/window is dead OR when pane agent is not healthy.
- **`reconcileDuplicateRunningSessions`:** Clears `_tmuxPaneAgentCache` entries matching `::${sessionId}` alongside the existing `_tmuxSessionHealthCache` cleanup.

Persist, applescript, and non-tmux fallback paths are untouched.

## Fail-Open Contract

The helper returns `false` (agent confirmed dead) only when ALL of the following are true:

- `tmux list-panes` completed without error
- Output parsed to at least one pane line (`panePids.length > 0`)
- No pane's `pane_current_command` matched `AGENT_PROCESS_NAMES`
- BFS completed without hitting the pid cap
- `ps` batch call succeeded without error
- No descendant process comm matched `AGENT_PROCESS_NAMES`

Every error path — tmux unavailable, session gone mid-check, timeout, malformed output, empty output, `ps` failure — returns `true`. This ensures a live agent lane is never incorrectly downgraded due to a transient probe failure.

## Known Limitations

The following limitations were identified during the Reviewer pass and are accepted as-is for this slice:

1. **`pgrep` exit code ambiguity.** `pgrep -P <pid>` exits non-zero for both "no children" (expected) and genuine errors (unexpected). Both are handled with `continue`. If `pgrep` errors for ALL panes due to a system fault, `descendantPids=[]` and the helper falls through to `return false` — not strictly fail-open for that edge. Practically acceptable on macOS: `pgrep -P` on own-process children cannot produce permission errors.

2. **BFS depth cap.** `MAX_DEPTH=4` handles `pane → bash → bash → bash → claude` (4 hops). Wrapper chains deeper than 4 hops from the pane root will miss the agent. Acceptable for all typical agent launcher setups.

3. **Agent name allowlist is comm-based.** Confirmed on this machine: the `claude` binary reports `ps -o comm= → claude` (not `node`). If a future agent ships with a different `comm` value (e.g., `claude-code`), the allowlist in `AGENT_PROCESS_NAMES` will need updating. Current allowlist: `["claude", "codex", "cursor-agent", "aider", "ollama"]`.

## Testing

**17 unit tests** for `isTmuxPaneAgentAlive` in `test/utils/tmux-pane-health.test.ts` — 100% line and function coverage. Test cases cover:
- `pane_current_command=claude` → alive
- `pane_current_command=bash`, descendant=claude → alive
- `pane_current_command=bash`, no descendant claude → dead
- `tmux` throws → alive (fail-open)
- Multiple panes, one with claude → alive
- Empty list-panes output → alive (fail-open)
- All five `AGENT_PROCESS_NAMES` entries
- Invalid session id → alive (fail-open)
- Socket path forwarded correctly

**7 tree-provider integration tests** in `test/tree-view/agent-status-dead-process-running.test.ts`. Two critical regression guards called out explicitly:
- **"missing stream file + live tmux pane → stays running"** — guards against any future regression that would conflate stream-file absence with process death. This is the most important test in the suite.
- **"live team lane with claude pane"** — guards the team-mode intent: a lane with a live `claude` pane must never be downgraded.

## Files Changed

| File | Change |
|------|--------|
| `src/utils/tmux-pane-health.ts` | New helper: `isTmuxPaneAgentAlive`, `AGENT_PROCESS_NAMES` |
| `src/providers/agent-status-tree-provider.ts` | Import, `_tmuxPaneAgentCache` field, `isTmuxPaneAgentHealthy` method, wired into `isRunningTaskHealthy` and `isTaskSessionConfirmedDead`, cache cleanup in `reconcileDuplicateRunningSessions` |
| `test/utils/tmux-pane-health.test.ts` | 17 unit tests for the helper |
| `test/tree-view/agent-status-dead-process-running.test.ts` | 7 tree-provider integration tests |

## What Was NOT Changed

- **No schema changes** — `AgentTask` interface and `tasks.json` format untouched
- **No stream file checks** — stream file presence is explicitly not used as a liveness signal
- **No new data sources** — only OS-level process probing via existing builtins
- **No host grouping** — out of scope
- **No persist/applescript path changes** — those branches are untouched
- **No count/limbo routing changes** — slice 1 territory, already working

## Commits

| Commit | Description |
|--------|-------------|
| `1a666cd` | `feat: add tmux-pane-health helper for agent-process detection (slice 2)` |
| `41f7890` | `fix: fail-open when tmux list-panes returns empty output (slice 2)` (first attempt) |
| `d3e4ea1` | `fix: fail-open on empty tmux list-panes output (slice 2)` (team-lead preferred structure) |
| `d0b9912` | Helper unit tests (Tester, task #7) |
| `bc26d5b` | `feat: detect dead agent process in alive tmux session (slice 2)` |
| `cfa0f0b` | Tree-provider test suite (Tester, task #4) |
