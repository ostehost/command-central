CLEAR
# SPEC: CI Fix v3 — Spread Real Modules in All mock.module Calls

## Problem
Bun's `mock.module()` is process-global. When a test file does `mock.module("node:fs", () => ({ writeFileSync: mockFn }))`, it replaces `node:fs` for ALL subsequent test files in the same run. This causes:
- `git-timestamps-integration.test.ts` fails because `fsSync.mkdirSync` is undefined (wiped by another file's partial mock)
- `extension-discovery.test.ts` fails because `path.extname` returns unexpected values (contaminated by mocked modules)
- 36 total CI failures from this root cause

## Root Cause
Partial mocks of `node:fs`, `node:fs/promises`, and `node:child_process` don't spread the real module first, so all un-mocked exports become `undefined`.

## Fix
For every `mock.module("node:X")` call, spread the real module before overriding specific exports.

### Pattern
```typescript
// BEFORE (breaks other tests):
mock.module("node:fs", () => ({
  existsSync: mockExistsSync,
}));

// AFTER (safe):
import * as realFs from "node:fs";
mock.module("node:fs", () => ({
  ...realFs,
  existsSync: mockExistsSync,
}));
```

### Files That Need Fixing

**`node:fs` mocks missing spread (7 locations):**
1. `test/discovery/session-watcher.test.ts:25`
2. `test/discovery/agent-registry.test.ts:34`
3. `test/ghostty/binary-manager.test.ts:23` and `:142`

Already fixed (have `...realFs`):
- `test/utils/tasks-file-resolver.test.ts` ✅
- `test/commands/launch-agent.test.ts` ✅
- `test/ghostty/terminal-manager.test.ts` ✅

**`node:fs/promises` mocks (3 locations):**
4. `test/git-sort/sorted-changes-provider-badge-sync.test.ts:79`
5. `test/git-sort/sorted-changes-provider-grouping-bugs.test.ts:58`
6. `test/git-sort/sorted-changes-provider-empty-state.test.ts:86`

**`node:child_process` mocks (need spread too):**
7. `test/discovery/agent-registry.test.ts:15`
8. `test/utils/port-detector.test.ts:13`
9. `test/commands/launch-agent.test.ts:16` (check if already fixed)
10. `test/services/test-count-status-bar.test.ts:172,204,239`
11. `test/ghostty/terminal-manager.test.ts:44,85,129,208,...` (check which already fixed)

### Rules
1. Import the real module at the top of the file: `import * as realFs from "node:fs";`
2. If a `realFs` import already exists, reuse it.
3. Spread it as the first entry in every `mock.module` callback return.
4. Also spread `default` if the mock overrides `default`.
5. **Do NOT change any test logic or assertions.** Only add imports and spreads.
6. Run `bun test` to verify 764 tests still pass locally.
7. Run `just check` to verify lint passes.

### What NOT to Touch
- No changes to `src/` files
- No changes to test assertions or test structure
- No new test files
- No changes to `git-integration-helpers.ts` (already fixed)

## Verification
- `bun test` → 764 pass, 0 fail
- `just check` → passes

SPEC COMPLETE
