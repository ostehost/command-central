# RESULT — Command Central activation modularization plan

- Task: `cc-activation-modularization-plan-fable-20260610`
- Role: planner (read-only; no code changes made — rationale in §6)
- Date: 2026-06-10
- Base: `main` @ `4477b628` (rc53 cut, green)

## 0. Evidence inventory

| Fact | Evidence |
|---|---|
| `src/extension.ts` is 3,819 lines; `activate()` spans lines 198–3755 | `wc -l`, file read |
| 67 inline `vscode.commands.registerCommand` call sites in `extension.ts` | `grep -n registerCommand` |
| `package.json` contributes 126 commands = 66 base + 60 generated slot commands | `jq '.contributes.commands[].command'` |
| Registered set == contributed non-slot set, exactly (66 = 66, empty diff both directions) | `comm` diff of extracted IDs |
| Slot commands (`gitSort.{refreshView,changeSortOrder,changeFileFilter}.slotN[Panel]`) register in `src/services/project-view-manager.ts:535–612`, **not** in `extension.ts` | grep |
| Real-VS-Code proof that every non-slot contributed command registers on activation already exists | `test/integration/suite/commands-registered.test.ts` (contract ratified in `research/CONTRACT-DECISION-test-electron-commands-registered-2026-04-21.md`), run via `just test-electron` |
| Installed-VSIX runtime proof executes contributed commands from real tree nodes | `test/integration/runInstalledVsixAgentStatusProof.ts` via `just test-installed-vsix-agent-status [--live]` |
| Unit tests for `extension.ts` handlers **re-simulate handler logic inline** ("tested via their handler logic patterns, not by loading extension.ts") | `test/commands/extension-commands.test.ts` header comment |
| Repo precedent for extraction already exists | `src/services/integration-test-api.ts` (extracted; `extension.ts:117–132` re-exports types), thin-handler modules in `src/commands/` |

## 1. Command clusters in `activate()`, ranked by safe extraction order

Line numbers refer to `src/extension.ts` @ `4477b628`.

| Rank | Cluster | Lines | Commands | Why this rank |
|---|---|---|---|---|
| 1 | **Cron feature** | 785–852 | 8: `cron.refresh/runNow/enable/disable/create/edit/delete/viewHistory` | Fully self-contained: service + tree provider + view + commands all constructed locally; zero shared module state; 4 handlers are placeholder toasts |
| 2 | **Leaf singles** | 745–754, 964–975, 3689–3710 | 3: `copyToClipboard`, `openInfrastructureDashboard`, `command-central.showTestCount` | Zero or one dependency each (`testCountStatusBar` is module state → getter) |
| 3 | **Grouping** | 389–436 | 2: `grouping.toggle`, `grouping.selectOption` | Two deps (`groupingViewManager` getter, telemetry); handlers thin |
| 4 | **Git Sort + tree-view utils** | 439–742 | 19: `gitSort.enable/disable/refreshView/changeSortOrder/changeFileFilter/openChange/openFile/openDiff/revealInExplorer/copyPath/copyRelativePath/openToSide/selectForCompare/compareWithSelected/revealInFinder/openInIntegratedTerminal/openWith/openPreview` | Handlers are already thin shims over `src/commands/tree-view-utils.ts`, `enable-sort.ts`, `disable-sort.ts`, `filter-by-extension-command.ts`. One late-binding hazard: `openInIntegratedTerminal` captures `terminalManager` (initialized later at line 3518) |
| 5 | **Ghostty** | 3534–3672 | 2: `ghostty.createTerminal`, `ghostty.checkBinary` | Self-contained; registered *after* `terminalManager`/`binaryManager` init so deps can be getters without ordering surprises |
| 6 | **Agent registry mutations** | 2199–2614 (subset), helpers 1527–1570 | 7: `captureAgentOutput`, `killAgent`, `clearCompletedAgents`, `markStaleAgentFailed`, `reapStaleAgents`, `removeAgentTask`, `markAgentReviewed` | All follow one shape: validate node → `agentStatusProvider.filePath` → mutate tasks.json via `writeRegistryWithBackup`/`mutateAgentTaskRegistry` → reload. Pure logic already lives in `src/utils/agent-task-registry.ts` (unit-tested). Moves the two registry-write helper closures with it |
| 7 | **Agent navigation / filters / info** | 1576–1611, 2044–2197, 2616–2632, 3289–3382, 1005–1013 | 14: `defaultAgentAction`, `agentStatus.focus`, `refreshAgentStatus`, `showDiscoveryDiagnostics`, `changeProjectIcon`, `toggleProjectGrouping`, `toggleProjectGroupingFlat`, `filterToProject`, `filterCurrentProject`, `clearProjectFilter`, `selectProjectFilter`, `focusNextRunningAgent`, `openAgentDirectory`, `listWorktrees`, plus `openAgentDashboard` | Mostly thin delegations to `agentStatusProvider` or `executeCommand` indirection (loose coupling already). `defaultAgentAction` only routes to other commands |
| 8 | **Diff / file viewing** | 2987–3287, helper 1207–1301 | 3: `viewAgentDiff`, `smartOpenFile`, `openFileDiff` + `showGitDiffAsFilePicker` helper | `openFileDiff` is ~170 lines of inline pure-ish logic (git show, binary detection) — biggest single de-bloat win; depends on `DiffContentProvider`/`buildDiffContentUri` only |
| 9 | **OpenClaw task pair** | 2919–2985 | 2: `cancelOpenClawTask`, `showOpenClawTaskDetail` | Small; deps are `openclawTaskService`, an output channel, `execFileAsync` |
| 10 | **Terminal focus / resume core** — **DO NOT MOVE YET** | 1066–1525 (helper web), 1614–2042, 2634–2917, 3384–3511 | 6: `focusAgentTerminal`, `agentQuickActions`, `resumeAgentSession`, `showAgentOutput`, `restartAgent`, `launchAgent` | See §5. Safety-critical no-silent-fallback surface entangled with a ~460-line shared closure web and late-bound `terminalManager` |

Out of scope entirely: the 60 generated slot commands (owned by `ProjectViewManager`), and the project-views composition root (lines 264–386) — that is service wiring, not command registration, and it feeds the integration-test API.

## 2. Proposed module boundaries and DI signatures

New directory: `src/activation/` (keeps `src/commands/` for pure command logic, matching the existing thin-shim convention). Each module exports one registration function returning `vscode.Disposable[]`; `extension.ts` keeps lifecycle ownership and does `context.subscriptions.push(...registerX(deps))`.

**The one non-negotiable DI rule** (derived from the late-binding hazard, §5.1): any dependency held in a module-level `let` that is (re)assigned during activation or reset in `deactivate()` — `terminalManager`, `binaryManager`, `agentStatusProvider`, `symphonyProvider`, `projectViewManager`, `extensionFilterViewManager`, `groupingViewManager`, `gitSorter`, `testCountStatusBar` — must be passed as a **getter** (`() => T | undefined`), never as a value. Values are fine only for `activate()`-local consts created before the registration call (`sessionStore`, `telemetry`, `extensionFilterState`, output channels, services).

```ts
// src/activation/cron-feature.ts — whole-feature extraction (Lane 1)
export function activateCronFeature(context: vscode.ExtensionContext): void;
// constructs CronService + CronTreeProvider + TreeView + registers 8 commands internally

// src/activation/register-grouping-commands.ts
export interface GroupingCommandDeps {
  getGroupingViewManager: () => GroupingViewManager | undefined;
  telemetry: TelemetryService;
  logger: LoggerService;
}
export function registerGroupingCommands(deps: GroupingCommandDeps): vscode.Disposable[];

// src/activation/register-git-sort-commands.ts
export interface GitSortCommandDeps {
  getGitSorter: () => GitSorter | undefined;
  getProjectViewManager: () => ProjectViewManager | undefined;
  extensionFilterState: ExtensionFilterState;
  getExtensionFilterViewManager: () => ExtensionFilterViewManager | undefined;
  getTerminalManager: () => TerminalManager | undefined; // late-bound (init at extension.ts:3518)
  logger: LoggerService; // gitSortLogger
}
export function registerGitSortCommands(deps: GitSortCommandDeps): vscode.Disposable[];

// src/activation/register-ghostty-commands.ts
export interface GhosttyCommandDeps {
  getTerminalManager: () => TerminalManager | undefined;
  getBinaryManager: () => BinaryManager | undefined;
  logger: LoggerService;
}
export function registerGhosttyCommands(deps: GhosttyCommandDeps): vscode.Disposable[];

// src/activation/register-misc-commands.ts (copyToClipboard, openInfrastructureDashboard, showTestCount)
export interface MiscCommandDeps {
  getTestCountStatusBar: () => TestCountStatusBar | undefined;
  logger: LoggerService;
}
export function registerMiscCommands(deps: MiscCommandDeps): vscode.Disposable[];

// src/activation/register-agent-registry-commands.ts
export interface AgentRegistryCommandDeps {
  getAgentStatusProvider: () => AgentStatusTreeProvider | undefined;
  getTerminalManager: () => TerminalManager | undefined; // captureAgentOutput/killAgent resolve helper scripts
  agentOutputChannel: vscode.OutputChannel;
}
export function registerAgentRegistryCommands(deps: AgentRegistryCommandDeps): vscode.Disposable[];
// moves writeRegistryWithBackup + mutateAgentTaskRegistry (extension.ts:1527–1570) into this module
// (or into src/utils/agent-task-registry.ts beside the pure helpers they wrap)

// src/activation/register-agent-navigation-commands.ts
export interface AgentNavigationCommandDeps {
  getAgentStatusProvider: () => AgentStatusTreeProvider | undefined;
  getTerminalManager: () => TerminalManager | undefined; // changeProjectIcon bundle refresh
  projectIconManager: ProjectIconManager; // projectIconManagerForAgents
  agentDashboardPanel: AgentDashboardPanel;
  discoveryDiagnosticsChannel: vscode.OutputChannel;
  syncAgentStatusViewContexts: () => Promise<void>;
  logger: LoggerService;
}
export function registerAgentNavigationCommands(deps: AgentNavigationCommandDeps): vscode.Disposable[];

// src/activation/register-agent-diff-commands.ts
export interface AgentDiffCommandDeps {
  getAgentStatusProvider: () => AgentStatusTreeProvider | undefined;
}
export function registerAgentDiffCommands(deps: AgentDiffCommandDeps): vscode.Disposable[];
// showGitDiffAsFilePicker moves here as a module-private function;
// openFileDiff's readFileAtRef/readWorkingTreeFile/binary detection become exported pure
// functions so test/commands/file-diff-temp-dir.test.ts-style unit tests can hit them directly

// src/activation/register-openclaw-task-commands.ts
export interface OpenClawTaskCommandDeps {
  openclawTaskService: OpenClawTaskService;
  getAgentStatusProvider: () => AgentStatusTreeProvider | undefined;
  openclawTaskOutputChannel: vscode.OutputChannel;
}
export function registerOpenClawTaskCommands(deps: OpenClawTaskCommandDeps): vscode.Disposable[];

// src/activation/agent-terminal-context.ts — PREPARATORY ONLY, for the deferred Lane 6
export interface AgentTerminalContext {
  getTerminalManager: () => TerminalManager | undefined;
  getAgentStatusProvider: () => AgentStatusTreeProvider | undefined;
  sessionStore: SessionStore;
  telemetry: TelemetryService;
  agentOutputChannels: AgentOutputChannels;
  // the helper web (isTaskTmuxSessionAlive, runResumeInTaskTerminal,
  // runCommandInProjectTerminalWithFallback, showRemoteNodeTaskSurfaceOptions, …)
  // migrates onto this context incrementally before any Lane 6 command moves
}
```

Target end state for `extension.ts`: composition root + lifecycle (`activate` wiring, `deactivate`, module-state getters, integration-test API deps) at roughly 1,200–1,500 lines after Lanes 1–5, before any decision on Lane 6.

## 3. Non-overlap implementation lanes for Fable agents

All lanes edit `extension.ts`, so **land sequentially in this order** (each lane rebases on the previous). Parallel-in-worktrees is possible but the rebase cost on one shared file outweighs it; the lanes are sized for single-session execution. Ownership is disjoint by extension.ts line range + new files.

| Lane | Owns (extension.ts ranges @ 4477b628) | New files | Commands moved | Est. line reduction |
|---|---|---|---|---|
| **L1: cron** | 785–852 | `src/activation/cron-feature.ts`, `test/commands/cron-feature-registration.test.ts` | 8 | ~70 |
| **L2: git-sort + grouping + misc singles** | 389–754, 964–973, 3689–3710 | `register-git-sort-commands.ts`, `register-grouping-commands.ts`, `register-misc-commands.ts` + registration tests | 24 | ~390 |
| **L3: ghostty** | 3534–3672 | `register-ghostty-commands.ts` + test | 2 | ~140 |
| **L4: agent registry mutations** | 1527–1570, 2199–2330 (capture/kill), 2331–2614 (clear/stale/reap/remove/reviewed) | `register-agent-registry-commands.ts` + test; convert the corresponding simulation blocks in `test/commands/extension-commands.test.ts` to real-handler imports | 7 | ~480 |
| **L5: navigation + diff + openclaw** | 1005–1013, 1576–1611, 2044–2197, 2616–2632, 2919–3382 | `register-agent-navigation-commands.ts`, `register-agent-diff-commands.ts`, `register-openclaw-task-commands.ts` + tests | 19 | ~900 |
| **L6: terminal focus/resume core — deferred** | 1066–1525, 1614–2042, 2634–2917, 3384–3511 | `agent-terminal-context.ts` first; command moves only after L1–L5 are proven in an installed preview | 6 | ~1,500 (eventually) |

Lane rule: a lane may not touch another lane's ranges, may not reorder surviving code between clusters, and must keep the registration *sequence* of its own commands identical (some handlers route to commands registered by other clusters via `executeCommand`, which tolerates any order — but activation side effects like telemetry and `mainLogger.info` milestones should stay in place).

## 4. Required tests/proofs per lane

Every lane, in order:

1. **New registration-shape unit test** (per new module): register against the bun `setupVSCodeMock()` helper, assert (a) the exact command-ID set the module registers, (b) it returns one disposable per command, (c) getter deps are invoked lazily (call the handler before the getter target exists → graceful path, not a crash). This encodes the late-binding contract.
2. `just ready` — fix + check (biome/tsc/knip) + full `bun test` (~6s). Knip note: module exports consumed only by `extension.ts` are fine (`ignoreExportsUsedInFile` is set, and cross-file imports count as usage).
3. `just test-integration` — multi-workspace, discovery e2e, tree-view patterns.
4. **`just test-electron`** (MacBook node only — `scripts-v2/node-execution-guard.ts` enforces this). This is the contributed-command runtime proof: `commands-registered.test.ts` asserts all 66 non-slot contributed commands are live in a real VS Code host, plus `activation`/`command-executes`/`deactivation`/`tree-view-renders` scenarios. **No lane lands without this passing.**
5. Lanes L4–L6 (agent surfaces) additionally: `just test-installed-vsix-agent-status`, with `--live` + `COMMAND_CENTRAL_REQUIRED_TASK_ID` action probes for L6 if it ever proceeds — that suite executes commands off real tree nodes in the installed VSIX.
6. `just dist --dry-run` — VSIX content gate (≤600KB/≤2MB/≤120 files). New `src/` files bundle into the single dist output, so file count must not change; this run proves it.
7. Per-lane handler-test conversion: where `test/commands/extension-commands.test.ts` currently *simulates* a moved handler's logic, replace the simulation with a direct import of the real handler/helper. Leaving simulations in place after extraction creates permanent false-green coverage (the simulation passes even if the real handler regresses).

## 5. Risks, blockers, and what must NOT move yet

### 5.1 The `terminalManager` late-binding trap (highest-probability regression)
`terminalManager` is constructed at `src/extension.ts:3518` — *after* ~40 command closures referencing it are registered (e.g. `gitSort.openInIntegratedTerminal` line 715, `focusAgentTerminal` line 1614, `resumeAgentSession` line 2636, `restartAgent` line 3386, `launchAgent` line 3448). Today this works only because handlers capture the module-level `let` and dereference at invocation time. A naive extraction that passes `terminalManager` **by value** at registration time freezes it as `undefined` forever — and several handlers have legitimate `undefined` fallback paths, so nothing crashes; the launcher integration just silently degrades. The registration-shape test in §4.1 exists specifically to catch this.

### 5.2 Do-not-move list (Lane 6, deferred)
`focusAgentTerminal`, `resumeAgentSession`, `showAgentOutput`, `agentQuickActions`, `restartAgent`, `launchAgent`, and the helper web at lines 1066–1525. Reasons:
- **Safety-critical UX contract**: the no-silent-integrated-terminal-fallback behavior (`promptIntegratedTerminalFallbackInExtension`, `runCommandInProjectTerminalWithFallback`) is a ratified product rule; regressions here are exactly the failure mode the rule exists to prevent, and they're only provable with installed-VSIX live probes, not unit tests.
- **Shared closure web**: ~20 helpers (`isTaskTmuxSessionAlive`, `openGhosttyTmuxAttach`, `showRemoteNodeTaskSurfaceOptions`, `runResumeInTaskTerminal`, …) are shared across these commands and capture `sessionStore`, `terminalManager`, `telemetry`, `agentStatusProvider`. They must migrate onto `AgentTerminalContext` *first*, as a behavior-preserving step verified by the existing 600+-line `extension-commands.test.ts` suite, before any command body moves.
- **Strategy-ordered focus logic**: `focusAgentTerminal`'s Strategy 0→3 cascade plus the bundle-surface trust gate encodes recently-fixed bug behavior (`taskMatchesSessionStoreBundle`, `shouldTrustBundleSurface` — both exported from `extension.ts` and directly unit-tested). Moving them changes test import paths; if they move, keep re-exports from `extension.ts` like the integration-test-api precedent at lines 122–132.

### 5.3 Other risks
- **Lifecycle ownership**: `deactivate()` (3757–3819) resets the module-level `let`s. Extracted modules must never cache getter results across invocations; lifecycle state stays in `extension.ts`.
- **Integration-test API stability**: `IntegrationTestApiDeps` (3722–3743) reads module state via getters already — unaffected as long as state variables stay in `extension.ts`. `subscriptionCount > 0` assertion is robust to regrouping pushes.
- **Bun mock architecture**: `mock.module("vscode")` is process-global; new tests must use `test/helpers/vscode-mock.ts`'s `setupVSCodeMock()` and must not `promisify(execFile)` at module scope (the current `execFileAsync` helper does lazy dynamic imports inside the function body — preserve that in any extracted helper).
- **Slot commands**: leave `project-view-manager.ts` registration alone; the commands-registered contract intentionally exempts inactive slots.
- **Activation-time regressions**: keep dynamic `import()`s where they are today (cron, openclaw-task, taskflow, test-count services) — hoisting them to static imports as part of extraction would change activation cost and contradict the lazy-loading pattern. `cc_extension_activated` telemetry (`activation_time_ms`) is the watchdog; compare before/after in the dev host.

## 6. Why planning-only (no preparatory code change)

A code change was permitted "only if obviously safe." The smallest meaningful extraction (L1 cron) is low-risk but not *obviously* safe without `just test-electron`, which is guarded to run on the MacBook node and exercises a real VS Code host — outside what this planner lane should kick off. Every smaller "tiny helper file" candidate (e.g., moving `shellQuote`/`formatShellCommand`) touches the Lane 6 helper web, which §5.2 argues should move as one deliberate, separately-gated step. Planning-only therefore dominates.

## 7. Suggested first move

Run Lane 1 (cron) as a single Fable implementation task with the full §4 proof chain. It is the smallest cluster with zero shared state, it validates the `src/activation/` pattern, the registration-shape test template, and the proof pipeline — everything later lanes reuse.
