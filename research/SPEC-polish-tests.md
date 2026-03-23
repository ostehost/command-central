# SPEC: High-Value Polish Tests

> Goal: Add tests that protect real user-facing behavior and would break if actual functionality becomes unusable. NOT coverage theater.

## Context

733 tests passing. Two critical modules have zero tests and one has weak tests:

1. **WorkspaceProjectSource** (0 tests) — Maps workspace folders to sidebar view slots
2. **AgentRegistry dedup/merge** (weak tests) — Merges 3 discovery sources into unified agent list
3. **ProjectIconService** (0 tests) — Status bar icon from workspace config

## Task 1: `test/config/workspace-project-source.test.ts` (NEW)

Source: `src/config/workspace-project-source.ts` (161 lines)

### What breaks if this is wrong:
- Users with multi-folder workspaces see NO projects in sidebar
- Slots get mapped incorrectly (wrong project in wrong slot)
- >10 folders crashes or shows no warning
- Custom project icons (`commandCentral.project.icon`) don't display

### Tests to write:

```
describe("WorkspaceProjectSource")
  test("maps single workspace folder to slot1")
  test("maps multiple workspace folders to sequential slots")
  test("extracts folder name from filesystem path correctly")
  test("limits to 10 slots when >10 workspace folders present")
  test("shows truncation warning once for >10 folders")
  test("does not show truncation warning for ≤10 folders")
  test("returns empty array when no workspace folders exist")
  test("clears all 10 slots before mapping new ones")
  test("sets context keys for active slots")
  test("reads custom project.icon from workspace-folder settings")
  test("prepends custom icon emoji to folder display name")
  test("works without custom icon (just folder name)")
```

### Mock pattern:
Mock `vscode.workspace.workspaceFolders`, `vscode.commands.executeCommand`, `vscode.workspace.getConfiguration`, `vscode.window.showInformationMessage`. Use the same mock patterns as `test/services/grouping-state.test.ts`.

### Interface to implement against:
```typescript
interface ProjectViewConfig {
  id: string;        // "slot1" through "slot10"
  displayName: string;
  iconPath: string;
  gitPath: string;
  description: string | undefined;
  sortOrder: number;
}
```

## Task 2: Strengthen `test/discovery/agent-registry.test.ts` (EXISTING)

Source: `src/discovery/agent-registry.ts` (200 lines)

### What breaks if dedup/merge is wrong:
- Same agent shows up twice (once from session file, once from ps scan)
- Agent loses its model info when merged
- Wrong source wins priority — process source overrides richer session-file data
- Launcher-tracked agents also show up in "Discovered" section (double-counting)

### Tests to ADD (in existing file, new describe blocks):

```
describe("dedup priority resolution")
  test("session-file source wins over process source for same PID")
  test("process source fields fill in when session-file is missing model")
  test("launcher source wins over session-file for same PID")
  test("three sources for same PID → launcher fields take precedence")

describe("field merging on dedup")
  test("model from process source preserved when session-file has no model")
  test("sessionId from session-file preserved when process has none")
  test("projectDir from higher-priority source wins")

describe("getDiscoveredAgents filtering")
  test("PID match against launcher task filters correctly")
  test("sessionId match against launcher task filters correctly")
  test("agent with different PID AND sessionId passes through")

describe("polling lifecycle")
  test("startPolling creates interval timer")
  test("stopPolling clears interval")
  test("restartPolling clears old timer and creates new one")
  test("dispose stops polling and cleans up")
```

### Key: test the PRIVATE `dedup` method via public API
Call `start()` with controlled mock data, then `getAllDiscovered()` / `getDiscoveredAgents()` to verify merge results.

## Task 3: `test/services/project-icon-service.test.ts` (NEW)

Source: `src/services/project-icon-service.ts` (171 lines)

### What breaks if this is wrong:
- No project icon in status bar even when configured
- Icon doesn't update when user changes settings
- Status bar item not disposed (memory leak)

### Tests to write:

```
describe("ProjectIconService")
  test("creates status bar item when icon configured")
  test("shows configured emoji as status bar text")
  test("uses folder name as tooltip when no custom name")
  test("hides status bar when no icon configured")
  test("refreshes when commandCentral.project config changes")
  test("does not refresh for unrelated config changes")
  test("dispose cleans up status bar item and listeners")
```

## Constraints

- Use `bun:test` (NOT jest)
- Follow existing mock patterns in the project
- Use `import { beforeEach, describe, expect, mock, test } from "bun:test"`
- Mock vscode module at top of file using `mock.module("vscode", ...)`
- Each test must assert something that would catch a real regression
- NO testing implementation details — test observable behavior
- Run `bun test` to verify all tests pass when done
- Run `bun test` on the FULL suite to make sure nothing existing breaks

## Files NOT to touch
- Any file in `src/` (we're only adding tests)
- Any existing test file besides `test/discovery/agent-registry.test.ts`

## Definition of Done
- All new tests pass with `bun test`
- Full test suite still passes (733+ tests, 0 failures)
- Tests actually exercise the real code paths (not just mock-to-mock)

SPEC COMPLETE
