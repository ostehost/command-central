# Test Suite Overhaul — Execution Plan (v2 — Director Approved)

**Goal:** Go from 658 tests (many hollow) to ~450 tests that actually catch bugs.
**Constraint:** No test reorganization (no folder moves). Ship value, not structure.
**Director Decision:** CONDITIONAL GO — phased commits, keep 8 specific tests, add 1 test.

---

## IMPORTANT: Phased Commits

Each phase is a SEPARATE commit. This is non-negotiable — enables bisection if regressions occur.

---

## Phase 0: Establish Baseline

Run `bun test` and record: total tests, pass count, coverage %. This is the "before" snapshot.

---

## Phase 1: Fix the Mock Foundation (do first — everything else depends on this)

### 1A. Fix `registerCommand` mock to return Disposable
**File:** `test/helpers/vscode-mock.ts` line ~161

```typescript
// BEFORE:
registerCommand: mock(),

// AFTER:
registerCommand: mock((id: string, handler: (...args: unknown[]) => unknown) => ({
  dispose: mock(() => {}),
})),
```

This is the #1 fix. The current mock returning `undefined` hid the reload crash from tests.
Apply same pattern to any other registration mocks that should return Disposable.

### 1B. Verify mock fix doesn't break existing tests
Run full suite after 1A. Some tests may fail because they now get a Disposable where they expected undefined. Fix those — they were testing wrong behavior anyway.

---

## Phase 2: Delete Low-Value Tests (234 cuts)

### Rules for cutting:
- If it tests mock plumbing, not behavior → cut
- If the same error-handling pattern is tested in 8+ command files → keep ONE, cut rest
- If TypeScript's type system already prevents the bug → cut
- If it's a trivial getter/setter with no logic → cut

### Cuts by file (coder: use line numbers from TEST_AUDIT_REDUNDANCY.md):

**Entire files to delete:**
- `test/git-sort/icon-path-resolution.test.ts` (7 tests) — string concatenation tests
- `test/git-sort/scm-sorter.test.ts` (6 tests) — trivial getter/setter

**Command files — keep success path + 1 error test each, delete rest:**
- `configure-project-command.test.ts` — cut 2
- `launch-command.test.ts` — cut 5
- `launch-here-command.test.ts` — cut 6
- `launch-workspace-command.test.ts` — cut 5
- `remove-launcher-command.test.ts` — cut 4
- `remove-all-launchers-command.test.ts` — cut 4
- `list-launchers-command.test.ts` — cut 3
- `three-way-diff-command.test.ts` — cut 2

**Service files — cut mock-theater tests:**
- `logger-service.test.ts` — cut 25 (keep: error logging, history, core level filtering)
- `extension-filter-state.test.ts` — cut 12
- `project-view-manager-methods.test.ts` — cut 18
- `launcher/strategies.test.ts` — cut 15
- `launcher-methods.test.ts` — cut 11

**Git-sort — cut trivial edge cases:**
- `circuit-breaker.test.ts` — cut 2
- `storage-adapter.test.ts` — cut 8
- `workspace-state-storage-adapter.test.ts` — cut 8
- `deleted-file-tracker.test.ts` — cut 5

**Utilities — cut formatting variations:**
- `relative-time.test.ts` — cut 8
- `formatters.test.ts` — cut 3
- `process-manager.test.ts` — cut 2
- `config-validator.test.ts` — cut 5

**Types — cut TypeScript-redundant checks:**
- `tree-element-validator.test.ts` — cut 12

---

## Phase 3: Add Tests That Would Have Caught Real Bugs

These are the HIGH-value additions. Each one maps to a bug that actually shipped.

### 3A. ProviderFactory tests (NEW FILE: `test/factories/provider-factory.test.ts`)

```
- creates provider for workspace config
- finds correct provider for file path (longest match)
- handles /tmp → /private/tmp symlink resolution
- returns undefined for file outside all workspaces
- gracefully handles storage creation failure (falls back)
- dispose() cleans up all providers
```
~8 tests. Covers Bug #3 (symlink) and Bug #1 (storage failure).

### 3B. ProjectViewManager reload tests (ADD TO existing integration file)

```
- reload disposes per-view commands before re-registering (regression: v0.1.6)
- registerAllProjects twice does not throw command collision
- reload with changed workspace count succeeds
```
~3 tests. Bug #2 already has a regression test; reinforce with realistic mock.

### 3C. SortedGitChangesProvider initialization (ADD TO existing core test file)

```
- initialize() with pre-existing repositories triggers refresh
- concurrent initialize() calls don't create duplicate listeners
- getChildren returns empty array (not empty groups) when no changes
```
~3 tests. Covers Bug #4 (race condition) and Bug #5 (empty groups).

### 3D. Extension activation resilience (NEW FILE: `test/integration/extension-activation.test.ts`)

```
- activates successfully when storage adapter fails
- activates when Git extension is not yet available
- registers all expected commands
```
~3 tests. Covers Bug #1 (SQLite failure).

---

## Phase 4: Verify & Ship

1. Run full suite — target: ~450 tests, 0 failures
2. Check coverage hasn't dropped on critical paths
3. Commit as single commit: "Overhaul test suite: cut 234 low-value tests, add 17 bug-catching tests, fix mock foundation"

---

## Director Overrides — Tests to KEEP (do NOT cut these)

The redundancy audit recommended cutting these. Director says keep them:

1. `test/git-sort/circuit-breaker.test.ts` line ~48-58 — "should show warning message when circuit trips" — user feedback is critical
2. `test/services/launcher/strategies.test.ts` lines ~97-107, ~131-141 — platform validation tests — cross-platform bugs are hard to catch
3. ONE instance of `exception path - re-throws terminal-related errors` across all command files — keep as regression guard, cut the duplicates

Net: ~8 tests saved from cuts. Final cut target: ~226 instead of 234.

## Director Override — Additional Test Required

Add to `test/factories/provider-factory.test.ts`:

```typescript
test("handles workspace root vs nested project distinction", async () => {
  // Workspace: /Users/dev/monorepo
  // Provider registered for: /Users/dev/monorepo/packages/frontend
  // File: /Users/dev/monorepo/packages/backend/src/file.ts
  // Should return undefined — file is outside the registered project
});
```

This catches path-matching bugs where broad workspace paths incorrectly claim files.

---

## What NOT to do

- ❌ Don't reorganize test folders (unit/integration/e2e split). Ship value, not structure.
- ❌ Don't add e2e tests yet. We don't have VS Code test runner set up.
- ❌ Don't rewrite working integration tests. They're the highest-value tests we have.
- ❌ Don't chase 100% coverage. Chase "would this have caught a real bug?"
- ❌ Don't touch the 52 integration tests. They are the most valuable.

---

## Commit Sequence

1. `"Fix registerCommand mock to return Disposable"` — Phase 1
2. `"Add 18 tests targeting real production bugs"` — Phase 3 (new tests)
3. `"Remove redundant command boilerplate tests (76 cuts)"` — Phase 2a
4. `"Remove service mock-theater tests (89 cuts)"` — Phase 2b
5. `"Remove trivial utility and type tests (61 cuts)"` — Phase 2c

---

## Success Criteria

| Metric | Before | After |
|--------|--------|-------|
| Total tests | 658 | ~450 |
| Tests that catch real bugs | ~0 of 5 | 5 of 5 |
| Mock `registerCommand` returns Disposable | ❌ | ✅ |
| ProviderFactory test coverage | 0% | >80% |
| Line coverage | >82% | >85% (must not drop) |
| Time to run suite | ~5.5s | ~4s |
| False confidence from mock theater | High | Low |

## Safety Gate

If any phase reveals >5 unexpected test failures (beyond the mock fix cascading), STOP and flag for Mike review.
