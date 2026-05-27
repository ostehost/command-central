# Command Central Badge & Launcher Polish

**Task ID:** `cc-badge-launcher-polish-20260526`
**Date:** 2026-05-26
**Commit:** `ab850c19`
**Validation:** `just ready` — 1603 pass, 0 fail, 1 skip

---

## Root Cause Summary

### Badge count mismatch (badge showed 2, only 1 working)

Two competing code paths wrote `this._agentStatusView.badge`:

1. **`updateDockBadge()`** — used `getTasks().filter(status === "running").length` (correct semantics)
2. **`getChildrenImpl()`** — used `agentCounts.total` (all statuses: running + completed + failed)

Path B ran after Path A on every tree refresh when grouped by project, overwriting the correct running count with the total inventory count. A completed task in the registry inflated the badge even though it was not actively working.

Additionally, `isSuppressedByLauncherTask()` failed to suppress a discovered agent when the launcher task had `pid: null`. The three dedup heuristics (PID, session ID, project dir + start time) all fell through when pid was null and the session-ID/start-time match failed, causing the same agent to be counted twice: once as a launcher task and once as a discovered process.

### Ghostty app-bundle launch failure

macOS 26.5 Launch Constraints SIGKILL ad-hoc-signed Ghostty app bundles. The launcher's `--send` command failed with `LauncherExecutionError`, which `sendCommandViaLauncher()` threw as a raw error through `execCommand()` (which lacks error wrapping). The caller in `extension.ts` caught it and showed the raw launcher stderr in the fallback prompt — technically functional but cryptic.

---

## Files/Functions Changed

| File | Change |
|------|--------|
| `src/providers/agent-status-tree-provider.ts` | `getChildrenImpl()` badge: `agentCounts.total` → `agentCounts.working`; clears badge when 0 |
| `src/discovery/agent-registry.ts` | `matchesLauncherTask()`: when pid is null/missing and task is running, project dir + backend match is sufficient (skips start-time window) |
| `src/ghostty/TerminalManager.ts` | `sendCommandViaLauncher()` uses `execLauncher()` instead of `execCommand()` for proper error wrapping; `runInProjectTerminal()` catches `LauncherExecutionError` with `humanizeLauncherError()`; new `humanizeLauncherError()` method |
| `test/discovery/agent-registry.test.ts` | +2 tests: pid-null running task suppresses discovered agent; pid-null completed task does NOT suppress |
| `test/ghostty/terminal-manager.test.ts` | +2 tests: app-bundle open error shows friendly message; non-app-bundle error shows raw message |
| `test/tree-view/agent-status-tree-provider-discovery.test.ts` | +2 tests: grouped view badge reflects working count; badge clears when no agents working |

---

## Badge Semantics After Fix

- **Activity bar badge value**: count of agents with `status === "running"` from `getScopedAgentTasksForSummary()` (launcher tasks + discovered agents, excluding OpenClaw background tasks)
- **Badge tooltip**: `"N working agents"` (or `"1 working agent"`)
- **Badge cleared** (undefined) when working count is 0
- **Both paths now agree**: `updateDockBadge()` and `getChildrenImpl()` both use working-only counts with the same clear-at-zero behavior

---

## Dedup Heuristic

**When pid is null and task is running**, project dir + compatible backend is sufficient to match a discovered agent to a launcher task. The start-time window check is skipped only for this case.

**Why this won't hide legitimate parallel tasks:**

1. The relaxation only applies when `task.status === "running"` — completed/failed tasks still require the full start-time match
2. If two agents run in the same project, the launcher tracks both — each discovered process matches its own launcher task
3. The backend mismatch guard still applies (`agent_backend` / `cli_name`)
4. The only false-suppression risk: a manually-started (non-launcher) agent in the same project as a pid-null launcher task. This is far less likely than the guaranteed false-inflation from double-counting

---

## Ghostty Fallback Message Behavior

| Error Pattern | User-Facing Message |
|--------------|-------------------|
| stderr contains "failed to open ... .app" or "launch constraint" | "Ghostty app bundle could not open; tmux session is still running. Open in VS Code integrated terminal instead?" |
| Other launcher execution error | Raw `LauncherExecutionError.message` + standard fallback prompt |
| Launcher not found / validation error | Existing behavior preserved |

The fallback chain: `runInProjectTerminal()` catches the error → `humanizeLauncherError()` detects app-bundle patterns → `promptIntegratedTerminalFallback()` shows the warning dialog with "Open in VS Code Terminal" and "Install Launcher..." buttons.

---

## Validation

```
$ just ready
Biome CI — 242 files, 0 errors
TypeScript — tsc --noEmit passes
Tests — 1603 pass, 0 fail, 1 skip (11.31s across 119 files)
Quality — zero 'as any' assertions, zero skipped tests
```

---

## Git Status

```
commit ab850c19  fix(badge): use working count for activity badge and strengthen pid-null dedup
branch: main
working tree: clean (untracked research files preserved)
```

---

## Remaining Release Blockers

1. **Ghostty code signing** (ghostty-launcher repo): All project app bundles use ad-hoc signing with no team identifier. macOS 26.5 Launch Constraints reject these at load time. Requires Developer ID signing or designated requirements. Not addressable from command-central.
2. **Launcher pid population**: The launcher should store the claude process PID in `tasks.json` so CC's dedup can use the strongest (PID) match path. Currently pid is often null.
3. **Badge during scope transitions**: When a project filter is active, the badge counts scoped agents. Switching filters may briefly show stale counts until the next tree refresh. Low severity.
