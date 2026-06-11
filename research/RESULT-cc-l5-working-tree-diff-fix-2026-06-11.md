# RESULT - L5 working-tree diff routing fix

- Task: continue release cleanup after `cc-activation-l5-nav-diff-openclaw-fable-20260610`
- Date: 2026-06-11
- Commit: `26f8f96f` (`fix(agent-diff): preserve working-tree diff routing`)
- Base risk: Lane 5 had extracted diff commands, but discovered/running working-tree diffs could be routed into `openFileDiff` as completed bounded diffs. That made the new bounded guard show "No bounded diff is available for this task" instead of opening the working tree diff.

## Fix

`src/activation/register-agent-diff-commands.ts`

- Discovered-agent `viewAgentDiff` now forwards single-file working-tree diffs to `commandCentral.openFileDiff` with `taskStatus: "running"`.
- Launcher tasks keep terminal-task drift protection: non-running tasks without `end_commit` stop before file selection with the bounded-diff message.
- Running tasks use working-tree range arguments in the picker and keep `endCommit` undefined.
- `openFileDiff` now treats `taskStatus: "running"` as explicit working-tree intent, preserves a supplied `startCommit` as the left side, reads the working tree for the right side, and emits `cc-diff` URIs with `ref=working-tree`.

`test/commands/agent-diff-commands-registration.test.ts`

- Renamed the discovered-agent single-file regression to assert the route is working-tree/running, not completed.
- Added a real temp-git regression proving `openFileDiff` uses the supplied start commit on the left side for running working-tree diffs and does not trip the bounded-diff guard.

## Verification

Focused and fast gates before commit:

| Gate | Result |
|---|---|
| `bun test test/commands/agent-diff-commands-registration.test.ts` | 22 pass / 0 fail |
| `just check` | passed |
| `just test-unit` | 450 pass / 0 fail |
| `just test` | 1916 pass / 0 fail / 1 skip |
| `just test-integration` | 390 pass / 0 fail |
| `just dist --dry-run` | passed, still previewing `v0.6.0-rc.53` |

Release-prep gates after commit:

| Gate | Result |
|---|---|
| `just prerelease-gate` | passed; wrote `research/prerelease-gate/prerelease-gate-2026-06-11T02-02-51.084Z.json` |
| Prerelease provenance | Command Central `26f8f96f4b7412517f9721e500f6bc58a8cd3ca1`; Ghostty Launcher `3cab35c4ba2bf6d85035fb517ba219def52c6493` |
| `just test-electron` | passed in 76.51s on VS Code 1.124.0 |

## Current release posture

- L5 blocker is resolved and committed.
- Working tree was clean immediately after `26f8f96f`; running `just prerelease-gate` intentionally dirtied release provenance (`research/prerelease-gate/latest.json` plus the timestamped gate report).
- `main` remains far ahead of `origin/main` (38 before committing this receipt/provenance). This is now the main process risk: the code is gated locally, but the hub/remote does not have the local release stack.
- No preview rc was cut in this lane. The next preview cut should be rc54 or later, not a mutation of rc53.

## Remaining next-release work

- Commit this receipt and the prerelease-gate provenance.
- Cut the next preview only after deciding to move the large local stack forward.
- After the next VSIX exists, install it and run `just verify-vscode-consumption` plus `just test-installed-vsix-agent-status`; rc53 cannot prove this fix because it predates `26f8f96f`.
