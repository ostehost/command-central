# Handoff — Command Central test suite performance

**Date:** 2026-04-17
**Status:** Green. Full `just test` matches hub baseline (~6s vs. 842s before).

## What was broken

Five compounding bugs produced a 140× suite slowdown on the M1 Max node while the M4 hub stayed fast. Root cause in one sentence: **`AgentStatusTreeProvider`'s constructor starts a real `AgentRegistry` that spawns `ps`/`lsof`, and every test that instantiated a provider inherited that.**

The cascade (each amplified the previous):

1. **`promisify(execFile)` at module scope** in `src/discovery/process-scanner.ts` captured real `execFile` at load time, bypassing later `mock.module("node:child_process", …)` — tests were silently running real `ps`/`lsof`.
2. **Live-namespace spread anti-pattern** in ~18 test files: `import * as realFs from "node:fs"` + `{ ...realFs, … }` spreads the already-mocked namespace (Bun binding semantics), creating self-referential mocks.
3. **Tree-view harness fell through to real `execFileSync`** for unknown commands — contributor but not dominant.
4. **`AgentStatusTreeProvider` constructor calls `initDiscovery()`** which reads `config.get("discovery.enabled", true)` and, when true, creates a real `AgentRegistry` and calls `.start()` — fire-and-forget `ps`/`lsof` spawns.
5. **Test `vscode-mock` returned `defaultValue` for every config key**, so production's default `discovery.enabled=true` always won in tests.

## What was fixed (all in tree, uncommitted)

| Kind | File(s) | Fix |
|---|---|---|
| **Source** | `src/discovery/process-scanner.ts` | Replaced module-scope `promisify(execFile)` with closure wrapper so `execFile` resolves via ES live binding on each call. |
| **Source** | `src/ghostty/window-focus.ts` | Same promisify-trap fix. |
| **Source** | `src/discovery/agent-registry.ts` | Added `fireIfChanged()` — `onDidChange` now only emits when discovered-agent snapshot actually differs. Prevents 5s-poll-driven spurious TreeView re-renders. Bumped `discovery.pollInterval` default from 5s → 30s. |
| **Test infra** | `test/setup/global-test-cleanup.ts` | Stashes frozen snapshots of `node:fs`, `node:fs/promises`, `node:child_process` on `globalThis.__realNode*`. Added `CC_HARNESS_TRACE=1` diagnostic. |
| **Test infra** | `test/helpers/vscode-mock.ts` | Default `getConfiguration().get()` now returns `false` for `discovery.enabled`. Tests that need discovery on opt in via `setAgentStatusConfig(vscodeMock, { "discovery.enabled": true })`. **This is the single change that closed the hub-vs-node gap.** |
| **Test files** | 18 files | Replaced `import * as realX from "node:…"` with `globalThis.__realNode*` lookups. |
| **Test files** | `test/discovery/agent-registry.test.ts` | Pass-through mocks for ps/child_process + `afterEach(() => registry.dispose())` + `process.kill` restore in `afterAll`. |
| **Test files** | `test/tree-view/_helpers/agent-status-tree-provider-test-base.ts` + `agent-status-tree-provider-per-file-diff.test.ts` | Switched to preload snapshots; added per-stage timing instrumentation. |
| **Config** | `bunfig.toml` | `coverage = false` by default (16,000× regression with fs mocks + coverage on). Opt in via `bun run test:coverage`. |
| **Config** | `package.json`, `justfile` | Added `test:coverage` script; `just ci` uses it. |

## Bun-specific gotchas codified

- `mock.module()` is process-global. `mock.restore()` does **not** undo module mocks (Bun issues #7823, #12823). Per-file isolation (#6024) is unimplemented.
- Therefore any file-scope `mock.module(core)` contaminates all subsequent files. Mitigation: spread `globalThis.__realNode*` so fall-throughs hit real, frozen impls; re-register mocks in `beforeEach`; avoid monkey-patching core modules (prefer dependency injection).
- `import * as ns` creates a live namespace binding that reflects the currently-mocked module — never spread it.
- `promisify(fn)` captures `fn` at call time. Never use `promisify(execFile)` at module scope.

## Deferred architectural work (ordered by impact)

### A. Pure constructor + explicit `start()` for `AgentStatusTreeProvider` (~1 day, moderate risk)

Current: constructor kicks off `setupFileWatch()`, `reload()`, `initDiscovery()`. The vscode-mock default `discovery.enabled=false` masks this for tests, but the underlying pattern is the root-cause that the mock is compensating for.

Target:
- Constructor is pure wiring; takes `{ projectIconManager, agentRegistry, reviewTracker }` deps.
- `start(): void` becomes the lifecycle boundary.
- `extension.ts` activate() calls `new AgentStatusTreeProvider(deps); provider.start();`.
- Tests need zero vscode-mock config tricks.

### B. Three-layer `AgentRegistry` split (~1 day)
Extract pure merge logic to `AgentMerger`. Sources (`ProcessSource`, `SessionSource`, `LauncherSource`, `AcpSource`) own their handles. `AgentRegistry` becomes a thin orchestrator. Unlocks input→output tests with zero mocks for ~80% of the merge surface.

### C. VS Code-native file watchers (~0.5 day)
6 services use raw `fs.watch` for paths outside the workspace. `vscode.workspace.createFileSystemWatcher` with `RelativePattern` and absolute bases now handles external paths and gets dedup, batching, macOS rename correctness from Parcel.

### D. `setInterval` → self-rescheduling `setTimeout` + single-flight (~0.5 day)
4 callsites. Prevents timer stacking under load.

### E. `AbortController` on all shell-outs (~0.5 day)
`process-scanner.ts`, any other `execFile` callsites. `signal: ac.signal` + `ac.abort()` in `dispose()` = instant cancel, no leaked pipes.

### F. Split `agent-status-tree-provider.ts` (6,314 lines) into rendering / orchestrator / pure helpers (~1–2 days)

## Diagnostic available for next regression

`CC_HARNESS_TRACE=1 bun test …` dumps per-stage timing from the tree-view harness (`setupVSCodeMock`, `new AgentStatusTreeProvider`, `provider.reload()`) and per-command real-execFileSync fall-through counts + wall time. First thing to run if the suite slows down again.

## Files on disk (for the next agent to review)

```
 M bunfig.toml
 M justfile
 M package.json
 M src/discovery/agent-registry.ts
 M src/discovery/process-scanner.ts
 M src/ghostty/window-focus.ts
 M test/setup/global-test-cleanup.ts
 M test/helpers/vscode-mock.ts
 M test/discovery/agent-registry.test.ts
 M test/discovery/session-watcher.test.ts
 M test/ghostty/binary-manager.test.ts
 M test/ghostty/terminal-manager.test.ts
 M test/ghostty/window-focus.test.ts
 M test/tree-view/_helpers/agent-status-tree-provider-test-base.ts
 M test/tree-view/agent-status-tree-provider-per-file-diff.test.ts
 M test/commands/resume-session.test.ts
 M test/git-sort/sorted-changes-provider-badge-sync.test.ts
 M test/git-sort/sorted-changes-provider-empty-state.test.ts
 M test/git-sort/sorted-changes-provider-grouping-bugs.test.ts
 M test/services/test-count-status-bar.test.ts
 M test/tree-view/agent-status-dead-process-running.test.ts
 M test/tree-view/agent-status-handoff-file.test.ts
 M test/tree-view/agent-status-review-and-handoff.test.ts
 M test/tree-view/agent-status-tree-provider-diff-notifications.test.ts
 M test/tree-view/agent-status-tree-provider-health.test.ts
 M test/tree-view/agent-status-tree-provider-read-registry.test.ts
 M test/tree-view/agent-status-tree-provider.test.ts
 M test/utils/persist-health.test.ts
 M test/utils/port-detector.test.ts
 M test/utils/tasks-file-resolver.test.ts
 M test/utils/tmux-pane-health.test.ts
?? STANDARDS.md
?? research/HANDOFF-cc-test-suite-perf-2026-04-17.md
```

Suggest committing in two logical chunks: (1) production source fixes + config, (2) test infrastructure. The preload + vscode-mock changes are load-bearing; they should be in the same commit or the earlier one to avoid a bisect landing mid-way.
