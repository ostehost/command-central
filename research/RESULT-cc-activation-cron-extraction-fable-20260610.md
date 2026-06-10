# RESULT — Lane 1: cron command registration extracted from extension.ts

- Task: `cc-activation-cron-extraction-fable-20260610`
- Role: implementer (Lane 1 of `research/RESULT-cc-activation-modularization-plan-fable-20260610.md`)
- Date: 2026-06-10
- Base: `main` @ `f0d48380` (clean tree verified before work)

## 1. What changed

| File | Change |
|---|---|
| `src/activation/cron-feature.ts` | **New.** Whole-feature module: `activateCronFeature(context)` constructs `CronService` + `CronTreeProvider` + the `commandCentral.cronJobs` tree view, starts the service, and registers the 8 cron commands via the exported `registerCronCommands(deps)` (returns one `vscode.Disposable` per command). Dynamic `import()` of `cron-service.js` / `cron-tree-provider.js` preserved (type-only imports at module top, so laziness is unchanged). |
| `src/extension.ts` | Lines 785–852 (cron block) replaced by `await activateCronFeature(context);` + one static import of the new module. Net −61 lines (3,819 → 3,758). `mainLogger.info("Cron Jobs view initialized")` milestone stays in place in `activate()`. |
| `test/commands/cron-feature-registration.test.ts` | **New.** Registration-shape test (13 tests) importing the **real** `registerCronCommands` (no handler simulation): exact command-ID set and order; set equality against `package.json` `contributes.commands` filtered to `commandCentral.cron.*`; one disposable per command; `runNow`/`enable`/`disable` delegate the node's job id to the service and are graceful no-ops for missing/non-job/job-less nodes; the four Phase-2 placeholders show their exact toasts. |

Commands moved (IDs and handlers byte-identical): `commandCentral.cron.{refresh,runNow,enable,disable,create,edit,delete,viewHistory}`.

Behavior-preservation details:
- Subscription push order unchanged: `cronService, cronTreeProvider, cronView` → `service.start(refresh)` → 8 command disposables in original registration order.
- No getter-DI needed: the cron cluster has zero late-bound module-state deps (the §5.1 `terminalManager` trap does not apply here).
- Terminal focus/resume routing, `TerminalManager`, and all other clusters untouched.

## 2. Why `registerCronCommands` is a separate export

`CronService.start()` shells out to the real `openclaw` CLI (`execFileSync`) and starts an `fs.watch`. A unit test that called `activateCronFeature` would spawn real subprocesses (the exact failure mode recorded in the test-suite-performance memory), and `mock.module`-ing the cron modules is unsafe because `test/services/cron-service.test.ts` / `test/providers/cron-tree-provider.test.ts` import the real ones in the same bun process. So the command registration is a pure function taking `Pick<CronService, …>` / `Pick<CronTreeProvider, "refresh">` deps — unit-testable with stubs — while `activateCronFeature` is proven at runtime by the electron suite (below).

## 3. Verification

| Gate | Result |
|---|---|
| `bun test test/commands/cron-feature-registration.test.ts` | 13 pass / 0 fail |
| `just ready` (fix + check: biome/tsc/knip + full `bun test`) | 1780 pass / 1 skip / 0 fail across 126 files; quality checks pass |
| `just test-integration` | 385 pass / 0 fail |
| `just test-electron` (real VS Code host, this machine passes the node guard) | exit 0 in 66s — includes `commands-registered.test.ts`, the runtime proof that every non-slot contributed command (the 8 cron IDs included) registers on activation |
| `just dist --dry-run` | OK (`Would build version 0.6.0-rc.53`; no release cut) |

Not run: `just test-installed-vsix-agent-status` — plan §4.5 requires it only for Lanes 4–6 (agent surfaces); cron is not an agent surface.

## 4. Remaining modularization lanes

Per the plan (land sequentially; each rebases on the previous):

- **L2**: git-sort + grouping + misc singles (24 commands, ~390 lines) — first lane that needs the getter-DI rule (`getTerminalManager` for `gitSort.openInIntegratedTerminal`).
- **L3**: ghostty (2 commands, ~140 lines).
- **L4**: agent registry mutations (7 commands, ~480 lines) + convert the corresponding simulation blocks in `test/commands/extension-commands.test.ts` to real-handler imports.
- **L5**: navigation + diff + openclaw (19 commands, ~900 lines).
- **L6**: terminal focus/resume core — **deferred**; `agent-terminal-context.ts` helper migration first, only after L1–L5 are proven in an installed preview.

Lane 1 validates the `src/activation/` module pattern and the registration-shape test template that L2–L5 should reuse.
