# RESULT — Activation modularization Lane 3: Ghostty commands

- Task: `cc-activation-l3-ghostty-fable-20260610`
- Role: implementer (Lane 3 of `research/RESULT-cc-activation-modularization-plan-fable-20260610.md`)
- Date: 2026-06-10
- Base: `main` @ `f3ad3d5e` (Lane 2 git-sort/grouping/misc extraction reviewed clean)

## 1. Exact command set moved (2 commands)

Identified before editing by cross-checking `package.json` contributes against
the `extension.ts` registration sites (`jq '.contributes.commands[].command' |
grep -i ghostty` plus a menus/keybindings sweep — neither references these
IDs). In registration order:

1. `commandCentral.ghostty.createTerminal`
2. `commandCentral.ghostty.checkBinary`

The plan's stale line anchor (old 3534–3672 @ `4477b628`) was re-anchored by
the `// Ghostty Integration — TerminalManager + BinaryManager` banner, which
after Lanes 1–2 sat at `extension.ts:3092`; the moved block was the
`context.subscriptions.push(...)` at 3111–3249.

**Deliberately NOT moved** (service wiring, not command registration; stays in
`extension.ts` per the lane rule):

- `terminalManager = new TerminalManager(...)` / `binaryManager = new BinaryManager(...)` construction — module-level `let`s consumed by ~40 other handlers and reset in `deactivate()`
- the `terminalManager.isLauncherInstalled().then(...)` → `setContext commandCentral.hasLauncher` side effect
- the `mainLogger.info("Ghostty integration initialized")` milestone

## 2. Diff summary

| File | Change |
|---|---|
| `src/extension.ts` | 3,374 → 3,243 lines (−131). Inline `registerCommand` sites 35 → 33 (−2). Handler bodies moved verbatim; only the module-`let` reads (`terminalManager?.` / `binaryManager?.`) became invocation-time getter calls, and `mainLogger.error` became the injected `logger.error`. Registration position in `activate()` unchanged (after Agent Status panel, before Test Count status bar). |
| `src/activation/register-ghostty-commands.ts` | New (174 lines). `registerGhosttyCommands(deps): Disposable[]`; deps: `getTerminalManager` getter (`Pick<TerminalManager, "runInProjectTerminal">`), `getBinaryManager` getter (`Pick<BinaryManager, "isInstalled" \| "getVersion" \| "getLatestRelease" \| "downloadRelease">`), `logger` (`Pick<LoggerService, "error">`). No dynamic imports existed in this cluster; none introduced. |
| `test/commands/ghostty-commands-registration.test.ts` | New, 14 tests (Lane 1/2 registration-shape pattern): exact ID set in order, one disposable each, package.json contribution check, real-handler delegation for both commands, late-binding getter contract, graceful no-op while managers are missing. |
| `test/commands/ghostty-create-terminal.test.ts` | **Deleted** (plan §4.7). It re-simulated the createTerminal handler inline — permanent false-green coverage once the handler moved. All five of its scenarios (no-workspace error, single-root delegation, multi-root picker, picker cancel, failure surface) are re-encoded in the new registration test against the **real** handler. |
| `test/helpers/vscode-mock.ts` | Added `ProgressLocation` enum and `window.withProgress` pass-through executor to the shared mock (additive; checkBinary's update flow needs both; no prior unit test mocked them). |

### Getter-DI per the plan's §5.1 late-binding rule

Both managers are constructed immediately *before* these commands register, so
there is no registration-order hazard today — but both are resettable module
state (cleared in `deactivate()`), so they are injected as getters and
re-resolved on every invocation, never captured by value. The
"resolves the terminal manager lazily" test registers with the getter
returning `undefined`, invokes the handler (graceful path, no error), then
assigns the manager and proves the second invocation routes through
`runInProjectTerminal`. Preserved quirks, bit-for-bit: with no
terminalManager, createTerminal still shows the "Project terminal opened"
info message (`await undefined?.run...` is a no-op); with no binaryManager,
checkBinary flows through `withProgress`, gets no release, and exits silently.

## 3. Commands run (all green)

| Command | Result |
|---|---|
| `bun test test/commands/ghostty-commands-registration.test.ts` | 14 pass / 0 fail |
| `just test-unit` | 561 pass across both subsets, 0 fail |
| `just check` | biome ci + tsc + knip clean |
| `just fix` | no fixes needed (formatting already canonical) |
| `just test` | 1,829 pass / 1 skip / 0 fail (typecheck + full suite, 13.6s) |
| `just test-integration` | 385 pass / 0 fail |
| `just dist --dry-run` | "Would build version 0.6.0-rc.53", no file churn from the dry-run itself |
| `just test-electron` (this machine passes the node guard) | exit 0 in 64s — includes `commands-registered.test.ts`, the real-VS-Code proof that all 66 non-slot contributed commands (both ghostty IDs included) register on activation |

Side effect handled: the electron run regenerated
`releases/digest-v0.6.0-rc.53.md` (appended a since-rc52 commit list). This
lane does not cut a preview, so the digest was restored to its committed state
(`git checkout -- releases/digest-v0.6.0-rc.53.md`) before committing.

## 4. Remaining lanes

- **L4: agent registry mutations** (7 commands + the `writeRegistryWithBackup`/`mutateAgentTaskRegistry` helpers; converts the corresponding simulation blocks in `test/commands/extension-commands.test.ts`)
- **L5: navigation + diff + openclaw** (19 commands across three modules)
- **L6: terminal focus/resume core — deferred** (`agent-terminal-context.ts` first; no command moves until L1–L5 are proven in an installed preview)
