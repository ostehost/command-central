# Test Suite Audit — Command Central
**Date:** 2026-04-03  
**Scope:** Speed, value, guard rails  
**Method:** Full suite timing, per-file timing, source analysis

---

## 1. Where the Time Goes

### 1.1 Measured runtimes per directory

| Directory | Tests | Files | Time | ms/test |
|---|---|---|---|---|
| `test/tree-view/` | 200 | 4 | **50.1s** | 250ms |
| `test/integration/` | 97 | 9 | **5.1s** | 53ms |
| `test/services/` | 146 | 16 | **1.1s** | 7.6ms |
| `test/commands/` | 126 | 10 | **0.84s** | 6.7ms |
| `test/git-sort/` | 129 | 13 | **0.72s** | 5.6ms |
| `test/ghostty/` | 82 | 4 | **0.33s** | 4.0ms |
| `test/discovery/` | 91 | 5 | **0.56s** | 6.2ms |
| `test/providers/` | 63 | 3 | **0.23s** | 3.6ms |
| `test/utils/` | 102 | 12 | **0.18s** | 1.8ms |
| All others combined | ~120 | 20 | **~0.4s** | ~3ms |
| **Total** | **~873** | **~90** | **~59s** | 68ms avg |

> **Note:** The Justfile help text at line 29 claims "593 tests, ~7-8s". This is severely outdated. Actual is ~873 tests in ~60s.

### 1.2 Top slowest test files

| Rank | File | Tests | Time |
|---|---|---|---|
| 1 | `test/tree-view/agent-status-tree-provider.test.ts` | 182 | **43.3s** |
| 2 | `test/tree-view/` (other 3 files combined) | 18 | **6.8s** |
| 3 | `test/integration/agent-notification-ux.test.ts` | ~15 | ~1.5s (est) |
| 4 | `test/integration/git-timestamps-integration.test.ts` | ~10 | ~0.8s (est) |
| 5 | `test/services/` (aggregate) | 146 | 1.1s |

### 1.3 Top slowest individual test cases

Per-test granular timing is not directly emitted by Bun's runner without `--reporter` flags. Based on code analysis, the worst performers in `agent-status-tree-provider.test.ts` are:

| Estimated rank | Test name | Why |
|---|---|---|
| 1 | Any test in `"completion notifications"` describe | Double `mock.restore()` (outer + inner beforeEach) + double `setupVSCodeMock()` |
| 2 | Any test in `"per-project emoji icons"` describe | Same double-restore pattern |
| 3 | `"live tasks snapshot keeps only genuine running tasks active..."` | Reads + processes 198KB fixture with 213 tasks |
| 4 | `"live tasks snapshot stays within the large-registry render budget"` | Same 213-task fixture, plus performance assertion loop |
| 5 | `"async diff completion schedules targeted task refreshes"` | Real `setTimeout(resolve, 10)` wait |
| 6 | `"readRegistry preserves completed_dirty..."` | Synchronous tmpdir create + JSON write + file read + cleanup |
| 7 | `"resolveTreeItem handles tmux failure gracefully"` | Calls real `execFileSync("tmux", ...)` which may block until timeout |
| 8–50 | Any test in the root `AgentStatusTreeProvider` describe | `mock.restore()` + `new ReviewTracker(unique-tmp-path)` + `provider.reload()` |

---

## 2. Root-Cause Analysis: Why `agent-status-tree-provider.test.ts` Is So Slow

### 2.1 `mock.restore()` in every `beforeEach` — primary driver

The outermost `describe("AgentStatusTreeProvider")` has a `beforeEach` that calls `mock.restore()` before every single test. Bun's `mock.restore()` reverts all `mock.module()` substitutions, forcing all affected modules to be re-evaluated from disk on the next import. This file has 4 top-level `mock.module()` calls:

```typescript
mock.module("node:fs", () => fs);
mock.module("node:child_process", () => ({ ...realChildProcess, execFileSync: execFileSyncMock }));
mock.module("../../src/utils/port-detector.js", ...);
// + vscode from setupVSCodeMock()
```

Additionally, three nested `describe` blocks have their **own** `beforeEach` that also calls `mock.restore()`:
- `describe("completion notifications")` — line 3547
- `describe("per-project emoji icons")` — line 4078
- `describe("port detection in tree")` — line 3958

In Bun, beforeEach hooks **stack**: an inner describe's beforeEach runs AFTER the outer describe's beforeEach. This means tests inside those nested blocks call `mock.restore()` **twice** per test, then re-run `setupVSCodeMock()` twice. The nested describes account for roughly 50–60 tests.

### 2.2 `setupVSCodeMock()` is expensive at scale

`setupVSCodeMock()` instantiates a deeply nested mock object with hundreds of `mock()` calls and registers it via `mock.module("vscode", ...)`. Called 182+ times across test runs (once per outer `beforeEach`, plus additional calls in nested `beforeEach` blocks).

### 2.3 New `ReviewTracker` with unique tmpdir path per test

```typescript
const rnd = Math.random().toString(36).slice(2);
provider.setReviewTracker(
    new ReviewTracker(
        path.join(os.tmpdir(), `cc-review-test-${Date.now()}-${rnd}.json`),
    ),
);
```

This is real filesystem I/O on every test: `ReviewTracker`'s constructor likely does an `fs.existsSync` or `fs.readFileSync` at init. Because each path is unique (timestamp + random), there is no reuse.

### 2.4 Large module re-evaluation cost

`AgentStatusTreeProvider` is a 5131-line source module. After each `mock.restore()`, the next test's import chain re-evaluates this module. At ~238ms average per test, this cost is spread across all 182 tests.

### 2.5 `provider.reload()` in `beforeEach` on empty registry — then overridden

Every `beforeEach` ends with:
```typescript
provider.readRegistry = () => createMockRegistry({});
provider.reload();
```

Most tests then override `readRegistry` and call `provider.reload()` again. The first reload in `beforeEach` is wasted work for most tests.

### 2.6 Large dogfood fixture — parsed per test, not cached

`loadDogfoodFixture()` reads `test/fixtures/agent-status/dogfood-live-tasks.json` (198KB, 4821 lines, 213 tasks) synchronously on every call. The function is called inside tests rather than at module scope, so it is re-parsed for each test that needs it.

### 2.7 Real fs I/O in "stuck agent detection" tests

5 tests in the "stuck agent detection" describe create and delete real files in `/tmp` to simulate stream file timestamps. Each test calls `fs.writeFileSync`, `fs.utimesSync`, and cleanup. This is inherently slower than in-memory state but is acceptably necessary for correctness.

### 2.8 Real `execFileSync` fallback

The `execFileSyncMock` passes unmatched calls through to real `execFileSync`. For `resolveTreeItem` tests with `status: "running"`, this may attempt a real tmux command and either fail fast (no tmux) or hit a timeout.

### 2.9 One real `setTimeout` wait

Line 2007: `await new Promise((resolve) => setTimeout(resolve, 10))` — minor (10ms) but avoidable with `useFakeTimers`.

---

## 3. Tests Likely Low-Value or Over-Specified

### 3.1 `formatElapsed` — 5 separate tests, could be a table

```typescript
describe("formatElapsed", () => {
    test("shows minutes for short durations", ...)
    test("shows hours and minutes for long durations", ...)
    test("omits zero minutes for exact-hour durations", ...)
    test("shows 0m for same time", ...)
    test("handles future start time gracefully", ...)
})
```
This is a pure formatting function. All 5 cases belong in a `test.each` table. No behavioral complexity justifies 5 separate describe entries.

### 3.2 `status icon mapping` and `agent type detection + icons` — trivially collapsible

These test status→icon and agent-type→icon mappings. Each case is one line of logic in the source. Multiple separate `test()` calls add overhead without adding clarity. One parameterized test per mapping group would be 60–70% faster with the same coverage.

### 3.3 Auto-refresh timer tests — private field access anti-pattern

```typescript
const p = provider as unknown as { autoRefreshTimer: NodeJS.Timeout | null };
expect(p.autoRefreshTimer).not.toBeNull();
```

4 tests inspect the private `autoRefreshTimer` field via type cast. These test implementation details. The public behavior (does the tree refresh after a delay?) is more stable to test. These tests will break if the private field is renamed.

### 3.4 `per-project emoji icons` describe — 3 tests with full provider setup each

This describe has its own `beforeEach` with `mock.restore()` + `setupVSCodeMock()` + new provider for 3 emoji-prefix tests. The emoji logic is simple (match project name, prepend emoji to label). These 3 tests could be a single `test.each` inside the outer describe without a nested `beforeEach`.

### 3.5 `completion notifications` — inner `beforeEach` redundant for setup

This describe creates a separate provider instance with its own `beforeEach`. Several of the notification tests set up state by calling `provider.reload()` twice (once in outer beforeEach, once in inner). The double-restore doubles overhead for ~15 tests.

### 3.6 UI copy string over-specification

Several tests assert exact format strings like:
- `"Stale — session ended without completion signal"`
- `"(possibly stuck)"`
- `"3 files · +45 -12"`

Copy changes will break these tests. Better to assert on structured data (icon id, contextValue) and only check that a meaningful description exists, not its exact wording.

### 3.7 Dogfood fixture tests over-specify render counts

```typescript
expect(getTaskNodes(children)).toHaveLength(50);
expect(getOlderRunsNode(children).hiddenNodes.length).toBeGreaterThan(150);
```

These numbers (50 visible, >150 hidden) are implementation-level render budget constants. When the budget changes, these tests break without indicating a real user-visible regression.

---

## 4. Recommended Test Pyramid

```
         ┌────────────────────────────────────────────────────────┐
         │  SLOW / SCENARIO (CI only, ~50s)                       │
         │  agent-status-tree-provider.test.ts                     │
         │  dogfood fixture tests                                  │
         └─────────────────┬──────────────────────────────────────┘
                           │
         ┌─────────────────┴──────────────────────────────────────┐
         │  INTEGRATION (~5–10s)                                   │
         │  test/integration/ (cross-component, real git)          │
         │  test/tree-view/ (non-mega files)                       │
         └─────────────────┬──────────────────────────────────────┘
                           │
         ┌─────────────────┴──────────────────────────────────────┐
         │  FAST UNIT (<3s)                                        │
         │  test/utils/, test/types/, test/state/                  │
         │  test/services/, test/commands/, test/git-sort/          │
         │  test/providers/ (mocked), test/discovery/              │
         └────────────────────────────────────────────────────────┘
```

**Target runtimes:**
- Fast unit: < 3s (pre-commit eligible)
- Integration: < 10s (PR gate)
- Slow/scenario: < 60s (CI-only, not blocking PR review start)

---

## 5. Current Justfile/Command Structure — Mismatches

### 5.1 Help text is severely outdated (line 29)

```
just test                Run all tests (593 tests, ~7-8s)
```
Actual: **~873 tests, ~60s**. The expected count and time are both wrong by 2–3×.

### 5.2 `just test-integration` runs the slowest code in the suite

```just
test-integration:
    @bun run _test:integration && bun run _test:tree-view-patterns
```

`_test:tree-view-patterns` runs `bun test test/tree-view/` — which includes the 43s mega-test file. An "integration" command that takes 55s is not useful for quick iteration. The tree-view tests are primarily behavioral/unit tests for `AgentStatusTreeProvider`, not integration tests.

### 5.3 `just test-unit` excludes most unit tests

```just
test-unit:
    @bun run _test:git2 && _test:git4 && _test:git5 && _test:core && _test:mocks
```

This command omits: `test/commands/`, `test/types/`, `test/state/`, `test/utils/`, `test/providers/`, `test/ui/`, `test/package-json/`, `test/discovery/`, and `test/ghostty/`. Most of these are fast (<100ms each). The "unit" label is misleading.

### 5.4 `just test` runs `test-quality` only for full suite, not filtered runs

The `test` recipe only runs quality checks (`test-quality`) when invoked with no arguments. Running `just test tree-view` skips quality gates entirely. Developers running targeted tests never see the quality report.

### 5.5 No explicit "fast feedback" command for common cases

There is no command to quickly verify "did I break anything obvious?" without running the full 60s suite. `just test-unit` is incomplete. This pushes developers toward either skipping tests or running the full slow suite.

---

## 6. Recommended CI Command Structure

### Pre-commit (< 5s)
```bash
just check        # biome + tsc + knip (already fast, <3s)
just test-fast    # NEW: unit tests excluding tree-view mega-file
```
`test-fast` would run everything except `test/tree-view/agent-status-tree-provider.test.ts` and `test/integration/`. Estimate: ~8s total.

### Local `just test` (< 15s target)
Remove tree-view from the default `just test` invocation or add a `--bail` flag. Run the mega-file separately only when asked. The goal is developer confidence in < 15s, not exhaustive coverage in the hot path.

### CI-only (full, ~60s)
Keep current `just test` for CI. The full suite should run on every PR but should not block pre-commit or local iteration.

**Proposed new Justfile recipes:**

```just
# Fast feedback: everything except the mega-test file (~8s)
test-fast:
    @bun test test/commands/ test/config/ test/discovery/ test/events/ \
              test/git-sort/ test/helpers/ test/mocks/ test/package-json/ \
              test/ghostty/ test/providers/ test/scripts-v2/ test/services/ \
              test/state/ test/types/ test/ui/ test/utils/
    @bun test test/tree-view/agent-status-tree-provider-per-file-diff.test.ts \
              test/tree-view/native-commands.test.ts \
              test/tree-view/openclaw-task-nodes.test.ts
    @just test-quality

# Slow tests: the mega-file + integration (run separately)
test-slow:
    @bun test test/tree-view/agent-status-tree-provider.test.ts
    @bun test test/integration/ test/discovery-e2e/
```

---

## 7. Surgical Fix Opportunities (Low Risk)

### Fix 1: Cache the dogfood fixture at module scope (safe, ~1–2s savings)

In `agent-status-tree-provider.test.ts`, move fixture loading to module scope:

```typescript
// BEFORE: reads 198KB JSON on every call
function loadDogfoodFixture(): TaskRegistry {
    const fixture = loadAgentStatusFixture("dogfood-live-tasks.json");
    ...
}

// AFTER: parse once, copy per test
const _dogfoodFixtureRaw = loadAgentStatusFixture("dogfood-live-tasks.json");
function loadDogfoodFixture(): TaskRegistry {
    const fixture = _dogfoodFixtureRaw;  // already in memory
    ...
}
```

Since `loadDogfoodFixture()` creates new timestamp-based IDs each call, the copy does not introduce shared state. This saves one 198KB JSON parse per test.

### Fix 2: Move `provider.reload()` out of the outer `beforeEach` for tests that always override it

Most tests in the outer `AgentStatusTreeProvider` describe override `readRegistry` and call `provider.reload()` themselves. The `provider.reload()` in `beforeEach` (with empty registry) is wasted work. Removing it from `beforeEach` and adding it only where needed would save 182 empty-registry reload cycles, at the cost of minor test verbosity.

This is a higher-risk refactor (many tests may depend on the default empty state). It should be done carefully with a full test run after each change.

### Fix 3: Parameterize `formatElapsed` tests (zero risk, minimal gain)

Replace 5 separate `test()` calls with one `test.each()`. Saves zero real time (the suite startup cost dominates), but improves maintainability and demonstrates the right pattern for future contributors.

### Fix 4: Update Justfile help text to reflect actual counts (no-risk documentation fix)

Line 29 of Justfile:
```
"  just test                Run all tests (593 tests, ~7-8s)\n"
```
Should be:
```
"  just test                Run all tests (~873 tests, ~60s)\n"
```

Also line 404: `echo "📋 Test Files (46 total):"` should reflect the actual count.

---

## 8. Do Not Attempt Without Deeper Analysis

The following would likely yield the largest speedups but carry meaningful regression risk:

- **Removing `mock.restore()` from outer `beforeEach`** — The restore is there because `mock.module()` state leaks between tests. Removing it requires ensuring that top-level module mocks are stable across all 182 tests. This needs careful per-test mock isolation analysis.

- **Splitting `agent-status-tree-provider.test.ts` into unit/integration files** — The file mixes pure logic tests (formatElapsed, icon mapping) with heavy integration tests (dogfood fixture, completion notifications). Splitting into `agent-status-tree-provider-unit.test.ts` and `agent-status-tree-provider-integration.test.ts` would allow the fast path to skip the integration file. Safe to do, but requires careful verification that all tests pass in isolation.

- **Replacing `new ReviewTracker(unique-tmp-path)` with an in-memory mock** — The ReviewTracker is tested in its own file (`test/services/review-tracker.test.ts`). In `agent-status-tree-provider.test.ts`, it exists only to avoid cross-test pollution from the real `~/.config/command-central/reviewed-tasks.json`. An in-memory mock would be faster and equivalent. Low regression risk but requires a small API change.

---

## Summary Table

| Finding | Impact | Risk to fix | Effort |
|---|---|---|---|
| `mock.restore()` + double-restore in nested beforeEach | ~20–30s | High | High |
| `new ReviewTracker(unique-tmp-path)` per test | ~2–5s | Low | Medium |
| Dogfood fixture not cached at module scope | ~1–2s | Low | Low |
| Wasted `provider.reload()` in beforeEach | ~1–3s | Medium | Medium |
| `just test` help text wrong (593/7-8s) | Confusion | Zero | Minutes |
| `just test-unit` missing most unit dirs | Misleading | Zero | Minutes |
| `just test-integration` runs 50s tree-view file | Slowness | Low | Minutes |
| `formatElapsed` not parameterized | Maintainability | Zero | Low |
| Auto-refresh timer tests access private fields | Fragility | Zero | Medium |
| UI copy string over-specification | Brittleness | Zero | Low |

---

AUDIT COMPLETE
