# Review: cc-current-running-surface-fix-20260613

Task ID: review-cc-current-running-surface-fix-20260613
Reviewed range: aa812b381fd9d6e6da177c91f555aa7aa44d3213..807f115883f17d064cd2a4970b799f0c11755a26
Review commit: 807f115883f17d064cd2a4970b799f0c11755a26

## Verification

- Confirmed working directory with `pwd`: `/tmp/command-central-cc-current-running-surface-fix-20260613-review`.
- Confirmed initial `git status --short` was clean.
- `git rev-parse HEAD` returned `807f115883f17d064cd2a4970b799f0c11755a26`, matching the selected review commit.
- `git show --stat --name-only HEAD` shows one changed product file: `src/providers/agent-status-tree-provider.ts`.
- `git diff aa812b381fd9d6e6da177c91f555aa7aa44d3213..807f115883f17d064cd2a4970b799f0c11755a26` shows 25 changed lines in that file: 22 insertions, 3 deletions.

## Findings

WARNING: The completion notes omit the actual implementation change. The notes have an empty `agent_summary` and `report: null`, but the selected commit changes `src/providers/agent-status-tree-provider.ts`. The code now keeps registry-`running` tasks on the live surface when `isRunningTaskHealthy()` is false but `isTaskSessionConfirmedDead()` cannot positively confirm death, and it updates `isTaskSessionConfirmedDead()` to fail open when `isLocalFileProbeAuthoritative(task)` is false. This is an important behavior change that is not described in the completion notes.

NIT: The new code comment at `src/providers/agent-status-tree-provider.ts:2252` references `research/RESULT-cc-current-running-surface-fix-20260613.md`, but that file is not present in tracked `research/` files and `test -f research/RESULT-cc-current-running-surface-fix-20260613.md` did not find it. This does not contradict the provided completion notes, which have `report: null`, but it leaves the source comment pointing at a missing rationale document.

## Alignment Notes

- Commit metadata in the completion context aligns with the repository: `manager_commit` and `review_commit` both resolve to the current HEAD `807f115883f17d064cd2a4970b799f0c11755a26`.
- The claimed `last_commit`, `end_commit`, and `agent_commit` all resolve to the base commit `aa812b381fd9d6e6da177c91f555aa7aa44d3213`, which matches the reviewed range base.
- No tests were claimed passing in the completion notes, and no test-pass evidence is present there.

REVIEW COMPLETE
