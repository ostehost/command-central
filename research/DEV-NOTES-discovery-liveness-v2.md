# Discovery Liveness v2

## Goal
Stop stale/idle sessions from appearing as running discovered agents when the persist socket or shell window is still alive but the agent CLI is not.

## Changes
- `src/discovery/process-scanner.ts`
  - Added command classification for `agent`, `shell`, and `other`.
  - Filters shell-wrapper processes like `zsh .../@openai/codex/...` as `shell-process` instead of retaining them as discovered agents.
- `src/discovery/session-watcher.ts`
  - Session files now validate that the live PID still resolves to an actual agent CLI.
  - If the PID has fallen back to `zsh`, `bash`, `fish`, etc., the discovered session-file agent is dropped.
- `src/discovery/agent-registry.ts`
  - Added launcher task cross-reference during discovered-agent liveness filtering.
  - Suppresses discovered agents when the matching launcher task is already terminal (`completed`, `stopped`, `failed`, etc.).
  - Suppresses session-file discoveries when the matching launcher task is still marked `running` but its stream file has been idle for more than 5 minutes.
- `src/providers/agent-status-tree-provider.ts`
  - Updated discovery diagnostics text to recognize the new `shell-process` filter reason.

## Matching Heuristics
- First choice: exact PID match if launcher metadata has a PID.
- Second choice: exact session-id match.
- Fallback: same `project_dir`, compatible backend, and start times within 15 minutes.

## Verification
- `just fix`
- `just check`
- `bun test test/discovery/*.test.ts test/tree-view/agent-status-tree-provider.test.ts`

## Notes
- The requested `just format` recipe does not exist in this repo; `just fix` is the repo’s formatting/lint autofix equivalent.
- The live launcher `tasks.json` file is outside the writable sandbox roots in this environment, so I did not modify the external task registry directly from the workspace. The code changes rely on reading launcher state, and the orchestrator completion hook should handle final task-state transitions.
