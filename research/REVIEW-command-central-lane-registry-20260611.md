# REVIEW — command-central-lane-registry-20260611

- **Task:** review-command-central-lane-registry-20260611 (read-only manager review)
- **Commit under review:** `2f1ab599` — feat(agent-status): zero-config lane registry defaults + legacy launcher deprecation
- **Receipt under review:** `research/RESULT-cc-lane-registry-defaults-legacy-deprecate-20260611.md`
- **Reviewed at:** HEAD = `2f1ab599` on `main`, clean tree, 2026-06-11, Mike MacBook Pro node

## Verdict: ACCEPT_WITH_FIXUPS

The commit does what the receipt claims, the receipt is honest about what it did
not do (the installed-VSIX proof was updated but not executed), and every
verification claim I re-ran independently reproduced. The fixups are two stale
doc comments in `src/services/integration-test-api.ts` that now describe the
*old* proof contract — misleading exactly where the next proof-debugging
session will read first — plus one optional UI gap (no deprecation marker in
the Symphony view). Nothing blocks cutting the next dogfood VSIX; the
installed-VSIX proof on the dogfood host remains the manager gate, as the
receipt itself states.

## Independent verification performed (this review)

| Check | Result |
| --- | --- |
| `bun test test/package-json/lane-registry-defaults-contract.test.ts test/utils/tasks-file-resolver.test.ts` | 41 pass / 0 fail |
| `bun test test/integration/lane-registry-projection.test.ts test/integration/tasks-json-startup-smoke.test.ts test/integration/installed-vsix-proof-harness.test.ts` | 36 pass / 0 fail |
| `just test` (full supported suite) | **2011 pass / 1 skip / 0 fail**, 143 files, 15.1s — matches receipt's "2011+ pass / 0 fail" |
| `just check` (biome ci + tsc + knip) | Clean (knip warnings informational only) |
| Leak audit on full-suite log | 18 `Agent Status using tasks file` lines, **all** in temp dirs / repo fixtures; **zero** pointing at real `$HOME` registries; 355 `no tasks file configured` lines (the `[]` pins firing) |
| Real-machine registry state (read-only) | `~/.config/openclaw/lanes.json` **absent** (producer gap, as receipt admits); `~/.config/ghostty-launcher/tasks.json`: 38 records = 20 lane-backed (`project_ref.id`) + 18 stale |

Note: a *naked* `bun test` (not the supported `bun run test` directory list)
wedges on out-of-scope files — that is a pre-existing property of the repo's
test partitioning, not a defect of this commit; `just test` is the contract
and it passes.

## Q1 — Zero-config LaneRef visibility with legacy disabled/deprecated? YES

- `package.json` `commandCentral.laneRegistry.files` default is
  `["~/.config/openclaw/lanes.json", "~/.config/ghostty-launcher/tasks.json"]`
  (scope `machine`), ingested `lane-records-only` via
  `resolveTaskRegistrySources` (`src/utils/tasks-file-resolver.ts:216-225`).
  Lane sources are appended without an existence check and read with
  ENOENT→empty-registry (`agent-status-tree-provider.ts:3117-3131`), so fresh
  machines show a clean empty state, not an error row.
- `commandCentral.legacyLauncherTasks.enabled` stays default `false`, now with
  `markdownDeprecationMessage`; the entire legacy chain remains hard-gated at
  `resolveTasksFilePath` (`tasks-file-resolver.ts:127-129`) — without the
  opt-in, no launcher path resolves at all.
- Proven end-to-end in `lane-registry-projection.test.ts` under a sandboxed
  `$HOME`: zero-config surfacing from the bridge file, from the compat file,
  correct grouping under the registry display name, non-zero Symphony
  projection. Re-ran: green.
- Dogfood reality check: the compat file on this machine carries 20
  lane-backed records, so zero-config will show real lanes immediately —
  via the **deprecated compat path**, since nothing writes the bridge file yet
  (receipt's "producer gap" residual risk is accurate).
- Config toggles for both settings re-run `setupFileWatch()` + reload
  (`agent-status-tree-provider.ts:1191-1200`), and the 30s auto-refresh poll
  picks up a bridge file created after activation even though no native
  watcher attaches to a nonexistent directory.

## Q2 — Stale launcher rows prevented from becoming primary truth? YES

- Record-level quarantine from `70901b74` is intact and now applied to the
  default-on sources: `applyIngestFilter`
  (`agent-status-tree-provider.ts:3181-3209`) admits only
  `isRegistryBackedLaneTask` records (non-empty `project_ref.id.trim()`,
  line 845-851) and logs the quarantined count.
- The dedicated regression test ("zero-config default never resurrects stale
  launcher rows as active lanes") seeds both default files with stale-only
  rows and asserts the empty state with no resurrected project group. Green.
- The installed-VSIX proof contract was correctly rewritten for the new world:
  the quarantine-default phase now asserts providers resolve **exactly** the
  two zero-config paths and forbids only **stale** (non-`project_ref`) ids
  (`readRegistryTaskIdSplitSafe`), with ids that are lane-backed in any
  registry excluded from the stale set. With 18 stale ids in the real compat
  file, the sweep will be non-vacuous on this host.
- The escape hatch ingests full files (intended diagnostics), but it is
  default-off, struck-through deprecated, and pins the ⚠ "Legacy launcher
  diagnostics (deprecated)" row first in both empty and populated Agent Status
  states (tested in projection + startup smoke).
- Unchanged trust boundary, honestly documented in the receipt: a producer
  stamping `project_ref` on garbage rows passes the filter.
- Minor gap (FIXUP-3, optional): the marker renders only in the
  `agentStatus` view mode — `getChildren` returns `getSymphonyChildren()`
  before the marker is prepended (`agent-status-tree-provider.ts:3338-3340`),
  so a legacy-diagnostics session is unmarked in the Symphony tree while its
  counts can include stale-row inflation. The receipt claims only "Agent
  Status root", so it is accurate as written.

## Q3 — Are the two files described correctly? YES

- `package.json` description: "**transitional** Work System bridge file
  `~/.config/openclaw/lanes.json`, plus the **deprecated** Ghostty Launcher
  compatibility path … Both defaults are file bridges, not the end state:
  long-term, lane state should come from an OpenClaw-native projection".
- Resolver docs (`tasks-file-resolver.ts:30-60`): "TRANSITIONAL bridge/outbox
  file", "DEPRECATED launcher-branded compatibility fallback … Never the
  product identity path", with the long-term target named
  (`workSystem.lanes.list` + per-session `workSystem` projection).
- `SKILL.md` and `references/agent-status-sources.md` carry the same
  two-channel model and the same end-state framing.
- The wording is regression-locked: the contract test asserts
  `/transitional/i`, `/OpenClaw-native/`, `/deprecated/i`, `/project_ref/` in
  the manifest description and that the openclaw-namespace path leads.
  Nowhere is either file blessed as identity truth.

## Q4 — Did test mocks avoid the operator's real $HOME registries? YES

Verified at three layers, plus an independent audit:

1. **Safe by construction:** the provider passes no code-side
   `DEFAULT_LANE_REGISTRY_FILES` fallback — `getStringArrayConfig` calls
   `config.get(key, [])` (`agent-status-tree-provider.ts:1510-1518`), so any
   mock that falls through to `defaultValue` yields `[]`, which is the
   explicit opt-out in the resolver. Real VS Code returns the registered
   manifest default regardless of the passed `[]`.
2. **Defense-in-depth pins:** `test/helpers/vscode-mock.ts:110`, the
   tree-view harness (`agent-status-tree-provider-test-base.ts:310-313`), and
   the startup smoke each pin `laneRegistry.files → []`.
3. **Sandboxed `$HOME`:** the zero-config projection tests set
   `process.env.HOME = tmpDir` in `beforeEach` with proper restore, so the
   default paths resolve inside the fixture dir.
4. **Independent audit (this review):** full-suite log grep — zero
   `using tasks file` lines outside temp/fixture paths; no line touches
   `~/.config/openclaw`, `~/.config/ghostty-launcher`, or
   `~/.ghostty-launcher`.

## Q5 — Package defaults, code constants, docs, tests consistent? YES, two doc-level drifts

Consistent and drift-proofed:
- manifest default ↔ `DEFAULT_LANE_REGISTRY_FILES` locked by
  `lane-registry-defaults-contract.test.ts` (`toEqual`, plus order assertion);
- the proof helper `expandedDefaultLaneRegistryPaths` derives from the same
  constant (single source of truth on the proof side);
- docs (manifest description, resolver docstrings, SKILL.md, sources
  reference, receipt) all tell the same two-channel/bridge story.

Inconsistencies found (the fixups):
- **FIXUP-1:** `src/services/integration-test-api.ts:104-110` — the
  `CommandCentralLauncherRegistrySnapshot` doc comment still says "The
  installed VSIX proof asserts quarantine (`resolvedFilePaths: []`, zero
  launcher tasks under default settings)". That is the pre-2f1ab599 contract;
  the proof now asserts exactly the two zero-config lane registries resolve
  and only stale ids are forbidden.
- **FIXUP-2:** same file, line 98 — `resolvedFilePaths` is documented as
  "Launcher tasks.json paths the provider actually resolved", and
  `launcherTaskIds` by name implies launcher-only; both now legitimately
  include lane-registry bridges and LaneRef-backed records.

Design note (no action): the resolver-side
`options?.laneRegistryFiles ?? DEFAULT_LANE_REGISTRY_FILES` fallback is
unreachable from the provider in production (the provider always passes an
array; real VS Code supplies the manifest default, mocks yield `[]`). There
are therefore two synchronized copies of the default; the contract test makes
drift impossible, so this is acceptable — just know the production zero-config
path flows through the manifest, not the constant.

## Q6 — What must be fixed before the next dogfood VSIX/proof?

Blocking-for-sign-off (the gate itself, already planned in the receipt):
1. **Execute the installed-VSIX proof on the dogfood host**
   (`just dist` → install → `just test-installed-vsix-agent-status`). The
   contract was rewritten in this commit but not executed (network-restricted
   lane — honestly disclosed). Proof preconditions verified by this review:
   `TASKS_FILE` is blanked in `extensionTestsEnv`
   (`runInstalledVsixAgentStatusProof.ts:608-610`), and `resolvedFilePaths`
   is populated from resolved sources regardless of file existence, so the
   exact-match assertion is well-defined even with the bridge file absent.
2. **Remove any user-level `commandCentral.laneRegistry.files` override** on
   the dogfood host before the proof (receipt step 1) — an override would
   fail the exact-path assertion by design.

Fixups to land (small, can ride the proof lane; none blocks the VSIX cut):
3. **FIXUP-1 (do before proof debugging):** rewrite
   `src/services/integration-test-api.ts:104-110` to state the current
   contract, e.g.: "The installed VSIX proof asserts the default lane
   registry contract (`resolvedFilePaths` = exactly the zero-config lane
   registries, no stale non-`project_ref` ids ingested) and the legacy escape
   hatch (fixture path resolved, sentinel ids ingested)."
4. **FIXUP-2:** update the `resolvedFilePaths` / `launcherTaskIds` field docs
   in the same interface to say they cover lane-registry sources and
   LaneRef-backed records, not only launcher tasks.json ingestion.
5. **FIXUP-3 (optional, follow-up lane):** render the legacy-diagnostics
   deprecation marker (or an equivalent badge) in the Symphony view too —
   today only the Agent Status tree is marked while the escape hatch is on.

Already-tracked follow-ups (receipt residuals, endorsed): Ghostty lane to
mirror LaneRef projection into `~/.config/openclaw/lanes.json` (until then,
zero-config visibility rides the deprecated compat path alone); the
OpenClaw-native Work System projection as the end state; discovered-agent
basename naming residual from `70901b74`.

## Receipt accuracy

Spot-checked every load-bearing claim: default values, deprecation wording
(verbatim match), marker row label/description/icon, hermeticity mechanism,
test inventory and counts, verification numbers, and the residual-risk list.
All accurate; the receipt neither overclaims (it flags the unexecuted proof
and the producer gap itself) nor omits anything I found except the two stale
doc comments and the Symphony-view marker gap listed above.

— Reviewer, task `review-command-central-lane-registry-20260611`
