# RESULT — Activation modularization Lane 4: agent registry mutations

- Task: `cc-activation-l4-agent-registry-fable-20260610`
- Role: implementation (Lane 4 of `research/RESULT-cc-activation-modularization-plan-fable-20260610.md`)
- Date: 2026-06-10
- Base: `main` @ `805b369a` (L3 ghostty extraction, reviewed clean)

## 1. Exact Lane 4 command set (verified from code + package.json, not plan line numbers)

The plan's line ranges (1527–1570, 2199–2614 @ `4477b628`) were stale after
L1–L3; the cluster was re-anchored by command ID. At `805b369a` the seven
commands lived at `src/extension.ts:1777–2192` and the two registry-write
helper closures at `src/extension.ts:1105–1148`.

| # | Command ID | Registered (old) | Notes |
|---|---|---|---|
| 1 | `commandCentral.captureAgentOutput` | 1777 | oste-capture.sh via `terminalManager.resolveLauncherHelperScriptPath` |
| 2 | `commandCentral.killAgent` | 1826 | PID path (discovered agent) + oste-kill.sh path (launcher task) |
| 3 | `commandCentral.clearCompletedAgents` | 1909 | race-safe re-read + `.bak` backup |
| 4 | `commandCentral.markStaleAgentFailed` | 1981 | via `mutateAgentTaskRegistry` |
| 5 | `commandCentral.reapStaleAgents` | 2043 | via `mutateAgentTaskRegistry`, ids from `getStaleLauncherTasks()` |
| 6 | `commandCentral.removeAgentTask` | 2101 | race-safe re-read + `.bak` backup |
| 7 | `commandCentral.markAgentReviewed` | 2179 | sync handler; delegates to `agentStatusProvider.markTaskReviewed` |

Commands 1–6 were the final six entries of the large `context.subscriptions.push(...)`
block that starts with `defaultAgentAction`-adjacent registrations;
`markAgentReviewed` followed immediately in its own push. The extracted module
registers all seven in the same relative order, so the activation-time
registration sequence is unchanged. All seven are contributed in
`package.json` (commands + context menus); none are slot commands.

Moved helpers: `writeRegistryWithBackup`, `mutateAgentTaskRegistry`
(previously `activate()`-local closures; now module-private functions in the
new activation module — they captured nothing besides imports, so behavior is
identical, including the lazy `await import("node:fs")` pattern).

## 2. Diff summary

| File | Change |
|---|---|
| `src/activation/register-agent-registry-commands.ts` | **new** — `registerAgentRegistryCommands(deps): vscode.Disposable[]` with getter-DI (`getAgentStatusProvider`, `getTerminalManager` as `Pick<…>` getters per §2 of the plan; `agentOutputChannel` by value — it is an `activate()`-local const created before registration). Handler bodies are verbatim copies; the only mechanical change is `agentStatusProvider?.X` → `getAgentStatusProvider()?.X` and `terminalManager` → invocation-time `getTerminalManager()` (same `throw new Error("Terminal manager is not initialized.")` inside the existing try/catch). |
| `src/extension.ts` | −477 lines (3,243 → 2,784). Removed the seven inline registrations, the two helper closures, and the now-module-owned `agent-task-registry` import block (`isValidSessionId` stays — still used by focus/restart/resume paths). Added one `context.subscriptions.push(...registerAgentRegistryCommands({ getAgentStatusProvider: () => agentStatusProvider, getTerminalManager: () => terminalManager, agentOutputChannel }))` at the exact former position between `selectProjectFilter` and `focusNextRunningAgent`. |
| `test/commands/agent-registry-commands-registration.test.ts` | **new** — 28 tests: exact command-ID set in order, one disposable per command, package.json contribution cross-check, and real-handler scenarios. Registry mutations run against real temp `tasks.json` files (asserting rewritten contents, `.bak` backups, decline-leaves-file-untouched, malformed-JSON errors); capture/kill execute real temp bash helper scripts through the mocked `resolveLauncherHelperScriptPath`. Late-binding contract: deps getters return `undefined` at registration and are assigned only before invocation. |
| `test/commands/extension-commands.test.ts` | −208 lines: removed the three superseded simulation blocks (`removeAgentTask command`, `clearCompletedAgents command`, `stale agent mutation commands`) and their now-unused imports. Pure registry-map helper coverage stays in `test/utils/agent-task-registry.test.ts`; command-shape coverage moved to real handlers in the new registration test. |
| `test/integration/cross-repo-smoke.test.ts` | Capture/kill helper-resolution contract now asserts against `commandSurfaceSource` = `extension.ts` + the new activation module (positive `resolveLauncherHelperScriptPath("oste-…")` matches and negative legacy `path.dirname(tasksFilePath)` pattern both scan the combined source). |
| `scripts-v2/prerelease-gate.ts` | Launcher-contract step additionally reads `src/activation/register-agent-registry-commands.ts` (`.catch(() => "")` so absence degrades to the helper-call contract failing, not a crash) and validates the combined source. Without this, `just prerelease`/`just cut-preview` would false-fail on "missing launcher helper resolution". |

Behavior preserved: command IDs, handler logic, prompts/messages, modal
confirms, registration order, lazy `import()`s, subscription lifecycle
(extension.ts still owns `context.subscriptions` and `deactivate()` state
resets). No stale captures: both resettable deps are getter-injected.

## 3. Commands run / verification

| Gate | Result |
|---|---|
| `bun test test/commands/agent-registry-commands-registration.test.ts` | 28 pass / 0 fail |
| `just test-unit` | 561 pass (129 + 432) / 0 fail |
| `just check` (biome ci + tsc + knip) | clean |
| `just test` (full suite) | 1846 pass / 0 fail (1847 tests, 130 files, ~13s) + quality checks pass |
| `just test-integration` | 385 pass / 0 fail |
| `just test-electron` (real VS Code host; node guard passed on this host) | exit 0 in 64s — includes `commands-registered.test.ts` proving all non-slot contributed commands (the 7 moved ones included) register on activation |
| `just dist --dry-run` | OK ("Would build version 0.6.0-rc.53"), no version/file-count change |
| `bun run build` | OK (3.0s) |
| `just test-installed-vsix-agent-status` | **not run** — it validates the *released* `releases/command-central-0.6.0-rc.53.vsix` artifact, which predates this change; exercising this lane through it would require building/installing a new VSIX, which this lane must not do (no preview cut). The equivalent working-tree runtime proof is the `just test-electron` pass above. The proof should run as part of the next preview cut (rc54), which will contain L1–L4. |

`releases/digest-v0.6.0-rc.53.md` was regenerated by the build tooling during
gate runs (it appends since-previous-cut commits) and was restored to its
committed state both times; this lane cuts no preview.

## 4. Remaining lanes

- **L5**: navigation + diff + openclaw (`register-agent-navigation-commands.ts`,
  `register-agent-diff-commands.ts`, `register-openclaw-task-commands.ts`), ~19 commands.
  Plan line numbers are now stale by ~900 lines total (L1–L4); re-anchor by command ID.
- **L6 (deferred)**: terminal focus/resume core — `agent-terminal-context.ts`
  preparatory step first; only after L1–L5 are proven in an installed preview.
- Suggested before L5 lands: cut rc54 preview so `just test-installed-vsix-agent-status`
  exercises the extracted L1–L4 surfaces from an installed VSIX.
