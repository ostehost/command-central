# Command Central Release Readiness — Dogfood Review

**Task ID:** `cc-release-readiness-dogfood-20260526`
**Date:** 2026-05-26
**Reviewer:** Claude Opus 4.7 (dogfood QA)
**HEAD:** `99eb00db` on `main` (auto-commit wrapper around `ab850c19`)
**Prior version:** `0.6.0-rc.42`

---

## Verdict

```
ready_for_preview: yes
recommended_version: 0.6.0-rc.43
```

Both user-facing UX issues are addressed with clean implementations and comprehensive test coverage. The Ghostty app-bundle signing issue is external to Command Central and is handled gracefully via the new `humanizeLauncherError` + integrated-terminal fallback path. No blockers found.

---

## Feature Commits Reviewed

### 1. `60a848c0` — feat(tree): deterministic single-click for agent tree items

**What it does:**
- Replaces the QuickPick-on-click UX with a new `commandCentral.defaultAgentAction` command
- Running tasks: focus terminal directly (fast path)
- Completed tasks with live tmux session: focus terminal directly
- Completed tasks without live terminal: view diff (most useful default)
- QuickPick still accessible via context menu "Resume Session" / "Agent Actions"
- Cleans up QuickPick labels: plain English, routing health rows become non-actionable separators

**Review findings:**
- Command registered in `package.json:753` with proper category and icon
- `extension.ts:1575-1627`: implementation correctly dispatches on `task.status`, checks tmux liveness via `isTaskTmuxSessionAlive`, falls back to `viewAgentDiff`
- `agent-status-tree-provider.ts:8622`: tree items now wire to `defaultAgentAction` for both running and completed states
- Context menu registrations preserved: `resumeAgentSession` still available at `viewItem =~ /agentTask\.(completed|...)/ group:2_actions`, `viewAgentDiff` at `group:inline` and `group:navigation`
- Integration test `installed-vsix-proof-suite.ts` updated to accept both `focusAgentTerminal` and `defaultAgentAction` as valid focus commands
- 8 test files updated; all assertions match the new command IDs and labels
- No command ID mismatches found between package.json, extension.ts, and tree provider

**Severity:** No issues.

### 2. `ab850c19` — fix(badge): use working count for activity badge and strengthen pid-null dedup

**What it does:**
- Badge in grouped-by-project mode: `agentCounts.total` changed to `agentCounts.working`
- Badge clears (`undefined`) when working count is 0 — no more stale "2" when all agents are done
- `isSuppressedByLauncherTask()`: when launcher task has `pid: null` and `status === "running"`, project dir + backend match is sufficient (skips unreliable start-time window)
- `sendCommandViaLauncher()` now uses `execLauncher()` for proper `LauncherExecutionError` wrapping
- New `humanizeLauncherError()` detects app-bundle open failures and returns user-friendly message
- `runInProjectTerminal()` catches `LauncherExecutionError` and routes through `promptIntegratedTerminalFallback()`

**Review findings:**
- Badge logic (`agent-status-tree-provider.ts:3499-3510`): conditional assignment with proper singular/plural tooltip. Clears to `undefined` when 0 — VS Code removes the badge dot correctly when badge is undefined.
- Dedup relaxation (`agent-registry.ts:434-437`): correctly scoped to `!hasPid && task.status === "running"` only. Completed/failed tasks still require full match, preventing false suppression.
- Error humanization (`TerminalManager.ts:910-919`): regex pattern catches both "failed to open ... .app" and "launch.constraint" — covers the macOS 26.5 SIGKILL scenario.
- Error flow (`TerminalManager.ts:704-716`): `LauncherExecutionError` caught after the existing `LauncherSteeringError` catch, then routed to the same `promptIntegratedTerminalFallback` with the humanized message. Chain is correct.
- `sendCommandViaLauncher` at line 870 now calls `execLauncher` instead of `execCommand` — this is the right fix since `execLauncher` wraps errors as `LauncherExecutionError` while `execCommand` throws raw `Error`.
- 6 new tests covering: pid-null dedup (both running and completed cases), badge working count, badge clear-at-zero, app-bundle error humanization, non-app-bundle error passthrough.

**Severity:** No issues.

---

## Validation Commands & Results

| Gate | Command | Result |
|------|---------|--------|
| Lint + typecheck + knip | `just check` | Pass — 242 files, 0 errors |
| Unit tests | `just test-unit` | 528 pass, 0 fail |
| Full test suite | `just test` | 1603 pass, 0 fail, 1 skip |
| Quality checks | (part of `just test`) | Zero `as any`, zero skipped tests |
| Git status | `git status` | Clean working tree (2 untracked research files) |

---

## Command Registration Audit

| Command ID | package.json | extension.ts | Tree Provider | Context Menu |
|------------|:---:|:---:|:---:|:---:|
| `commandCentral.defaultAgentAction` | L753 | L1578 | L8622 | — (click handler only) |
| `commandCentral.focusAgentTerminal` | L759 | L1631+ | — | inline, navigation |
| `commandCentral.resumeAgentSession` | L968 | L1848+ | — | 2_actions (completed states) |
| `commandCentral.viewAgentDiff` | L903 | registered | — | inline, navigation |

No mismatches. `defaultAgentAction` correctly delegates to `focusAgentTerminal` and `viewAgentDiff` without duplicating their registration.

---

## Release Recommendation

**Exact command to cut next preview:**

```bash
just cut-preview
```

This will:
1. Preflight — refuse dirty trees (untracked `research/` files are on the allowlist)
2. Sync launcher binary from `~/projects/ghostty-launcher/`
3. Run `just ci` as rehearsal
4. Run full prerelease gate (cross-repo)
5. Build `0.6.0-rc.43` VSIX in `releases/`

After completion:
```bash
code --install-extension releases/command-central-0.6.0-rc.43.vsix
# Then: Cmd+Shift+P → "Developer: Reload Window"
```

---

## Ghostty Launcher Integration Risk Assessment

**Issue:** macOS 26.5 Launch Constraints SIGKILL ad-hoc-signed Ghostty app bundles. This is a Ghostty/launcher-level signing issue, not a Command Central bug.

**CC handling (after this fix):**
- `LauncherExecutionError` from `--send` failures is caught in `runInProjectTerminal`
- `humanizeLauncherError` detects the app-bundle pattern and shows: *"Ghostty app bundle could not open; tmux session is still running"*
- User is prompted with "Open in VS Code Terminal" fallback — functional degradation, not a crash
- No raw stderr leaks to the user; no error spam in the UI

**Recommendation:** Track the signing issue in the ghostty-launcher repo separately. It does **not** block the Command Central preview because:
1. CC handles the failure gracefully with a clear message
2. The integrated-terminal fallback is functional
3. Tmux sessions survive the app-bundle SIGKILL — only the GUI fails
4. The signing fix requires Developer ID or notarization, which is out of CC's scope

---

## Git Status

```
HEAD:     99eb00db (chore: auto-commit agent work [cc-badge-launcher-polish-20260526])
Branch:   main
Ahead:    23 commits (local only)
Working:  clean
Untracked:
  - research/AGENT-STATUS-NEEDS-REVIEW-TRIAGE-2026-05-26.md
  - research/COMMAND-CENTRAL-GHOSTTY-CRASH-COUNT-INVESTIGATION-2026-05-26.md
Version:  0.6.0-rc.42 (next: rc.43)
```

---

## Summary

| Area | Status | Notes |
|------|--------|-------|
| Tree click UX | Fixed | Deterministic single-click; QuickPick via context menu |
| Activity badge | Fixed | Shows working count only; clears at zero |
| Ghostty fallback | Fixed | Human-readable message; integrated-terminal fallback |
| Command registrations | Clean | No ID mismatches |
| Test coverage | Strong | 6 new targeted tests; 1603 total passing |
| Release tooling | Ready | `just cut-preview` will produce rc.43 |
| Ghostty signing | External | Track separately; CC handles gracefully |
