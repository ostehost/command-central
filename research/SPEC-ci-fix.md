# SPEC: Fix CI Test Failures

> Goal: Make all 764 tests pass in GitHub Actions CI, not just locally.

## Problem
37 tests fail in CI (GitHub Actions, ubuntu-latest, Bun 1.3.9) but pass locally (macOS).

Two failure categories:

### Category 1: extension-discovery tests (22 failures)
**Error:** `TypeError: fsSync.mkdirSync is not a function`

**Root cause:** Bun's `mock.module("node:fs")` in one test file pollutes the module cache for other test files. `test/ghostty/binary-manager.test.ts` and `test/discovery/agent-registry.test.ts` mock `node:fs` with incomplete implementations. When `test/utils/extension-discovery.test.ts` or `test/helpers/git-integration-helpers.ts` imports `node:fs`, they get the mocked version missing `mkdirSync`.

**Fix approach:** Either:
- A) Add `mkdirSync`, `writeFileSync`, `rmSync`, `readFileSync`, `readdirSync` etc to all `node:fs` mocks (passthrough to real fs for unmocked functions)
- B) Use `mock.module("node:fs", () => ({ ...require("node:fs"), readFileSync: mockFn }))` pattern to spread the real module and only override specific functions
- C) Run the affected test files in isolation via `--preload` or separate test runs

**Recommended:** Option B — spread real module, override only what's needed. This is the safest and most maintainable pattern.

### Category 2: git-timestamps integration tests (15 failures)
**Error:** `TypeError: fsSync.mkdirSync is not a function` (same root cause!)

These tests use `test/helpers/git-integration-helpers.ts` which imports `node:fs` directly for real filesystem operations. Same mock pollution.

## Files to Modify

1. `test/discovery/agent-registry.test.ts` — update `mock.module("node:fs")` to spread real fs
2. `test/discovery/session-watcher.test.ts` — same pattern (shares the same mock)
3. `test/ghostty/binary-manager.test.ts` — update `mock.module("node:fs")` to spread real fs

## Pattern to Use

Replace:
```typescript
mock.module("node:fs", () => ({
  readdirSync: () => dirContents,
  readFileSync: (filePath: string, _enc: string) => { ... },
  watch: () => ({ close: mock(() => {}), on: mock(() => {}) }),
}));
```

With:
```typescript
import * as realFs from "node:fs";
mock.module("node:fs", () => ({
  ...realFs,
  readdirSync: () => dirContents,
  readFileSync: (filePath: string, _enc: string) => { ... },
  watch: () => ({ close: mock(() => {}), on: mock(() => {}) }),
}));
```

## Verification

1. `bun test` must still pass locally (764 tests, 0 failures)
2. `just check` must pass
3. The key test: run tests in the SAME order as CI: `bun test test/commands test/git-sort test/mocks test/services test/tree-view test/ui test/utils test/types test/builders test/factories test/integration`
   - This is the CI test invocation that fails — verify this specific command passes

## Files NOT to Touch
- Any file in `src/` — no production code changes
- Any test file not related to `node:fs` mocking

## Definition of Done
- `bun test` passes (764+ tests, 0 failures)
- `just check` passes
- CI-order test invocation passes locally

SPEC COMPLETE
