# Type Safety Standards

**Status**: Enforced via Biome + TypeScript + CI
**Last Updated**: 2025-10-27
**Owner**: Engineering Team

---

## Zero Tolerance Policy

### Production Code (src/)
- ✅ **ZERO** `as any` allowed (Biome error)
- ✅ **ZERO** `any` types allowed (TypeScript noImplicitAny)
- ✅ **ZERO** implicit `let` declarations without types (Biome error)

### Test Code (test/)
- ⚠️ **MINIMAL** `as any` allowed (Biome warn, manual review required)
- 💡 **DOCUMENTED** intentional type violations (explanatory comments mandatory)
- 🚫 **FORBIDDEN** reflection testing (accessing private members via `as any`)

### Archived Code (_deleted/, test/.legacy/)
- ⏸️ **DISABLED** linting and formatting (preserved for reference)

---

## Enforcement Layers

### Layer 1: TypeScript Compiler
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true
  }
}
```

**Result**: Compile-time errors for implicit `any` types

### Layer 2: Biome Linter
```json
{
  "linter": {
    "rules": {
      "suspicious": {
        "noExplicitAny": "error",      // src/: error
        "noImplicitAnyLet": "error"    // src/: error
      }
    }
  },
  "overrides": [
    {
      "includes": ["test/**/*.ts"],
      "linter": {
        "rules": {
          "suspicious": {
            "noExplicitAny": "warn",      // test/: warn (migration)
            "noImplicitAnyLet": "warn"    // test/: warn (migration)
          }
        }
      }
    }
  ]
}
```

**Result**: Static analysis catches explicit `any` usage

### Layer 3: Quality Gates (just test-quality)
```bash
# Fails on:
- Any 'as any' in active tests (excluding _deleted/)
- Reflection tests: (foo as any).privateMethod
- Skipped tests: test.skip, describe.skip
```

**Result**: CI/CD pipeline blocks merges with type violations

### Layer 4: CI/CD Pipeline
```yaml
- name: Check test quality
  run: just test-quality
```

**Result**: Automated enforcement on every push/PR

---

## Approved Patterns

### ✅ Use Typed Mock Factories

**Location**: `test/helpers/typed-mocks.ts`

**Available Factories**:
```typescript
import {
  createMockLogger,          // Complete LoggerService (15 methods)
  createMockStorageAdapter,  // Complete StorageAdapter (11 methods)
  createMockUri,             // Complete vscode.Uri (10 properties)
  createMockExtensionContext,// Complete ExtensionContext
  createMockGitRepository,   // Git repository mock
  createMockDeletedFileRecord,// DeletedFileRecord structure
} from "../helpers/typed-mocks.js";
```

**Example**:
```typescript
// ❌ BAD: Partial mock with type escape
const logger = {
  info: () => {},
  error: () => {},
} as any;  // Missing 13 methods!

// ✅ GOOD: Complete typed mock
const logger = createMockLogger({
  info: mock((msg) => console.log(msg)),  // Override if needed
});
```

### ✅ Document Intentional Type Violations

**When Allowed**: Testing defensive programming with invalid inputs

**Pattern**:
```typescript
test("handles null inputs defensively", () => {
  // Testing runtime null handling - intentional type violation
  // TypeScript prevents at compile time, validates defensive programming
  expect(service.process(null as any)).toBe(defaultValue);
});
```

**Requirements**:
1. Multi-line comment explaining WHY
2. Clear indication of "intentional type violation"
3. Justification (e.g., "runtime validation", "defensive programming")

---

## Forbidden Patterns

### 🚫 Reflection Testing (Private Member Access)

**Anti-Pattern**:
```typescript
// ❌ FORBIDDEN: Testing private implementation
const parser = (provider as any).parseGitStatusV2;
const result = parser("test data");
expect(result).toEqual(expected);
```

**Why Bad**:
- Tests break on refactoring (brittle)
- Couples tests to implementation, not behavior
- Violates black-box testing principles
- Makes code harder to maintain

**Correct Approach**:
```typescript
// ✅ GOOD: Test public API behavior
const provider = new SortedGitChangesProvider(logger);
provider.refresh();
const items = await provider.getChildren();
expect(items).toHaveLength(expectedCount);
```

**Action**: Move reflection tests to `_deleted/` directory

### 🚫 Partial Mocks with Type Escape

**Anti-Pattern**:
```typescript
// ❌ FORBIDDEN: Incomplete mock
const mockGit = {
  repositories: [],
} as any;  // Missing 10 methods!
```

**Why Bad**:
- Runtime errors when code calls missing methods
- No type safety
- Hard to debug

**Correct Approach**:
```typescript
// ✅ GOOD: Complete typed mock or use factory
const mockGit = createMockGit({
  repositories: [],  // Override specific property
});
```

### 🚫 Lazy Type Assertions

**Anti-Pattern**:
```typescript
// ❌ FORBIDDEN: Lazy escape hatch
const config = JSON.parse(data) as any;
config.foo.bar.baz = value;  // No type checking!
```

**Correct Approach**:
```typescript
// ✅ GOOD: Define proper types
interface Config {
  foo: {
    bar: {
      baz: string;
    };
  };
}
const config = JSON.parse(data) as Config;
config.foo.bar.baz = value;  // Type-checked!
```

---

## Third-Party Types (Prefer Over DIY)

### Available Type Packages

**Currently Used**:
- `@types/vscode` - VS Code Extension API
- `@types/bun` - Bun runtime
- `@types/node` - Node.js APIs
- `@types/sqlite3` - SQLite database

**Before Creating Types**:
1. Search npm: `@types/<package-name>`
2. Check DefinitelyTyped: https://github.com/DefinitelyTyped/DefinitelyTyped
3. Check package for built-in types: `package.json` → `types` field

**Adding Types**:
```bash
bun add -d @types/<package-name>
```

---

## Migration Strategy (Test Code)

### Current State (2025-10-27)
- **Active tests**: 32 `as any` remaining
  - 12 reflection tests in git-status-cache.test.ts
  - 9 documented intentional violations
  - 11 misc mocks to be cleaned up

### Phase 1: Clean Remaining Mocks (2 hours)
1. launcher-methods.test.ts (2 `as any`)
2. grouping-state.test.ts (5 `as any`)
3. multi-view-sort-isolation.test.ts (3 `as any`)
4. ui/grouping-view-manager.test.ts (1 `as any`)

### Phase 2: Archive Reflection Tests (1 hour)
1. Move git-status-cache.test.ts reflection tests to `_deleted/`
2. Update ARCHIVE_MANIFEST.md
3. Write public API replacement tests if needed

### Phase 3: Enable Strict Enforcement (5 min)
```json
// Change biome.json test override from "warn" → "error"
{
  "includes": ["test/**/*.ts"],
  "linter": {
    "rules": {
      "suspicious": {
        "noExplicitAny": "error",  // Changed from "warn"
        "noImplicitAnyLet": "error"
      }
    }
  }
}
```

---

## Quality Metrics

### Success Criteria
- ✅ Zero `as any` in src/ (production code)
- ⏳ <5 documented `as any` in test/ (intentional violations only)
- ✅ Zero reflection tests in active test suite
- ✅ All CI quality gates passing

### Current Metrics (2025-10-27)
- Production code: **0** `as any` ✅
- Test code: **32** `as any` (target: <5)
  - Documented intentional: 9
  - Reflection tests: 12 (to be archived)
  - Remaining mocks: 11 (to be fixed)
- Test suite: **433 tests passing**
- Coverage: Maintained during migration

---

## Developer Workflow

### Pre-Commit Checklist
```bash
# 1. Run quality checks
just check

# 2. Run tests
just test

# 3. Verify quality gates pass
just test-quality

# 4. Complete verification
just verify
```

### When You Need `as any`

**Ask These Questions**:
1. Can I use a typed mock factory instead?
2. Can I define a proper interface?
3. Can I use `unknown` and type guard?
4. Is this testing defensive programming? (document if yes)

**If You Must Use `as any`**:
1. Add multi-line explanatory comment
2. Mark as "intentional type violation"
3. Explain WHY it's necessary
4. Get code review approval

---

## References

- **Mock Factories**: `test/helpers/typed-mocks.ts`
- **Archive Manifest**: `_deleted/test/ARCHIVE_MANIFEST.md`
- **Testing Anti-Patterns**: `docs/testing-anti-patterns/`
- **Biome Configuration**: `biome.json`
- **TypeScript Configuration**: `tsconfig.json`

---

## Questions?

**Type safety issues**: Review this document
**Need new mock factory**: Add to `test/helpers/typed-mocks.ts`
**Unclear about pattern**: Ask in code review

**Remember**: Type safety prevents runtime errors. The strictness is worth it.

---

**Last Updated**: 2025-10-27
**Next Review**: After Phase 3 (strict enforcement enabled)
