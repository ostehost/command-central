# DEV NOTES: Contract Integration

## Task
- `cc-contract-integration`

## Summary
- Resolved the in-progress helper-contract cherry-pick on top of the steer-contract fix and kept both runtime fixes intact.
- Merged prerelease gate coverage so the branch now checks both launcher helper resolution and `oste-steer.sh` invocation contracts together.
- Fixed the gate's helper-call parser to match the real multiline formatting in [src/extension.ts](/Users/ostemini/projects/command-central-contract-integration/src/extension.ts), then validated the integrated branch against the live launcher repo.

## Integrated Changes
- [src/ghostty/TerminalManager.ts](/Users/ostemini/projects/command-central-contract-integration/src/ghostty/TerminalManager.ts)
  - Keeps the steer fix on the supported launcher contract: `oste-steer.sh <session> --raw <command>`.
  - Resolves launcher helper scripts from the concrete launcher binary directory via `resolveLauncherHelperScriptPath()`.
- [src/extension.ts](/Users/ostemini/projects/command-central-contract-integration/src/extension.ts)
  - `Capture Output` and `Kill` now call launcher-managed helpers from the launcher install, not from `path.dirname(tasksFilePath)`.
  - Passes `TASKS_FILE` through to those helpers so they operate on the same registry Command Central is reading.
- [scripts-v2/prerelease-gate.ts](/Users/ostemini/projects/command-central-contract-integration/scripts-v2/prerelease-gate.ts)
  - Reads both [src/extension.ts](/Users/ostemini/projects/command-central-contract-integration/src/extension.ts) and [src/ghostty/TerminalManager.ts](/Users/ostemini/projects/command-central-contract-integration/src/ghostty/TerminalManager.ts) during contract validation.
  - Fails on launcher helper drift, legacy tasks-file-relative helper resolution, unsupported `oste-steer.sh --session`, missing `--raw`, or loss of positional session steering.
  - Accepts multiline helper-resolution calls so the gate matches the real extension formatting.

## Validation
- `bun test test/ghostty/terminal-manager.test.ts`
  - Result: `34 pass, 0 fail`
- `bun test test/scripts-v2/prerelease-gate.test.ts`
  - Result: `14 pass, 0 fail`
- `bun test test/commands/extension-commands.test.ts`
  - Result: `46 pass, 0 fail`
- `bun run scripts-v2/prerelease-gate.ts --skip-cc-validation --skip-launcher-validation --launcher-repo /Users/ostemini/projects/ghostty-launcher`
  - Result: passed
  - Artifacts:
    - [latest.json](/Users/ostemini/projects/command-central-contract-integration/research/prerelease-gate/latest.json)
    - [prerelease-gate-2026-03-29T20-06-10.537Z.json](/Users/ostemini/projects/command-central-contract-integration/research/prerelease-gate/prerelease-gate-2026-03-29T20-06-10.537Z.json)

## Notes
- This integration intentionally avoided unrelated Agent Status UX work.
- The reliable gate run skipped repo-wide validation steps and exercised the cross-repo contract surface directly, which was the closest stable equivalent in this environment.
- Final Git resolution is blocked here because this worktree's index lives under `/Users/ostemini/projects/command-central/.git/worktrees/command-central-contract-integration`, which is outside the writable sandbox, so `git add` cannot create `index.lock`.
