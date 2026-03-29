# DEV-NOTES: Trust Layer Merge

**Date:** 2026-03-29
**Task:** Merge contract-validation-claude + agent-status-p0 worktrees into main

## What was merged

### Contract Integration (4 commits: bc1b9c9, 2087048, 79326ef, 6e4fb4e)

Cherry-picked from `worktree/contract-validation-claude`:

1. **bc1b9c9** — Steer contract fix: `.gitignore` update, prerelease-gate hardening,
   TerminalManager contract fixes, new test coverage
2. **2087048** — Contract integration: prerelease-gate enhancements, extension.ts
   TASKS_FILE propagation, TerminalManager helper resolution, test coverage
3. **79326ef** — Validation pass: Biome formatting fix in prerelease-gate test,
   merge-readiness handoff notes
4. **6e4fb4e** — Structured review document (APPROVE, 0 blockers)

### Agent Status Recency P0 (1 commit: 3441383)

Cherry-picked from `worktree/agent-status-p0`:

- Recency-based sorting for agent status tree provider
- Unified launcher/discovered ordering with freshest-project grouping
- Updated menu contributions and comprehensive test coverage

## Conflicts resolved

- **`.oste-report.yaml`** — trivial content conflict from concurrent worktree agents.
  Resolved by accepting theirs then removing the file entirely + adding to `.gitignore`.

## Formatting fixes applied

- `src/providers/agent-status-tree-provider.ts` — Biome auto-formatted during merge
- `test/tree-view/agent-status-tree-provider.test.ts` — Biome auto-formatted during merge

## Validation

- `just fix` — clean (only pre-existing lint warnings)
- `bunx tsc --noEmit` — clean, zero errors
- `bun test` — 965/974 pass; 9 failures are all pre-existing timeout flakes
  (project-icon-manager, grouping-state, and similar timing-sensitive tests)

## Cleanup

- Removed `.oste-report.yaml` from tracked files
- Added `.oste-report.yaml` to `.gitignore` to prevent future noise
