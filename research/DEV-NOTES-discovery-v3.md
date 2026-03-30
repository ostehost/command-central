# DEV-NOTES: discovery-v3

## Summary

Fixed process discovery so stale or idle CLI shells stop showing up as running agents.

## What changed

- `src/discovery/process-scanner.ts`
  - Added agent-mode detection so bare interactive `claude`, `codex`, and `gemini` invocations are filtered out.
  - Added stale-process filtering:
    - drop matched non-running launcher tasks immediately
    - drop matched running tasks whose `stream_file` is older than 10 minutes
    - drop unmatched processes older than 4 hours
  - Added launcher-task injection to cross-reference live task metadata during process scans.
- `src/discovery/agent-registry.ts`
  - Passes launcher task snapshots into `ProcessScanner` so stale filtering uses the same live registry the tree view already trusts.
- `src/providers/agent-status-tree-provider.ts`
  - Extended diagnostics labels for the new `interactive-process` and `stale-process` reasons.
- `test/discovery/process-scanner.test.ts`
  - Added the requested coverage for:
    - bare `claude` rejected
    - `claude -p` accepted
    - `codex exec` accepted
    - bare `codex` rejected
    - stale process filtering
  - Added a regression using the exact stale/idle process shapes from the machine report.

## Validation

- `just format` is referenced by the orchestration prompt, but this repo does not define that recipe.
- Ran `just fix` instead; it completed successfully and is the repo’s formatting/lint autofix command.
- Ran `just check` successfully.
- Ran `bun test test/discovery/*.test.ts` successfully.

## Notes

- Direct `ps` access is blocked in this sandbox, so live validation used:
  - the real launcher registry at `~/.config/ghostty-launcher/tasks.json`
  - real stream-file mtimes
  - the exact `ps` rows provided in the task prompt as regression fixtures
- Current live launcher registry in this environment shows:
  - `cc-discovery-v3` as actively running with a fresh stream
  - one unrelated stale launcher task in another repo
- The discovery fix specifically targets untracked or stale CLI processes that were previously surfacing as synthetic running agents.
