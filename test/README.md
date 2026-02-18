# Test Suite Documentation

**Status**: Enterprise-Grade Test Infrastructure
**Total Tests**: 46 files (593 tests)
**Partition Coverage**: 100% (validated automatically)
**Quality Checks**: Integrated with all test runs

---

## Quick Reference

```bash
# Full suite (recommended before commit)
just test

# Fast feedback during development
just test:unit                 # ~7-8s, unit tests only

# Test-Driven Development
just test:watch                # Re-run on file changes

# Validation (prevents orphaned tests)
just test:validate             # Run automatically with 'just test'

# Coverage analysis
just test:coverage             # See what's tested

# Integration tests
just test:integration          # Component interaction tests

# Specific directory
just test git-sort             # Test one area

# Specific file
just test ./test/utils/config-validator.test.ts
```

---

## Test Organization

All 46 test files (593 tests) are organized by category and automatically validated to prevent orphaned tests.

### Directory Structure

```
test/
├── git-sort/            # Git change sorting (24 files)
├── providers/           # UI providers (9 files)
├── services/            # Business logic (13 files)
├── state/               # State management (3 files)
├── integration/         # Multi-component (10 files)
├── tree-view/           # TreeView patterns (11 files)
├── utils/               # Utilities (13 files)
├── commands/            # Command handlers (3 files)
├── config/              # Configuration (2 files)
├── e2e/                 # End-to-end (1 file)
└── helpers/             # Test infrastructure
```

---

## Preventing Orphaned Tests

**The Problem**: Tests that exist but never run because they're not in a partition.

**The Solution**: Automatic validation on every `just test` run.

```bash
# Validates all 46 test files are properly partitioned
just test:validate

# Output shows any orphaned tests:
# ✅ Perfect! All tests are in partitions (100.0% coverage)
```

### How to Add New Tests

1. Create test in appropriate directory:
   ```bash
   touch test/utils/my-feature.test.ts
   ```

2. Validate it's included:
   ```bash
   just test:validate
   ```

3. If orphaned, add to partition in `package.json`:
   ```json
   "_test:core": "bun test test/utils test/services..."
   ```

---

## Test Commands

| Command | Speed | Use Case |
|---------|-------|----------|
| `just test` | ~7-8s | Before committing (full suite + validation) |
| `just test:unit` | ~7-8s | Fast feedback during development |
| `just test:integration` | ~7-8s | Component interaction tests |
| `just test:watch` | Continuous | TDD (re-run on file changes) |
| `just test:coverage` | ~7-8s | Analyze coverage gaps |
| `just test:validate` | <1s | Ensure no orphaned tests |
| `just test list` | <1s | Show test organization |

---

## Writing Tests

### File Naming Convention

**Format**: `<component>-<feature>.test.ts`

**Good**:
- `extension-filter-state.test.ts`
- `git-timestamps.test.ts`
- `multi-workspace-title-isolation.test.ts`

**Bad**:
- `test.ts` (too vague)
- `filter_test.test.ts` (use dash not underscore)
- `extensionFilterState.test.ts` (use kebab-case)

### Test Case Naming

**Format**: `<action> <expected outcome> [when <condition>]`

**Good**:
```typescript
test("validates and cleans filter when file extensions change")
test("parent checkbox checked when extension enabled in ALL workspaces")
test("fires onDidChange event after state update")
```

**Bad**:
```typescript
test("test feature")  // Too vague
test("checkbox test")  // Not descriptive
test("isGloballyEnabled returns true")  // Tests implementation
```

### Test Structure (AAA Pattern)

```typescript
import { describe, test, expect } from "bun:test";

describe("Component Name - Feature Area", () => {
	test("action produces expected outcome when condition", () => {
		// Arrange: Set up test state
		const state = createTestState();

		// Act: Perform operation
		const result = state.doSomething();

		// Assert: Verify outcome
		expect(result).toBe(expected);
	});
});
```

---

## Best Practices

### DO ✅

- ✅ Use `just test` before committing
- ✅ Write tests for bug fixes
- ✅ Test behavior, not implementation
- ✅ Use descriptive test names
- ✅ Keep tests independent
- ✅ Run `just test:validate` when adding tests

### DON'T ❌

- ❌ Skip `just test` before committing
- ❌ Write tests without validating partitions
- ❌ Test implementation details
- ❌ Share state between tests
- ❌ Use `setTimeout` for synchronization
- ❌ Run `bun test` directly (use `just test`)

---

## The Golden Rule

**`just test` before every commit.**

This ensures:
1. Code quality checks pass
2. All 593 tests run
3. No orphaned tests exist
4. No regressions introduced

---

**Last Updated**: 2025-10-18
**Validation**: Automatic via `just test`
