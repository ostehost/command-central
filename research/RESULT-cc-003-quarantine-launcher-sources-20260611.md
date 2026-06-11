# RESULT — cc-003 Quarantine launcher tasks.json sources (2026-06-11)

Task: `cc-003-quarantine-launcher-sources-20260611`
Scope: dogfood-only/local containment fix. No push, no tag, no preview cut.

## Problem

Command Central treated Ghostty Launcher `tasks.json` as a default source of
truth for Agent Status. The resolver auto-detected the operator's real global
registries (`~/.config/ghostty-launcher/tasks.json`, `~/.ghostty-launcher/tasks.json`)
and implicit workspace `.ghostty-launcher/tasks.json` whenever no explicit path
was configured. That leaked stale launcher-era review lanes into Agent Status
and into dogfood testing — the observed failure was the startup smoke class
reading `/Users/ostehost/.config/ghostty-launcher/tasks.json` because the
default test config mock fell through to auto-detection.

## Behavior change

Launcher `tasks.json` ingestion is now **quarantined by default**:

- **Global registries are disabled by default.** Neither
  `~/.config/ghostty-launcher/tasks.json` nor `~/.ghostty-launcher/tasks.json`
  is ever read unless legacy mode is explicitly enabled.
- **Implicit workspace `.ghostty-launcher/tasks.json` is disabled by default.**
- **Explicit `commandCentral.agentTasksFile` / `commandCentral.agentTasksFiles`
  settings are also legacy-gated** — they are ignored unless the escape hatch
  is on (per the "reuse existing explicit settings only when legacy is enabled"
  containment requirement).
- **Escape hatch (diagnostics only):** new setting
  `commandCentral.legacyLauncherTasks.enabled`, default `false`, scope
  `machine`. When `true`, the full pre-quarantine resolution order returns:
  explicit settings → workspace-local → global XDG → global simple-home.
- **`TASKS_FILE` env override stays unconditional.** It is a per-process,
  explicit injection used by hermetic tests (`test/integration/runTest.ts`)
  and dev-host fixtures; it must point at an existing file and never falls
  back to operator-global registries.
- **OpenClaw-native sources untouched:** OpenClaw tasks/flows, TaskFlow,
  gateway/health surfaces, ACP sessions, SessionWatcher, ProcessScanner, and
  the discovery merge order are unchanged. The visible-lane runner and
  launcher integration scripts were not removed; the launcher parser/types
  remain intact behind the gate.
- **Empty state:** with no source configured, Agent Status renders the clean
  empty state ("Symphony Status Surface: no projected runs" + "Waiting for
  agents..."), not stale launcher rows. Registry mutation commands
  (mark-failed/clear-completed) degrade to the existing "Agent tasks file not
  configured" message because the resolved path is now `null` by default.

## Files changed

- `src/utils/tasks-file-resolver.ts` — new `TasksFileResolverOptions.legacyLauncherEnabled`
  (default off). Config/workspace/global resolution short-circuits to `null`
  without the opt-in; `resolveTasksFilePaths` also gates the additional
  read-only registry list. `TASKS_FILE` remains top-priority and unconditional.
- `src/providers/agent-status-tree-provider.ts` — `getConfiguredPaths()` reads
  `legacyLauncherTasks.enabled` (default `false`) and passes it through;
  config-change listener reacts to the new setting (re-watch + reload).
- `src/discovery/agent-registry.ts` — default `launcherTasksProvider`
  (`readLauncherTasks`) reads the same flag and resolves nothing when off.
- `package.json` — contributes `commandCentral.legacyLauncherTasks.enabled`
  (boolean, default `false`); `agentTasksFile`/`agentTasksFiles` descriptions
  now state they are legacy-gated diagnostics.
- `test/utils/tasks-file-resolver.test.ts` — quarantine-by-default suite
  (config/workspace/global all ignored; `TASKS_FILE` honored; no fallback when
  `TASKS_FILE` points at a missing file) + legacy escape-hatch suite covering
  the pre-existing resolution-order behaviors.
- `test/integration/tasks-json-startup-smoke.test.ts` — fixture-driven tests
  now opt into legacy explicitly; new guards: explicit `agentTasksFile` ignored
  by default, workspace/global registries not ingested by default
  (`provider.filePaths === []` even on a machine where the real global registry
  exists), and legacy mode re-enables implicit workspace ingestion. All
  fixtures are temp-dir registries.
- `test/discovery/agent-registry.test.ts` — new suite proving the default
  launcher source returns `[]` with legacy off and reads a temp fixture
  registry with legacy on.
- `test/integration/runInstalledVsixAgentStatusProof.ts` — the installed-VSIX
  proof now sets `legacyLauncherTasks.enabled: true` alongside its temp
  fixture registry path.

## Tests / gates run

- `bun test test/utils/tasks-file-resolver.test.ts` — 28 pass
- `bun test test/integration/tasks-json-startup-smoke.test.ts test/discovery/agent-registry.test.ts` — 44 pass
- `just test-unit` — 602 pass (129 git-sort + 473 core)
- `just test` — full suite: 1960 pass / 1 skip / 0 fail (136 files), quality checks pass
- `just fix` + `just check` — biome ci + tsc + knip clean

## Residual risk

- The `TASKS_FILE` environment variable still injects a launcher-format
  registry unconditionally. It is explicit and per-process (hermetic test/dev
  use), but an operator shell exporting `TASKS_FILE` globally would still feed
  Agent Status. Accepted for now; revisit when the Symphony/OpenClaw-native
  source of truth lands.
- Legacy mode (`legacyLauncherTasks.enabled: true`) restores the full old
  behavior including global auto-detect — anyone flipping it for diagnostics
  re-exposes themselves to stale launcher rows until they turn it back off.
- The installed-VSIX proof suite and `test/integration/runTest.ts` were
  updated/audited but not executed in this run (they launch real VS Code);
  they ride on the legacy flag + `TASKS_FILE` respectively.
- Bun's `os.homedir()` does not follow `process.env.HOME` mutation, so the
  smoke-level guard proves global quarantine via "resolver returns no paths"
  rather than a fake `$HOME`; per-candidate global gating is covered by the
  resolver unit tests with mocked `existsSync`.

## Next

Design the OpenClaw/Symphony-native Agent Status source of truth; once that
lands and dogfood confirms no one needs the diagnostics hatch, delete
`legacyLauncherTasks` and the launcher resolution paths outright.
