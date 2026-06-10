# RESULT — Lane 5: navigation + diff + OpenClaw command extraction

- Task: `cc-activation-l5-nav-diff-openclaw-fable-20260610`
- Role: implementer (Lane 5 of `research/RESULT-cc-activation-modularization-plan-fable-20260610.md`)
- Date: 2026-06-10
- Base: `main` @ `39981f53` (Lane 4 agent-registry extraction, reviewed clean)

## 1. Exact Lane 5 command set (20 commands)

Plan line numbers were stale after Lanes 1–4; the set below was re-anchored by
command ID against `src/extension.ts` @ `39981f53` and cross-checked against
`package.json` `contributes.commands` (all 20 are contributed).

**`src/activation/register-agent-navigation-commands.ts` (15):**

| # | Command | Old extension.ts anchor |
|---|---|---|
| 1 | `commandCentral.openAgentDashboard` | 574 |
| 2 | `commandCentral.defaultAgentAction` | 1100 |
| 3 | `commandCentral.agentStatus.focus` | 1568 |
| 4 | `commandCentral.refreshAgentStatus` | 1577 |
| 5 | `commandCentral.showDiscoveryDiagnostics` | 1583 |
| 6 | `commandCentral.changeProjectIcon` | 1594 |
| 7 | `commandCentral.toggleProjectGrouping` | 1644 |
| 8 | `commandCentral.toggleProjectGroupingFlat` | 1661 |
| 9 | `commandCentral.filterToProject` | 1669 |
| 10 | `commandCentral.filterCurrentProject` | 1683 |
| 11 | `commandCentral.clearProjectFilter` | 1689 |
| 12 | `commandCentral.selectProjectFilter` | 1695 |
| 13 | `commandCentral.focusNextRunningAgent` | 1736 |
| 14 | `commandCentral.openAgentDirectory` | 2410 |
| 15 | `commandCentral.listWorktrees` | 2427 |

Moved with them: the `isValidProjectIconInput` helper (module-private). The
plan's lane table said 19 commands; its own cluster rows (7+8+9) enumerate 20
including `openAgentDashboard` — 20 is correct.

**`src/activation/register-agent-diff-commands.ts` (3):**

| # | Command | Old anchor |
|---|---|---|
| 16 | `commandCentral.viewAgentDiff` | 2108 |
| 17 | `commandCentral.smartOpenFile` | 2202 |
| 18 | `commandCentral.openFileDiff` | 2238 |

Moved with them: `showGitDiffAsFilePicker` (module-private; was extension.ts
776–870, used only by `viewAgentDiff`). Per the plan, `openFileDiff`'s inline
readers are now exported pure helpers — `classifyFileContent`,
`readWorkingTreeFile`, `readFileAtRef` (the two readers became `async` to keep
node imports lazy; the handler awaits them sequentially, same behavior).

**`src/activation/register-openclaw-task-commands.ts` (2):**

| # | Command | Old anchor |
|---|---|---|
| 19 | `commandCentral.cancelOpenClawTask` | 2040 |
| 20 | `commandCentral.showOpenClawTaskDetail` | 2069 |

Moved with them: a module-private copy of the lazy `execFileAsync` wrapper
(extension.ts keeps its own — still used by the Lane 6 helper web).

## 2. Lane 6 boundary — deliberately NOT moved

`focusAgentTerminal`, `agentQuickActions`, `resumeAgentSession`,
`showAgentOutput`, `restartAgent`, `launchAgent` and the entire helper web
(`isTaskTmuxSessionAlive`, `openGhosttyTmuxAttach`,
`runCommandInProjectTerminalWithFallback`,
`promptIntegratedTerminalFallbackInExtension`,
`showRemoteNodeTaskSurfaceOptions`, `runResumeInTaskTerminal`,
`focusExistingTaskTerminal`, `openTranscriptInEditor`, `shellQuote`, …) remain
in `extension.ts` untouched, as do the exported launcher-truth gates
(`taskMatchesSessionStoreBundle`, `shouldTrustBundleSurface`),
ProjectViewManager slot registrations, and TerminalManager internals. No
ambiguity arose: every Lane 5 command either never touches the terminal core
or routes to it via `executeCommand` indirection, which tolerates module
boundaries.

## 3. DI / behavior-preservation notes

- **Getter DI for resettable state:** `agentStatusProvider` and
  `terminalManager` (constructed at extension.ts:3518-equivalent, *after*
  registration; reset in `deactivate()`) are injected as getters and
  dereferenced per invocation. `changeProjectIcon` now calls
  `getTerminalManager()` inside the handler — same late-binding semantics as
  the original module-`let` capture.
- **By-value deps** are all `activate()`-local consts created before the
  registration calls: `projectIconManagerForAgents`, `agentDashboardPanel`,
  `discoveryDiagnosticsChannel`, `syncAgentStatusViewContexts`,
  `openclawTaskService`, `openclawTaskOutputChannel`.
- **`registerAgentDiffCommands()` takes no deps** — none of the three handlers
  nor the picker helper touch module state (the plan's suggested
  `getAgentStatusProvider` dep was unused in practice; an unused dep would
  have been a misleading contract).
- **Registration placement:** nav module registers where the old
  focusNextRunningAgent block sat (right after the Lane 4 registry call);
  openclaw and diff modules register at their old cluster positions. Each
  module preserves its commands' original relative order. Cross-cluster
  interleaving with Lane 6 commands necessarily changed (all Lane 5 commands
  now register as three contiguous groups); per plan §3 this is tolerated —
  distinct command IDs are order-independent and no Lane 5 command executes
  during activation. Telemetry and `mainLogger.info` milestones are untouched.
- **Lazy imports preserved:** all `node:fs` / `node:child_process` /
  `node:util` access stays behind dynamic imports inside handlers;
  `OpenClawTaskService` is referenced type-only (erased) so its dynamic import
  in extension.ts still governs activation cost.
- Handler bodies, command IDs, prompts, error strings, context keys, and
  mutation behavior are verbatim copies (the only non-mechanical change is the
  sync→async reader extraction in `openFileDiff` noted above).

## 4. Diff summary

| File | Change |
|---|---|
| `src/extension.ts` | 2,784 → 2,020 lines (−764; +30/−794) — removed 20 inline registrations + 2 helpers, added 3 module imports + 3 registration calls |
| `src/activation/register-agent-navigation-commands.ts` | new, 380 lines |
| `src/activation/register-agent-diff-commands.ts` | new, 431 lines |
| `src/activation/register-openclaw-task-commands.ts` | new, 119 lines |
| `test/commands/agent-navigation-commands-registration.test.ts` | new, 674 lines (35 tests) |
| `test/commands/agent-diff-commands-registration.test.ts` | new, 528 lines (22 tests) |
| `test/commands/openclaw-task-commands-registration.test.ts` | new, 272 lines (13 tests) |
| `test/commands/extension-commands.test.ts` | removed 7 superseded simulation describes (focusNextRunningAgent, openAgentDashboard, viewAgentDiff, openFileDiff, openAgentDirectory, changeProjectIcon, defaultAgentAction); header updated. Kept: focusAgentTerminal + showAgentOutput sims (Lane 6) and the real-export launcher-truth tests |

Net `extension.ts` reduction across Lanes 1–5: 3,819 → 2,020 lines.

## 5. New test coverage (real handlers, not simulations)

70 tests across the three new files assert, per module: the exact ordered
command-ID set, one disposable per command, package.json contribution
membership, and lazy-getter late binding (register while getters return
`undefined`, assign afterwards, prove the handler re-resolves). Highlights:

- **navigation:** full `defaultAgentAction` routing matrix against the real
  handler; `changeProjectIcon` runs the real `showInputBox` validator and the
  real `refreshGhosttyBundleAfterProjectIconChange` (launcher-unavailable
  warning path); `listWorktrees` runs real `git worktree list` against a temp
  repo.
- **diff:** real temp git repos — `viewAgentDiff` numstat→openFileDiff
  single-file routing with real +2/−1 counts, pinned commit dates exercising
  the `started_at` → `git log --before` lookup, multi-file quick pick;
  `openFileDiff` two-ref virtual diff titles (`added` hint, working-tree mode,
  binary fallbacks, bounded-diff guard); direct unit tests for the exported
  readers.
- **openclaw:** `showOpenClawTaskDetail` spawns a real PATH-shimmed `openclaw`
  script and asserts argv (`tasks show task-1 --json`), pretty-printed JSON,
  raw non-JSON passthrough, and CLI-failure error surfacing.

**Mixed-suite hardening:** the three files re-pin
`globalThis.__realNodeChildProcess` / `__realNodeFs` in `beforeEach` —
`test/utils/port-detector.test.ts` installs a process-global
`mock.module("node:child_process")` whose fake `execFile` returns empty output
and survives `mock.restore()`, which silently broke the real-subprocess tests
in full-suite runs (found by bisection; fix follows the documented
`global-test-cleanup.ts` snapshot pattern).

## 6. Verification (all on this MacBook node, hostname MacBookPro.lan)

| Gate | Result |
|---|---|
| `bun test <3 new files>` | 70 pass / 0 fail |
| `just fix` | clean (formatter applied, then no-op) |
| `just check` (biome ci + tsc + knip) | ✅ |
| `just test-unit` | 432 pass / 0 fail |
| `just test` (full) | 1,888 pass / 0 fail / 1 skip across 133 files (~14s) |
| `just test-integration` | 385 pass / 0 fail |
| `just test-electron` (real VS Code 1.124.0 host) | exit 0 in 63.5s — includes the commands-registered contract (all non-slot contributed commands live) plus activation / command-executes / deactivation / tree-view-renders scenarios |
| `just dist --dry-run` | ✅ (v0.6.0-rc.53 preview; VSIX content gate path) |
| rc53 digest churn | `releases/digest-v0.6.0-rc.53.md` restored after the electron run (`git checkout --`) |

**Installed-VSIX proof:** not run. The installed extension is rc53, which
predates this change — `just test-installed-vsix-agent-status` would prove
rc53, not this source, and producing a current artifact requires cutting a
preview (out of scope per task constraints). Run it as part of the next rc
cut (rc54) per plan §4.5.

## 7. Remaining work

- **Lane 6 (deferred, do-not-move):** terminal focus/resume core — 6 commands
  + ~460-line helper web. Prerequisite per plan §2/§5.2: migrate helpers onto
  an `AgentTerminalContext` first, behavior-preserving, then move commands
  only after Lanes 1–5 are proven in an installed preview with live probes.
- **Next rc cut:** include `just test-installed-vsix-agent-status` (and
  `--live` probes if Lane 6 proceeds) in the rc54 gate.
- The Lane 6 simulation tests in `extension-commands.test.ts`
  (focusAgentTerminal, showAgentOutput) remain simulations by design; convert
  them when Lane 6 extracts the real handlers.
