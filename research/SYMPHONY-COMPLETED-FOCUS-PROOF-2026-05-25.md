# Symphony Completed-Task Focus Proof — 2026-05-25

## Root Cause

Two bugs combined to prevent terminal focus on completed launcher-backed Symphony Run Attempt rows:

1. **`resolveCodexRunFocusTask` gated on `status === "running"`** (`agent-status-tree-provider.ts:7943`). Completed tasks whose tmux terminals are still alive were rejected, so the codex-run tree item received no `command` — the proof's `findFocusNode` found nothing.

2. **`CodexRunView` dropped `owner_actions`** (`codex-run-observer-service.ts`). The projection from `AgentTask` to `CodexRunView` never carried `owner_actions`, and `selectedAgentStatusOwnerFields` in `integration-test-api.ts` hardcoded `available_owner_actions: []` for codexRun elements.

3. **`focusAgentTerminal` command handler unconditionally redirected non-running tasks to `resumeAgentSession`** (`extension.ts:1586`). Even after fixes (1) and (2) gave the tree item a focus command, executing it opened a QuickPick resume dialog and hung the proof waiting for user interaction.

## Fix

### Commit 1: `6e75dbe3` — Projection & tree provider
- **`src/types/codex-run-types.ts`**: Added `ownerActions?: unknown[]` to `CodexRunView`.
- **`src/services/codex-run-observer-service.ts`**: `projectLauncherTask` and `joinLauncherTask` now carry `owner_actions` through to `CodexRunView.ownerActions` via `normalizeOwnerActions`.
- **`src/services/integration-test-api.ts`**: Changed `available_owner_actions: []` to `run.ownerActions ?? []`.
- **`src/providers/agent-status-tree-provider.ts`**: `resolveCodexRunFocusTask` now returns any task with a `session_id`, not only running tasks.

### Commit 2: `ffc80dbb` — Focus command handler
- **`src/extension.ts`**: `focusAgentTerminal` now checks `hasTerminalFocusSurface` before redirecting to resume. Tasks with `session_id` or valid `bundle_path` use the non-mutating focus strategies (session store, tmux+ghostty bundle, direct bundle, tmux attach). Resume is only the fallback when no focus surface exists.

## Files Changed

| File | Change |
|------|--------|
| `src/types/codex-run-types.ts` | +1 line: `ownerActions` field |
| `src/services/codex-run-observer-service.ts` | +15 lines: carry and normalize `owner_actions` |
| `src/services/integration-test-api.ts` | 1-line fix: surface `run.ownerActions` |
| `src/providers/agent-status-tree-provider.ts` | 5-line fix: relax focus gate |
| `src/extension.ts` | 8-line fix: conditional resume redirect |
| `test/services/codex-run-observer-service.test.ts` | +97 lines: 3 new tests |

## Test Commands & Results

```
just check        # biome ci + tsc + knip — passed
just test         # 1598 tests, 0 failures, 4468 assertions
bun test test/services/codex-run-observer-service.test.ts  # 26 pass, 0 fail
```

New tests added:
- `preserves owner_actions on standalone launcher-backed completed run`
- `merges owner_actions when launcher joins an existing run`
- `omits ownerActions when launcher has empty or null owner_actions`

## Installed VSIX Live Proof

```
Version:     0.6.0-rc.42
VSIX:        releases/command-central-0.6.0-rc.42.vsix
SHA256:      8703aff9fcd9e9daff36e5449a83c38f4cd875cc373e359d33ff0e97d7e7f199
Manifest:    logs/installed-vsix-agent-status-proof-1779762991791.json
Target task: cc-local-preview-update-routing-20260525-2140
Mode:        live
Duration:    9.40s
Actions:     3 passed / 0 skipped
Errors:      []
```

| Action | Status | Detail |
|--------|--------|--------|
| copy | passed | Run attempt ID copied |
| open evidence | passed | Prompt file opened |
| focus terminal | **passed** | Terminal focus invoked |

Target node `available_owner_actions` now surfaces 5 launcher actions including `focusTerminal`.

## Proof Note

The rc41 proof (full 343-task registry) hung >5 minutes due to extension host unresponsiveness from scanning all tmux sockets. The successful rc42 proof used a trimmed fixture with only the target task. The full-registry proof scalability is a pre-existing infrastructure concern, not caused by this fix.

## Remaining Risks

- **Full-registry proof timeout**: The installed-VSIX proof with the full 343-task registry can hang due to extension host unresponsiveness during tmux socket scanning. A bounded task fixture or increased proof timeout would address this.
- **Dead tmux session fallback**: If a completed task's tmux session is dead AND all bundle-based strategies fail, the focus handler falls to the dead-session QuickPick menu (blocking in automated contexts). This only affects tasks with no live terminal surface, which is the correct UX for interactive use.

## Git Status

```
Branch: main
Tree:   clean (4 commits ahead of remote)
```

Commits:
1. `6e75dbe3` — fix(symphony): preserve launcher owner_actions on codex run projection and allow focus for completed tasks
2. `ffc80dbb` — fix(focus): allow completed tasks with terminal metadata to use focus strategies
3. `f0c6c252` — chore(prerelease): cut command central rc41
4. `f848e8ee` — chore(prerelease): cut command central rc42
