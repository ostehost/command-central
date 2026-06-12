# RESULT — cc-lane-registry-defaults-legacy-deprecate-20260611

Defaults/deprecation follow-up to `70901b74` (cc-project-ref-consumer-fixup):
Agent Status now surfaces **active registry-backed LaneRef lanes with zero
configuration**, while full legacy launcher ingestion is formally deprecated,
opt-in diagnostics only — stale launcher rows never return as primary truth.

## Direction changes during the lane (applied)

1. **Legacy default stays `false`.** The original mission draft floated
   `legacyLauncherTasks.enabled` defaulting `true`; Mike corrected mid-lane:
   keep default **`false`** and mark the setting deprecated. Implemented as
   corrected — no compat shim was needed because the safe semantics are the
   shipped semantics.
2. **No launcher-branded identity path.** The default lane registry was first
   sketched as `~/.config/ghostty-launcher/tasks.json` only; corrected to
   lead with an OpenClaw-namespace path and keep the ghostty path compat-only.
3. **No premature blessing of `lanes.json`.** Mike then asked whether a
   mirrored `lanes.json` reinvents something OpenClaw should own natively.
   Evaluation below; the file default is now explicitly **transitional**, with
   the OpenClaw-native projection named as the long-term target in the setting
   description, resolver docs, skill reference, and this receipt.

## Architecture evaluation: file bridge vs OpenClaw-native (cc question)

Inspected surfaces (2026-06-11, OpenClaw 2026.6.5 `5181e4f`):

- `openclaw tasks` — durable background tasks with runtime kinds
  `subagent | acp | cron | cli` in `~/.openclaw/tasks/` (runs.sqlite), plus
  TaskFlow state. Interactive launcher lanes (Ghostty/tmux terminals running
  agent CLIs) are **not represented**; no record carries Work Registry
  `project_ref` / `lane_kind`.
- Command Central already consumes every OpenClaw-native surface that exists:
  `OpenClawTaskService` (tasks), `TaskFlowService` (flows),
  `AcpSessionService` (ACP sessions). None can carry LaneRef today.
- OpenClaw plugins exist (`openclaw plugins`, `~/.openclaw/plugins`,
  `~/.openclaw/state`), so a lane projection could plausibly live behind an
  OpenClaw plugin/API — but no such projection API exists yet.
- `~/.config/openclaw/` is an established config-mirror namespace (e.g.
  launchd script mirrors), so the bridge file is not inventing a new tree.

**Conclusion (per Mike's architecture correction):** the long-term primary
source for Command Central lane truth is the **OpenClaw-native Work System
plugin/API** — `workSystem.lanes.list` plus a per-session `workSystem`
projection from plugin session extensions — consumed behind a native CC
service like the existing OpenClawTaskService/TaskFlowService. A file bridge
is the only thing that can work today, so the defaults are framed strictly as
bridges, never identity paths:

- `~/.config/openclaw/lanes.json` — **transitional bridge/outbox only**, in
  the OpenClaw config namespace. Not final truth; retired when
  `workSystem.lanes.list` / the session `workSystem` projection lands.
- `~/.config/ghostty-launcher/tasks.json` — **deprecated** launcher-branded
  compat fallback. This is what makes zero-config work *today* (the launcher
  writes it now); it goes away when producers mirror to the bridge or the
  native Work System projection ships.

This framing is encoded in the setting description (asserted by the contract
test: `transitional` + `OpenClaw-native` wording), the resolver/skill docs
(which name `workSystem.lanes.list` + session `workSystem` projection), and
the follow-up items below.

## Exact defaults shipped

`package.json` → `contributes.configuration`:

```json
"commandCentral.laneRegistry.files": {
  "default": [
    "~/.config/openclaw/lanes.json",
    "~/.config/ghostty-launcher/tasks.json"
  ]
}
"commandCentral.legacyLauncherTasks.enabled": { "default": false }
```

Code-side constant `DEFAULT_LANE_REGISTRY_FILES`
(`src/utils/tasks-file-resolver.ts`) matches exactly (contract-tested). Both
default files ingest **`lane-records-only`**: only records carrying a Work
Registry `project_ref.id` are admitted; launcher-era rows in the same files
stay quarantined with a logged count (the `70901b74` record-level quarantine
is untouched). An explicit empty list opts out entirely; nothing beyond the
defaults is auto-detected. `TASKS_FILE` env override semantics unchanged.

## Exact deprecation wording shipped

- `commandCentral.legacyLauncherTasks.enabled` →
  `markdownDeprecationMessage`: “**Deprecated.** Full launcher `tasks.json`
  ingestion is a diagnostics-only escape hatch slated for removal. Active
  lanes are read from `commandCentral.laneRegistry.files`, which only admits
  Work Registry-backed LaneRef records (`project_ref`). While this is `true`,
  Agent Status shows a warning row and stale launcher-era records can
  resurface — leave it `false` outside short-lived diagnostics sessions.”
- `commandCentral.agentTasksFile` / `commandCentral.agentTasksFiles` →
  `markdownDeprecationMessage`: “**Deprecated.** Legacy launcher diagnostics
  input, only read while the deprecated
  `commandCentral.legacyLauncherTasks.enabled` escape hatch is `true`. Use
  `commandCentral.laneRegistry.files` for active Work Registry-backed lanes.”

## Visible marking of legacy diagnostics mode

While `legacyLauncherTasks.enabled` is `true`, the Agent Status root pins a
warning row **first** (empty and populated states):

> ⚠ `Legacy launcher diagnostics (deprecated)` —
> `commandCentral.legacyLauncherTasks.enabled ingests stale launcher rows — diagnostics only`

(`createLegacyDiagnosticsMarkerNodes()` in
`src/providers/agent-status-tree-provider.ts`; legacy rows themselves still
group by explicit launcher name or fall into the pinned-last UNREGISTERED
PROJECTS bucket — basename-derived names still never form a group.)

## Hermeticity hardening (found during this lane)

Making the default point at real `$HOME` paths exposed a contamination class:
any unit-test config mock that fell through to `config.get`'s `defaultValue`
would have resolved the operator's real registries. Fix: the provider passes
**no code-side default** to `config.get("laneRegistry.files")` — in real
VS Code the package.json default applies regardless (registered defaults take
precedence), while config-less hosts (test mocks) resolve `[]`. Defense in
depth: explicit `laneRegistry.files → []` pins in `test/helpers/vscode-mock.ts`,
the tree-view harness (`setAgentStatusConfig`), and the startup smoke. The
zero-config behavior is proven by feeding `DEFAULT_LANE_REGISTRY_FILES`
through the config mock under a sandboxed `$HOME`, with the manifest default
pinned to the constant by the contract test. Verified: full suite emits zero
`Agent Status using tasks file` lines pointing at real `$HOME` paths.

## Files changed

- `package.json` — lane registry default + description; deprecation messages
  on the three legacy settings.
- `src/utils/tasks-file-resolver.ts` — `DEFAULT_LANE_REGISTRY_FILES`;
  `resolveTaskRegistrySources` defaults omitted `laneRegistryFiles` to it
  (explicit `[]` opts out); transitional/bridge docs.
- `src/providers/agent-status-tree-provider.ts` — `_legacyDiagnosticsEnabled`
  tracking; pinned-first deprecation marker row; no code-side config default
  for `laneRegistry.files` (hermeticity).
- `test/utils/tasks-file-resolver.test.ts` — zero-config default resolution,
  default-order/content contract, explicit-empty opt-out, legacy-on dedup
  (launcher file keeps `all`, bridge stays filtered).
- `test/package-json/lane-registry-defaults-contract.test.ts` — **new**:
  manifest default ↔ code constant lock; transitional/native-target wording;
  deprecation wording on all three legacy settings; legacy default `false`.
- `test/integration/lane-registry-projection.test.ts` — sandboxed `$HOME`
  harness; zero-config tests (bridge file, compat file, stale-only
  no-resurrection, explicit-empty opt-out); legacy deprecation marker test.
- `test/integration/tasks-json-startup-smoke.test.ts` — lane registry pinned
  `[]`; legacy-enabled expectations include the deprecation marker row.
- `test/helpers/vscode-mock.ts`, 
  `test/tree-view/_helpers/agent-status-tree-provider-test-base.ts` —
  hermetic `laneRegistry.files → []` pins.
- `test/integration/installed-vsix-proof-shared.ts` / 
  `runInstalledVsixAgentStatusProof.ts` / `installed-vsix-proof-suite.ts` —
  quarantine-default phase contract updated: providers must resolve exactly
  the zero-config lane registries; forbidden-id sweep now targets only stale
  (non-`project_ref`) ids (`readRegistryTaskIdSplitSafe`), LaneRef ids may
  legitimately surface.
- `test/integration/installed-vsix-proof-harness.test.ts` — coverage for the
  id split and default-path expansion helpers.
- `.claude/skills/command-central-vscode-extension/SKILL.md` +
  `references/agent-status-sources.md` — resolution docs rewritten for the
  two-channel model (lane registry primary / legacy deprecated).

## Behavior proven by tests

| Requirement | Test |
| --- | --- |
| Zero-config default surfaces active LaneRef records | lane-registry-projection: “zero-config default surfaces LaneRef records from the transitional OpenClaw bridge registry” + “…from the deprecated launcher compat registry” |
| Stale legacy rows in default registries never become active lanes | “zero-config default never resurrects stale launcher rows as active lanes” (both default files stale-only → empty state) |
| Deprecated legacy setting default/description contract | lane-registry-defaults-contract (default `false`, deprecation wording, manifest ↔ constant lock, transitional + OpenClaw-native wording) |
| Legacy diagnostics still possible and visibly marked | “legacy diagnostics opt-in still ingests the full file”; “legacy diagnostics opt-in is visibly marked with a pinned deprecation warning row”; startup-smoke legacy expectations |
| Explicit opt-out | “an explicit empty laneRegistry.files opts out of the default registries”; resolver “explicit empty lane registry list opts out” |
| No basename-derived project groups return | unchanged `70901b74` suites (worktree/UNREGISTERED tests) still green |
| Legacy/lane dedup precedence | resolver “legacy opt-in keeps all-records ingest for the auto-detected launcher file while the bridge default stays filtered” |

## Verification

- `bun test test/integration/*.test.ts` — 142 pass / 0 fail.
- `bun test test/utils/tasks-file-resolver.test.ts` — 37 pass.
- `bun test test/package-json/lane-registry-defaults-contract.test.ts` — 4 pass.
- `just ready` (fix → check → test) — see commit; full suite
  2011+ pass / 0 fail, partitions validated, biome/tsc/knip clean.
- Leak audit: full-suite output contains zero real-`$HOME` registry
  resolution lines.

## Residual risks

- **Producer gap on the bridge:** nothing writes
  `~/.config/openclaw/lanes.json` yet. Zero-config visibility today flows
  through the deprecated ghostty compat path; if that file is removed before
  Ghostty mirrors LaneRef projection to the bridge (or a native projection
  ships), the dogfood UI goes empty again. Ghostty-side mirroring is a
  launcher lane, not done here.
- A launcher defect stamping `project_ref` on garbage rows still passes the
  record filter (unchanged trust boundary from `70901b74`).
- The installed-VSIX proof contract was updated but **not executed** in this
  lane (downloads VS Code; network-restricted). It remains the manager gate.
- Discovered-agent (process-scanner) basename naming residual from `70901b74`
  is unchanged.

## Exact next live/VSIX preview proof (manager gate)

1. On the dogfood host, remove any manual
   `commandCentral.laneRegistry.files` override (zero-config is the point);
   keep `commandCentral.legacyLauncherTasks.enabled` **false** (the Settings
   UI now shows it struck through as deprecated).
2. `just dist` → `code --install-extension releases/command-central-<ver>.vsix`.
3. `just test-installed-vsix-agent-status` — quarantine-default phase now
   asserts both providers resolve exactly the two zero-config lane registries
   and ingest no stale (non-`project_ref`) id from the real machine
   registries; legacy-fixture phase unchanged.
4. Visually confirm: active `project_ref` lanes grouped under registry display
   names with Symphony non-zero, stale rows absent; flip the deprecated
   escape hatch on briefly and confirm the pinned ⚠ “Legacy launcher
   diagnostics (deprecated)” row, then back off.
5. Ghostty follow-up lane: mirror LaneRef projection to
   `~/.config/openclaw/lanes.json` (transitional bridge/outbox only).
6. Work System follow-up (end-state design item): OpenClaw-native plugin/API
   — `workSystem.lanes.list` plus per-session `workSystem` projection from
   plugin session extensions — then a CC `WorkSystemLaneService` (modeled on
   OpenClawTaskService) replaces the file defaults, which retire to
   compat-only and finally disappear.
