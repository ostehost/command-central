# Future Coverage Improvement Targets

**Status**: Deferred - Requires VS Code Mocking Infrastructure
**Priority**: Medium
**Estimated Effort**: 4-6 hours

---

## Why This Was Deferred

During Phase 1.3/1.4, we identified high-value test scenarios for `sorted-changes-provider.ts` (currently 18% coverage). However, proper testing requires:

1. **Complete VS Code API mocking** - TreeView, commands, workspace APIs
2. **Git Extension API mocking** - Repository, change tracking
3. **Complex integration scenarios** - Multi-workspace, filter coordination
4. **Async event handling** - File watchers, refresh cycles

**Decision**: Complete Phase 1.3 type safety work first, defer coverage improvements until proper mocking infrastructure is in place.

---

## High-Value Test Scenarios (When Infrastructure Ready)

### Test #1: Extension Filter Integration ⭐ CRITICAL
**Why**: `filter-by-extension-command.ts` depends on `getCurrentChanges()` returning unfiltered data
**Bug Risk**: If filtered, extension discovery breaks
**Coverage**: Public API contract

```typescript
test("getCurrentChanges() returns unfiltered data", async () => {
  // Setup: Active extension filter (only .ts)
  await provider.setExtensionFilter(new Set([".ts"]));

  // Add mixed extensions
  mockGit.addFile("/workspace/test.ts", "M ", true);
  mockGit.addFile("/workspace/test.js", "M ", false);

  // Verify: UI filtered, but getCurrentChanges() returns ALL
  const allChanges = provider.getCurrentChanges();
  expect(allChanges.size).toBe(2); // Both files
});
```

**Impact**: Tests integration between provider and command layer

---

### Test #2: Empty Set Defense ⭐ CRITICAL
**Why**: Line 688 comment "should never happen, but defense-in-depth"
**Bug Risk**: Edge case with explicit defensive code
**Coverage**: Error handling paths

```typescript
test("Empty extension filter handled gracefully", async () => {
  // Edge case: Empty Set (should never happen per code comment)
  await provider.setExtensionFilter(new Set());

  // Verify: Shows all files (fallback), no crash
  const children = await provider.getChildren(undefined);
  expect(children.length).toBeGreaterThan(0);
  expect(mockLogger.error).not.toHaveBeenCalled();
});
```

**Impact**: Validates defensive programming works

---

### Test #3: Dual-State Files (MM/AM) ⭐ CRITICAL
**Why**: Files modified in both staged AND unstaged areas
**Bug Risk**: Wrong counts, duplicate IDs crash VS Code TreeView
**Coverage**: Core UX decision (DUAL_STATE_FILES_UX_DECISION.md)

```typescript
test("Dual-state files appear in BOTH groups with unique IDs", async () => {
  mockGit.addFile("/workspace/dual.ts", "MM", true); // Modified both areas

  await provider.refresh();

  // Find all instances
  const dualStateItems = findAllItems((item) =>
    item.uri?.fsPath?.includes("dual.ts")
  );

  // Must appear in both staged and unstaged
  expect(dualStateItems.length).toBe(2);

  // IDs must be unique (duplicate IDs crash TreeView)
  const ids = new Set(dualStateItems.map(item => item.id));
  expect(ids.size).toBe(2);
});
```

**Impact**: Prevents VS Code crashes from duplicate IDs

---

### Test #4: Reveal/Focus Object Identity ⭐ CRITICAL
**Why**: Line 2188 comment "Must return exact cached object for === comparison"
**Bug Risk**: Reveal breaks with collapsed groups
**Coverage**: VS Code TreeView API contract

```typescript
test("findItemByUri() returns same object instance", async () => {
  // Get item through tree hierarchy
  const fileItem = await navigateToFile("/workspace/test.ts");

  // Simulate VS Code reveal operation
  const foundItem = provider.findItemByUri(fileItem.uri);

  // CRITICAL: Must be same instance (=== comparison)
  expect(foundItem).toBe(fileItem); // Not .toEqual, must be ===
});
```

**Impact**: Tests VS Code reveal() integration

---

### Test #5: Files with Missing Timestamps Still Appear
**Why**: Complex recovery logic (lines 1163-1218)
**Bug Risk**: Files disappear from tree
**Coverage**: Error recovery paths

```typescript
test("Files with missing timestamps still appear", async () => {
  // Mock: Timestamp lookup fails
  mockTimestamps.get = () => undefined;

  mockGit.addFile("/workspace/file.ts", "M ", true);
  await provider.refresh();

  // Verify: File still appears (not silently dropped)
  const items = await getAllFileItems();
  expect(items.find(i => i.uri.fsPath.includes("file.ts"))).toBeDefined();
});
```

**Impact**: Tests fallback/recovery logic

---

### Test #6: Git Status Grouping Title Format
**Why**: DUAL_STATE_FILES_UX_DECISION.md mandates no count in git status mode
**Bug Risk**: Confusing UI (count doesn't match sum of groups)
**Coverage**: UX requirement

```typescript
test("Title hides count in git status grouping mode", async () => {
  // Enable git status grouping
  mockGroupingManager.isGroupingEnabled = () => true;

  await provider.refresh();

  // Verify: "Workspace ▼" not "Workspace ▼ (52)"
  const title = provider.getViewTitle();
  expect(title).not.toMatch(/\(\d+\)/);
});
```

**Impact**: Validates documented UX decision

---

### Test #7: Deduplication Preserves Deletions
**Why**: Line 1126 special case - deletions take priority
**Bug Risk**: Deleted files shown as modified
**Coverage**: Business logic edge case

```typescript
test("Deletion status wins when deduplicating", async () => {
  // File deleted in staging, modified in working tree
  mockGit.addFile("/workspace/file.ts", "DM", true);

  await provider.refresh();

  // Verify: Shown as deleted, not modified
  const deletedItems = findItems(item =>
    item.uri.fsPath.includes("file.ts") && item.status.includes("D")
  );
  expect(deletedItems.length).toBeGreaterThan(0);
});
```

**Impact**: Tests documented business rule

---

### Test #8: Parent Map 3-Level Hierarchy
**Why**: Git status mode has GitStatusGroup → TimeGroup → File
**Bug Risk**: Reveal breaks in git status mode
**Coverage**: Integration between grouping and reveal

```typescript
test("Parent relationships correct in 3-level hierarchy", async () => {
  // Enable git status grouping
  mockGroupingManager.isGroupingEnabled = () => true;

  // Navigate: StatusGroup → TimeGroup → File
  const statusGroup = (await provider.getChildren(undefined))[0];
  const timeGroup = (await provider.getChildren(statusGroup))[0];
  const fileItem = (await provider.getChildren(timeGroup))[0];

  // Verify parent chain
  expect(provider.getParent(fileItem)).toBe(timeGroup);
  expect(provider.getParent(timeGroup)).toBe(statusGroup);
  expect(provider.getParent(statusGroup)).toBeUndefined();
});
```

**Impact**: Tests nested hierarchy navigation

---

## Prerequisites for Implementation

### 1. VS Code Mocking Infrastructure
- Complete TreeView mock (createTreeView, reveal, selection)
- Workspace API mock (getConfiguration, asRelativePath)
- Command execution mock
- Event emitter infrastructure

### 2. Git Extension Mocking
- Repository state tracking
- Change detection simulation
- Status parsing verification

### 3. Test Helpers
- `navigateToFile()` - Traverse tree hierarchy
- `findAllItems()` - Collect all tree items
- `getAllFileItems()` - Filter to file-level items

### 4. Integration Test Setup
- Multi-workspace scenarios
- File watcher simulation
- Async refresh handling

---

## Expected Impact

**Coverage**: 18% → 60% (lines)
**Quality**: High - all tests validate user-facing behavior
**Maintenance**: Low - tests use public API only
**Bug Prevention**: High - tests critical paths and documented edge cases

---

## Alternative Approaches Considered

### Option A: Test with Real VS Code Extension Host
**Pros**: Most accurate
**Cons**: Slow (minutes per test run), brittle, hard to debug
**Decision**: Rejected - defeats purpose of fast unit tests

### Option B: Minimal Mocking, Skip Complex Scenarios
**Pros**: Faster to implement
**Cons**: Misses critical integration points
**Decision**: Rejected - leaves highest-risk areas untested

### Option C: Extract Testable Core (Selected)
**Approach**:
1. Extract pure logic to testable functions
2. Test extracted functions thoroughly
3. Keep provider as thin integration layer

**Pros**: Fast tests, good coverage, maintainable
**Cons**: Requires refactoring, changes architecture

**Status**: Recommended for Phase 2.0

---

## Lessons from Previous Attempt

**What Failed**: `_deleted/test/git-sort/sorted-changes-provider.test.ts` (1,003 lines, 18% coverage)

**Why It Failed**:
- Used reflection: `(provider as any).privateMethod`
- Mocked everything: Never tested with realistic data
- Implementation-focused: Tests broke on refactoring
- Low value: Despite 1,000 lines, achieved only 18% coverage

**What We Learned**:
- Don't test private methods (test observable behavior)
- Don't mock everything (use realistic test data)
- Test user-facing impact (not implementation details)
- Quality over quantity (8 high-value tests > 47 low-value tests)

---

## Next Steps

1. ✅ Complete Phase 1.3 (type safety, skipped test, strict enforcement)
2. ✅ Document this strategy for future reference
3. 🔄 Phase 2.0: Build VS Code mocking infrastructure
4. 🔄 Phase 2.1: Implement 8 high-value tests
5. 🔄 Phase 2.2: Consider architectural refactoring for testability

---

**Conclusion**: The testing strategy is sound and well-researched. Deferred due to infrastructure requirements, not lack of value. When infrastructure is ready, these 8 tests will provide significant quality improvements with minimal maintenance burden.
