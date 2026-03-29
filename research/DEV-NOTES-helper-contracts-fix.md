# DEV NOTES: Helper Contracts Fix

## Task
- `cc-helper-contracts-fix`

## Summary
- Fixed launcher-managed `Capture Output` and `Kill` actions so they resolve `oste-capture.sh` and `oste-kill.sh` from the resolved launcher binary location instead of `path.dirname(tasksFilePath)`.
- Passed the active tasks registry path through `TASKS_FILE` when invoking those helpers so the scripts operate on the same registry that Command Central is displaying.
- Extended prerelease-gate coverage so helper-resolution drift is caught alongside the existing `--session-id` contract check.

## Implementation
- Added `TerminalManager.resolveLauncherHelperScriptPath()` in [src/ghostty/TerminalManager.ts](/Users/ostemini/projects/command-central-helper-contracts/src/ghostty/TerminalManager.ts) and taught launcher resolution to turn a PATH-based `launcher` into a concrete filesystem path before anchoring helper scripts under `scripts/`.
- Updated the `commandCentral.captureAgentOutput` and `commandCentral.killAgent` flows in [src/extension.ts](/Users/ostemini/projects/command-central-helper-contracts/src/extension.ts) to use that helper and to export `TASKS_FILE=<provider file path>` into the child process environment.
- Extended [scripts-v2/prerelease-gate.ts](/Users/ostemini/projects/command-central-helper-contracts/scripts-v2/prerelease-gate.ts) so the gate now fails if:
  - Command Central regresses to deriving launcher helpers from `tasks.json`
  - either launcher-managed helper action stops using the stable helper-resolution path
  - helper scripts are no longer anchored to the resolved launcher binary

## Tests Run
- `bun test test/ghostty/terminal-manager.test.ts`
- `bun test test/scripts-v2/prerelease-gate.test.ts`
- `bun test test/commands/extension-commands.test.ts`

## Verification Limits
- `just format` does not exist in this repo's `justfile`.
- `just fix` and `bunx tsc --noEmit` were blocked in this sandbox because Bun could not write to its temp directory (`PermissionDenied`).
- `git add` / `git commit` are blocked in this worktree because the git metadata lives at `/Users/ostemini/projects/command-central/.git/worktrees/command-central-helper-contracts`, which is outside the writable sandbox, so Git cannot create `index.lock`.

## Files Changed
- [src/ghostty/TerminalManager.ts](/Users/ostemini/projects/command-central-helper-contracts/src/ghostty/TerminalManager.ts)
- [src/extension.ts](/Users/ostemini/projects/command-central-helper-contracts/src/extension.ts)
- [scripts-v2/prerelease-gate.ts](/Users/ostemini/projects/command-central-helper-contracts/scripts-v2/prerelease-gate.ts)
- [test/ghostty/terminal-manager.test.ts](/Users/ostemini/projects/command-central-helper-contracts/test/ghostty/terminal-manager.test.ts)
- [test/scripts-v2/prerelease-gate.test.ts](/Users/ostemini/projects/command-central-helper-contracts/test/scripts-v2/prerelease-gate.test.ts)
