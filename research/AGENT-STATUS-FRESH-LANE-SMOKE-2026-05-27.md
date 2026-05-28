# Agent Status Fresh-Lane Smoke Test — 2026-05-27

**Task ID:** `cc-agent-status-fresh-lane-20260527-2111`
**Role:** Reviewer / Smoke Test (read-only)
**Verdict:** PASS — rc46 has the expected Agent Status pane-health and lifecycle logic in place. No blockers found for a fresh Agent Status lane.

---

## Repo State

| Item | Value |
|------|-------|
| HEAD | `14537468` — `docs(release): document launcher dependency ownership` |
| Version | `0.6.0-rc.46` |
| Branch | `main` |
| Working tree | Clean (5 untracked `research/` files only) |

### `git status --short`

```
?? research/HANDOFF-linear-command-central-openclaw-down-2026-05-27.html
?? research/HANDOFF-linear-command-central-orchestration-2026-05-27.html
?? research/linear-command-central-openclaw-down-plan-2026-05-27.json
?? research/linear-command-central-openclaw-down-preflight-2026-05-27.json
?? research/linear-command-central-orchestration-plan-2026-05-27.json
```

---

## Pane-Health / Lifecycle Inspection

### `src/utils/tmux-pane-health.ts` (230 lines)

Present and well-structured. Provides:

- **`inspectTmuxPaneAgent(sessionId, socket)`** — tri-state (`alive` / `dead` / `unknown`) session-level inspector. Enumerates all panes in a tmux session, checks `pane_current_command` against `AGENT_PROCESS_NAMES`, then walks descendant PIDs up to depth 4.
- **`inspectTmuxPaneById(paneId, socket)`** — pane-specific inspector targeting an exact `%N` pane ID. Prevents false positives from unrelated panes in shared sessions.
- **`isTmuxPaneAgentAlive()`** — legacy boolean wrapper (`!== "dead"`).
- Fail-open design: `"unknown"` is returned on tmux unavailability, malformed output, or timeout. Callers are expected to use secondary signals (stream activity, runtime age) rather than treating unknown as alive.
- Input validation: session IDs validated against `/^[a-zA-Z0-9._-]+$/`, pane IDs against `/^%\d+$/`.

### `src/providers/agent-status-tree-provider.ts` (8961 lines)

Core tree provider integrates pane-health at two levels:

1. **Evidence caching** (`getTmuxPaneAgentEvidence`, line 1830): 5-second TTL cache keyed by `socket::pane` or `socket::session`. Routes to `inspectTmuxPaneById` when `task.tmux_pane_id` is present, otherwise `inspectTmuxPaneAgent`.
2. **Lifecycle conflict classification** (`classifyLifecycleConflict`, line 938): Detects "launcher says dead, process says alive" mismatch across terminal statuses (`completed`, `failed`, `stopped`, `killed`, etc.). Surfaces orange warning icon with detail string.

Additional lifecycle signals:
- `AgentEvent` types: `agent-started`, `agent-completed`, `agent-failed` (src/events/agent-events.ts).
- Handoff-file health checking via `checkDeclaredHandoff`.
- Stale-agent status detection (`STALE_AGENT_STATUS_DESCRIPTION`).
- Clearable agent task statuses for fresh-slate resets.

### Test Coverage

**10,342 lines** across 16 dedicated test files:

| Test file | Lines | Focus |
|-----------|-------|-------|
| `tmux-pane-health.test.ts` | 478 | Pane inspector unit tests |
| `agent-status-dead-process-running.test.ts` | 381 | Lifecycle conflict (dead process still running) |
| `agent-status-tree-provider-health.test.ts` | 1032 | Health/liveness tree rendering |
| `agent-status-tree-provider-discovery.test.ts` | 2609 | Discovery integration |
| `agent-status-tree-provider-diff-notifications.test.ts` | 1426 | Diff notification pipeline |
| `agent-status-tree-provider-rendering.test.ts` | 1039 | Tree item rendering |
| `agent-status-limbo-tier.test.ts` | 202 | Limbo state handling |
| `agent-status-launcher-interactive-claude.test.ts` | 315 | Interactive Claude lane visibility |
| + 8 more test files | ~3860 | Handoff, review queue, pending-review, etc. |

---

## Blockers

None identified. The repo at rc46 has:

- Tri-state pane-health inspectors (session-level and pane-specific)
- Lifecycle conflict detection integrated into the tree provider
- 5-second evidence caching to avoid excessive tmux/ps calls
- Comprehensive test suite (10k+ lines) covering health, lifecycle conflicts, discovery, and rendering
- Clean working tree with no uncommitted modifications

---

## Commands Run

```
git log -1 --oneline
git status --short
grep -r "version" package.json
find src -type f -name '*.ts' | xargs grep -l -i 'AgentStatus|agent.status|agent-status'
find src -type f -name '*.ts' | xargs grep -l -i 'pane.health|paneHealth|lifecycle|health.*check'
grep -n 'inspectTmuxPaneAgent|inspectTmuxPaneById|isTmuxPaneAgentAlive' src/providers/agent-status-tree-provider.ts
grep -rn 'lifecycle|Lifecycle' src/providers/agent-status-tree-provider.ts
wc -l test/tree-view/agent-status-*.test.ts test/utils/tmux-pane-health.test.ts
wc -l src/providers/agent-status-tree-provider.ts src/utils/tmux-pane-health.ts src/events/agent-events.ts
```

All read-only. No modifications to working tree.
