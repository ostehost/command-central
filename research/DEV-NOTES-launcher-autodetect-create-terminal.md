# DEV NOTES: Launcher Auto-Detect + Create Terminal UX

## Task
- `cc-launcher-autodetect-create-terminal`

## Summary
Implemented a tight UX fix so first-use project terminal flows work without manual launcher setup:
- Added real launcher auto-discovery fallback paths in `TerminalManager`.
- Updated `commandCentral.ghostty.createTerminal` to use the friendly `runInProjectTerminal()` path.
- Preserved Ghostty project-bundle behavior when launcher exists.
- Ensured graceful fallback to VS Code integrated terminal when launcher is unavailable.
- Added focused unit tests to lock in fallback discovery and command routing behavior.

## Implementation Details

### 1) Launcher auto-discovery fallback paths
- File: `src/ghostty/TerminalManager.ts`
- Added concrete fallback paths:
  - `~/projects/ghostty-launcher/launcher` (common local dev checkout)
  - `~/ghostty-launcher/launcher`
- Updated launcher-path resolution comments to reflect common local fallback discovery.

### 2) Create Terminal command now uses user-friendly launch path
- File: `src/extension.ts`
- Changed `commandCentral.ghostty.createTerminal` flow:
  - Removed brittle `isLauncherInstalled()` hard gate and launcher-not-found error.
  - Replaced `createProjectTerminal()` call with `runInProjectTerminal()`.
  - Updated success and failure messages from “create” to “open” wording.

### 3) Graceful fallback behavior preserved and verified
- `runInProjectTerminal()` already:
  - Uses Ghostty bundle/tmux flow when launcher is available.
  - Falls back to VS Code integrated terminal when launcher is unavailable.
- Added explicit tests so this behavior is now locked.

## Tests Added/Updated

### Updated
- `test/ghostty/terminal-manager.test.ts`
  - Added fallback discovery test for `~/projects/ghostty-launcher/launcher` path probing.
  - Added `runInProjectTerminal` test that verifies integrated-terminal fallback when launcher is missing.

### Added
- `test/commands/ghostty-create-terminal.test.ts`
  - Verifies create-terminal command routes through `runInProjectTerminal`.
  - Verifies it does **not** rely on strict launcher-installed gating.
  - Verifies multi-root folder selection behavior.
  - Verifies command error messaging on launch failure.

## Tests Run
- `bun test test/ghostty/terminal-manager.test.ts test/commands/ghostty-create-terminal.test.ts`
- `bun test test/commands/ghostty-create-terminal.test.ts`
- `just pre-commit` (fails due pre-existing repository-wide lint warnings unrelated to this task; no new errors in changed code)

## Safe Follow-ups (optional)
1. Add one light telemetry event/property for `createTerminal` path source:
   - `ghostty_bundle` vs `vscode_integrated_fallback`
   - Helps quantify first-use launcher availability and fallback frequency.
2. Consider making `commandCentral.hasLauncher` context dynamic (re-evaluated on command use) so menu visibility reflects newly installed launcher state without reload.
3. Optionally add one extension-level integration test that asserts actual command registration wiring in `activate()` for this command path.
