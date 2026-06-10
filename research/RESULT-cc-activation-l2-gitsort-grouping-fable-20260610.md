# RESULT — Activation modularization Lane 2: git-sort + grouping + misc singles

- Task: `cc-activation-l2-gitsort-grouping-fable-20260610`
- Role: implementer (Lane 2 of `research/RESULT-cc-activation-modularization-plan-fable-20260610.md`)
- Date: 2026-06-10
- Base: `main` @ `98351ebb` (Lane 1 cron extraction reviewed clean)

## 1. Exact command set moved (23 commands)

Identified before editing by cross-checking `package.json` contributes against
the `extension.ts` registration sites. The registered non-slot set still equals
the contributed non-slot set exactly; the gitSort slot variants
(`gitSort.*.slotN[Panel]`) stay owned by `ProjectViewManager` and were not
touched.

**Grouping (2)** — `src/activation/register-grouping-commands.ts`
`commandCentral.grouping.toggle`, `commandCentral.grouping.selectOption`

**Git Sort, non-slot (18)** — `src/activation/register-git-sort-commands.ts`, in registration order:
`commandCentral.gitSort.enable`, `.disable`, `.refreshView`, `.changeSortOrder`,
`.changeFileFilter`, `.openChange`, `.openFile`, `.openDiff`,
`.revealInExplorer`, `.copyPath`, `.copyRelativePath`, `.openToSide`,
`.selectForCompare`, `.compareWithSelected`, `.revealInFinder`,
`.openInIntegratedTerminal`, `.openWith`, `.openPreview`

(The plan's table said "19" for this cluster; the enumerated ID list in the
same row and the contributed set both contain 18 — 18 is correct.)

**Misc singles (3)** — `src/activation/register-misc-commands.ts`, in order:
`commandCentral.copyToClipboard`, `commandCentral.openInfrastructureDashboard`,
`command-central.showTestCount`

## 2. Diff summary

| File | Change |
|---|---|
| `src/extension.ts` | 3,758 → 3,374 lines (−384). Inline `registerCommand` sites 58 → 35 (−23). Handler bodies moved verbatim; only module-`let` reads became getter calls. |
| `src/activation/register-grouping-commands.ts` | New. `registerGroupingCommands(deps): Disposable[]`; deps: `getGroupingViewManager` getter, `telemetry` (Pick track), `logger` (Pick error). |
| `src/activation/register-git-sort-commands.ts` | New. `registerGitSortCommands(deps): Disposable[]`; deps: `getGitSorter`, `getProjectViewManager`, `getExtensionFilterViewManager`, `getTerminalManager` getters + `extensionFilterState` value + `ILoggerService`. Static imports of `enable-sort`/`disable-sort`/`tree-view-utils` moved here; the `filter-by-extension-command` dynamic import stays dynamic inside the handler. |
| `src/activation/register-misc-commands.ts` | New. `registerMiscCommands(deps): Disposable[]`; deps: `getTestCountStatusBar` getter (Pick refreshCount), `logger` (Pick error). |
| `test/commands/grouping-commands-registration.test.ts` | New, 8 tests (Lane 1 registration-shape pattern). |
| `test/commands/git-sort-commands-registration.test.ts` | New, 23 tests. |
| `test/commands/misc-commands-registration.test.ts` | New, 8 tests. |
| `test/helpers/vscode-mock.ts` | Added `env.clipboard.{writeText,readText}` to the shared mock (needed by clipboard-delegation tests; additive). |

### Getter-DI for the late-binding hazard (plan §5.1)

`gitSort.openInIntegratedTerminal` now calls
`openInIntegratedTerminal(item, getTerminalManager())` — the getter is
re-resolved on every invocation, exactly matching the old closure's
invocation-time dereference of the module-level `let terminalManager`
(constructed ~2,700 lines after registration). The registration-shape test
encodes both sides of the contract: before the manager exists the handler uses
the integrated-terminal fallback; after the manager is assigned
post-registration, the handler routes through
`terminalManager.runInProjectTerminal` and never touches `createTerminal`.
The same getter discipline covers `gitSorter`, `projectViewManager`,
`extensionFilterViewManager`, `groupingViewManager`, and
`testCountStatusBar`; all lifecycle state and `deactivate()` resets stay in
`extension.ts`.

### Intentional, behavior-equivalent registration-point consolidation

Per the plan's §1 rank-2 / §2 `register-misc-commands` design, the three misc
singles now register together at the old `copyToClipboard` site instead of at
three scattered points. Relative order among the three is preserved.
`openInfrastructureDashboard` has zero deps; `showTestCount` previously
registered after `testCountStatusBar` was constructed — the getter makes the
earlier registration a graceful no-op during that activation window (proven by
test). Construction of `TestCountStatusBar` (still lazy dynamic import),
`InfrastructureHealthStatusBar`, and all `mainLogger.info` milestones stay in
place. Everything else keeps identical registration order.

## 3. Commands run (all green)

| Command | Result |
|---|---|
| `bun test test/commands/{grouping,git-sort,misc}-commands-registration.test.ts` | 39 pass / 0 fail |
| `just ready` (fix + check + full `bun test`) | 1,819 pass / 1 skip / 0 fail; biome + tsc + knip clean |
| `just check` | clean |
| `just test-integration` | 385 pass / 0 fail |
| `just test-electron` (real VS Code 1.124.0, commands-registered proof incl. all 66 non-slot contributed commands) | exit 0 |
| `just dist --dry-run` | would build 0.6.0-rc.53; VSIX content gate unaffected |

A gate run regenerated `releases/digest-v0.6.0-rc.53.md` (appending
since-rc52 commits); restored via `git restore` — this lane cuts no preview.

Plan §4.7 simulation-conversion check: `test/commands/extension-commands.test.ts`
contains no simulations of any L2 handler (it covers agent surfaces, Lanes
4–6), so nothing to convert. `git-sort-commands.test.ts` and
`filter-by-extension-command.test.ts` already test the real underlying command
modules, which did not move.

## 4. Remaining lanes

| Lane | Status |
|---|---|
| L1 cron | ✅ landed (`20572894`), reviewed clean |
| **L2 git-sort + grouping + misc** | ✅ this commit |
| L3 ghostty (`ghostty.createTerminal`, `ghostty.checkBinary`) | next — self-contained, registered after terminalManager/binaryManager init |
| L4 agent registry mutations (7 commands + registry-write helpers) | pending; convert extension-commands.test.ts simulations |
| L5 navigation + diff + openclaw (19 commands) | pending |
| L6 terminal focus/resume core | deferred — `agent-terminal-context.ts` first, installed-preview proof before any command moves |

Line numbers in the plan are now stale for everything below old line 754;
re-anchor by grep (the cluster comments survived) rather than by line.
