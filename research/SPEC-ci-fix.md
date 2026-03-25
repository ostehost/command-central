CLEAR
# SPEC: Fix CI Test Failures (GitHub Actions)

> Goal: Get all 764 tests passing in CI (GitHub Actions). Currently 74 failures, 0 locally.

## Root Cause

Bun's `mock.module()` mocks are **global** — when one test file mocks `node:fs`, it can pollute other test files running in the same process. Locally this doesn't manifest because test file ordering or Bun version differs.

Two categories of failures:

### Category 1: Incomplete `node:fs` mocks (mkdirSync missing)
Several test files mock `node:fs` but don't spread the real module, so functions like `mkdirSync` become undefined. This breaks `test/helpers/git-integration-helpers.ts` which calls `fsSync.mkdirSync()` at lines 133 and 207.

**Already fixed in 3 files** (by spreading `...realFs`):
- `test/discovery/agent-registry.test.ts` ✅
- `test/discovery/session-watcher.test.ts` ✅  
- `test/ghostty/binary-manager.test.ts` ✅

**Still need fixing:**
- `test/utils/tasks-file-resolver.test.ts` (line 15)
- `test/commands/launch-agent.test.ts` (line 37)
- `test/ghostty/terminal-manager.test.ts` (lines 51, 84, 128, 207, 299, 377, 470, 628)

**Fix pattern for each:**
```typescript
// Add at top of file, BEFORE the mock.module call:
import * as realFs from "node:fs";

// Then spread in every mock.module("node:fs") call:
mock.module("node:fs", () => ({
  ...realFs,   // ← ADD THIS LINE
  existsSync: myMock,
  // ... other overrides
}));
```

### Category 2: Git integration tests fail in CI (no git)
Tests in `test/integration/git-timestamps-integration.test.ts` create temp repos with real git. CI environment may not have git configured with user.name/user.email, or temp dir permissions differ.

**Failing tests:** All `Git Timestamps - Integration Tests (REAL GIT)` — approximately 20+ tests.

**Fix options (pick one):**
1. Add `git config --global user.name "CI" && git config --global user.email "ci@test"` to CI workflow before running tests
2. Set `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` env vars in the test helper
3. Add env setup in `test/helpers/git-integration-helpers.ts` before git init/commit operations

Option 2 or 3 is preferred — fix it in the test code so it works everywhere.

### Category 3: Extension discovery tests
22 failures in `countExtensionsByWorkspace` / `buildExtensionMetadata` / `end-to-end` — these are in `test/utils/extension-discovery.test.ts`.

Check if these also suffer from mock pollution (likely — the vscode mock or path mock may be incomplete in CI). Look at the error messages to diagnose.

## Files to Modify
- `test/utils/tasks-file-resolver.test.ts` — add `...realFs` spread
- `test/commands/launch-agent.test.ts` — add `...realFs` spread
- `test/ghostty/terminal-manager.test.ts` — add `...realFs` spread (7+ occurrences)
- `test/helpers/git-integration-helpers.ts` — add git user config before commits
- `test/utils/extension-discovery.test.ts` — diagnose and fix CI failures
- `.github/workflows/ci.yml` — if needed, add git config step

## Files NOT to Touch
- Any file in `src/` — no production code changes
- Test files not listed above

## Verification
1. `bun test` — all 764 tests pass locally
2. `just check` — lint + type-check + tests clean
3. Push to a branch, verify CI passes in GitHub Actions
4. If CI still fails, iterate — you have extra turns for this

## Work on a Branch
Create a branch `fix/ci-tests` and work there. Push to verify CI. When green, the branch can be merged.

SPEC COMPLETE
