# DEV-NOTES: Cross-Repo Smoke Validation Suite

**Date:** 2026-03-29
**Task:** Build and run cross-repo smoke validation for CC <-> Ghostty Launcher

## Summary

Created `test/integration/cross-repo-smoke.test.ts` — a 31-test smoke suite that validates all 6 trust-layer control surface paths end-to-end.

## Smoke Paths Validated

### 1. Spawn (4 tests)
- `buildOsteSpawnCommand()` produces correct positional + flag argument shapes
- `--role` flag included when specified
- Paths with spaces safely single-quoted
- Paths with single quotes use POSIX escaping (`'"'"'`)

### 2. Steer (3 tests)
- TerminalManager uses positional session ID (not legacy `--session` flag)
- `--raw` flag passed to oste-steer.sh
- All `execCommand("oste-steer.sh", [...])` calls verified for correct shape

### 3. Capture (4 tests)
- Extension resolves `oste-capture.sh` via `resolveLauncherHelperScriptPath`
- No legacy `path.dirname(tasksFilePath)` resolution for capture helper
- TerminalManager anchors helpers to `path.dirname(launcherPath)/scripts/`
- Script name validation rejects path traversal (`../etc/passwd`, `.hidden.sh`)

### 4. Kill (2 tests)
- Extension resolves `oste-kill.sh` via `resolveLauncherHelperScriptPath`
- No legacy tasks.json dir resolution for kill helper

### 5. Focus (5 tests)
- `lookupGhosttyTerminal()` returns correct mapping for known sessions
- Returns null for unknown sessions, missing file, and malformed entries
- Reads from `/tmp/ghostty-terminals.json` (correct path)

### 6. Completion (4 tests)
- `running -> completed` fires completion notification
- `running -> failed` fires failure notification
- No notification when previous status was not `running`
- `completed_dirty` treated as completion

### Static Contract Validation (2 tests)
- TerminalManager references `--session-id` (not legacy `--tmux-session`)
- Extension resolves all required launcher helpers (`oste-capture.sh`, `oste-kill.sh`)

### Dynamic Contract Validation (7 tests, conditional)
- Runs only when `~/projects/ghostty-launcher` exists
- Validates launcher binary exposes `--create-bundle`, `--parse-name`, `--parse-icon`, `--session-id`
- Validates `oste-steer.sh` exposes `--raw`, `--by-task-id`, positional `<session-name>`
- Full `validateLauncherContract()` and `validateSteerContract()` pass cleanly
- Helper scripts (`oste-capture.sh`, `oste-kill.sh`, `oste-spawn.sh`) exist in launcher repo

## Test Results

```
31 pass, 0 fail, 59 expect() calls
Ran 31 tests across 1 file. [137ms]
```

Full suite: 1006 pass, 5 fail (pre-existing failures in focusGhosttyWindow tests and performance infrastructure test — unrelated to this change).

## Prerelease Gate

Gate fails due to pre-existing Biome lint errors in `test/commands/extension-commands.test.ts` (2x `noExplicitAny` warnings promoted to error by `biome ci`). The cross-repo contract checks themselves pass — the gate would succeed if those pre-existing lint issues were fixed.

## Architecture Notes

- The smoke suite imports `prerelease-gate.ts` extractors directly to validate contracts statically against live source files
- Dynamic tests use `describe.if(launcherAvailable)` to conditionally run when the launcher repo is present
- Focus tests use `mock.module("node:fs/promises")` to inject file system behavior without touching the real `/tmp/ghostty-terminals.json`
- No VS Code mock needed — the smoke tests validate argument shapes, source patterns, and contract alignment without loading the extension

## Next Steps

- Fix the 2 pre-existing `noExplicitAny` warnings in `test/commands/extension-commands.test.ts` to unblock the prerelease gate
- Fix the 5 pre-existing `focusGhosttyWindow` test failures (likely mock setup issue)
- Consider adding the smoke suite to CI as a separate job that runs when the launcher repo is available
