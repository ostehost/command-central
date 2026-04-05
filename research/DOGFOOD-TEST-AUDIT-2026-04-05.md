# Dogfood Test Suite Audit — 2026-04-05

## Summary

Full test suite (1261 tests, 92 files) was hanging indefinitely when run via `bun test`, causing pre-commit hook timeouts. After this audit, the suite completes in ~9s with 0 failures.

## Root Causes Found

### 1. `node:fs` Mock Bleed (34 test failures)

**Problem:** Several test files (`launch-agent.test.ts`, `cron-service.test.ts`) mock `node:fs` at module scope. Bun loads ALL test files before running any tests, so module-level `mock.module("node:fs", ...)` bleeds into unrelated test files. Other files using `import * as fs from "node:fs"` get the mocked version (which lacks `promises`, `writeFileSync`, etc.), causing 34 failures in services tests.

**Fix:** 
- Cached real `node:fs` in the preload file (`global-test-cleanup.ts`) by spreading the live namespace into a frozen plain object stored on `globalThis.__realNodeFs`
- Updated affected test files (`session-store`, `review-tracker`, `project-icon-manager`, `infrastructure-health-status-bar`, `launch-agent`, `resume-session`) to use the frozen reference
- Moved `launch-agent.test.ts`'s module-level `mock.module("node:fs", ...)` into `beforeEach`

**Key insight:** In Bun, `import * as ns` creates a live namespace object that mutates when `mock.module()` is called. Spreading into `{...ns}` breaks the live binding.

### 2. Timer Leaks (process hang)

**Problem:** Production modules loaded during tests create `setInterval` timers that keep the event loop alive after all tests complete.

- `CronTreeProvider` constructor calls `startAutoRefresh()` → `setInterval(30s)`
- `AgentStatusTreeProvider.reload()` calls `updateAutoRefreshTimer()` → `setInterval`

**Fix:**
- Added `afterEach(() => provider.dispose())` to `cron-tree-provider.test.ts`
- Added `afterEach` with safe disposal to `agent-status-tree-provider.test.ts` (checks for `dispose()` existence before calling)
- Added `unref()` wrappers for both `setInterval` and `setTimeout` in the preload file as a safety net

### 3. Bun Recursive Test Discovery Hang

**Problem:** `bun test` with `root = "./test"` in bunfig.toml hangs indefinitely, even though listing all 18 subdirectories explicitly completes fine with identical file counts (92 files). This appears to be a Bun 1.3.9 bug with recursive test discovery from a parent directory.

**Fix:** Changed the `test` script in `package.json` from `bun test` to explicitly list all test subdirectories: `bun test test/commands/ test/config/ ... test/utils/`

### 4. Flaky Timing Test

**Problem:** `infrastructure-validation.test.ts` `measureAsync` test expected a 10ms sleep to complete in < 50ms (later 200ms). Under full-suite load, actual times reached 400+ms.

**Fix:** Increased target to 2000ms since this test validates measurement functionality, not actual performance. Removed the `passed` assertion that depended on the target threshold.

### 5. Unused Import (TypeScript error)

**Problem:** `afterAll` was imported in `global-test-cleanup.ts` but no longer used after removing a previous `afterAll` block.

**Fix:** Removed the unused import.

## Files Changed

| File | Change |
|------|--------|
| `test/setup/global-test-cleanup.ts` | Cache frozen real `node:fs`, add timer `unref()` wrappers, remove unused import |
| `test/commands/launch-agent.test.ts` | Use frozen `node:fs` reference, move mock into `beforeEach` |
| `test/commands/resume-session.test.ts` | Use frozen `node:fs` reference |
| `test/services/session-store.test.ts` | Use frozen `node:fs` reference |
| `test/services/review-tracker.test.ts` | Use frozen `node:fs` reference |
| `test/services/project-icon-manager.test.ts` | Use frozen `node:fs` reference |
| `test/services/infrastructure-health-status-bar.test.ts` | Use frozen `node:fs` reference |
| `test/providers/cron-tree-provider.test.ts` | Add `afterEach` with `provider.dispose()` |
| `test/tree-view/agent-status-tree-provider.test.ts` | Add `afterEach` with safe disposal |
| `test/helpers/infrastructure-validation.test.ts` | Widen timing tolerance |
| `package.json` | Explicit subdirectory listing in test script |
| `bunfig.toml` | No net change (coverage tested and reverted) |

## Production Code Changes

None. All fixes are test-only.

## Final Results

```
1261 pass, 0 fail, 92 files, ~9s
TypeScript: 0 errors
Biome: 0 issues
Process: exits cleanly
```
