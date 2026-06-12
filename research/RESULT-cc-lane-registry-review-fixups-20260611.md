# RESULT — cc-lane-registry-review-fixups-20260611

- **Task:** cc-lane-registry-review-fixups-20260611 (developer, review fixups)
- **Source review:** `research/REVIEW-command-central-lane-registry-20260611.md`
  (verdict ACCEPT_WITH_FIXUPS on commit `2f1ab599`)
- **Scope landed:** FIXUP-1 and FIXUP-2 (stale doc comments in
  `src/services/integration-test-api.ts`), plus a test-name refresh and one
  focused test. FIXUP-3 (Symphony-view deprecation marker) was explicitly
  optional/follow-up-lane in the review and is **not** included here.
- **Date:** 2026-06-11

## What changed

### FIXUP-1 — `CommandCentralLauncherRegistrySnapshot` doc comment

`src/services/integration-test-api.ts` (interface doc, previously lines
104–110) still described the pre-`2f1ab599` installed-VSIX proof contract:
"asserts quarantine (`resolvedFilePaths: []`, zero launcher tasks under
default settings)". Rewritten to state the current contract, matching what
`test/integration/installed-vsix-proof-suite.ts` actually asserts in the
`quarantine-default` phase:

> Ground truth for task registry ingestion, per provider. The installed VSIX
> proof asserts the default lane registry contract (`resolvedFilePaths` =
> exactly the zero-config lane registries, with stale non-`project_ref` ids
> quarantined out of `launcherTaskIds`) and the legacy escape hatch (fixture
> path resolved, sentinel task ids ingested) against this snapshot rather
> than inferring ingestion from rendered tree labels.

### FIXUP-2 — field docs on `CommandCentralLauncherRegistryProviderSnapshot`

- `resolvedFilePaths` was documented as "Launcher tasks.json paths the
  provider actually resolved and ingests". Now documents that under default
  settings these are exactly the zero-config lane registry bridges
  (`commandCentral.laneRegistry.files`), with legacy launcher tasks.json
  paths appearing only via the deprecated
  `commandCentral.legacyLauncherTasks.enabled` escape hatch.
- `launcherTaskIds` had no doc and the name implies launcher-only ingestion.
  Now documented: ids of every registry-ingested task ("launcher" for
  historical reasons only); under defaults the `lane-records-only` filter
  admits just LaneRef-backed records (non-empty `project_ref.id`), and stale
  launcher-era ids reach the list only through the legacy escape hatch.

No runtime behavior changed in `src/` — comment-only edits; the snapshot
projection logic (`getLauncherRegistrySnapshotForProvider`) is untouched.

### Test refresh — `test/services/integration-test-api.test.ts`

- Renamed the stale-contract test "reflects quarantine defaults: no resolved
  paths, no launcher tasks" → "reflects an explicit lane-registry opt-out:
  no resolved paths, no tasks". The old name embodied the same retired
  contract as FIXUP-1 (defaults ≠ empty paths anymore); the assertion body
  (a pure pass-through of an empty provider) is unchanged and now correctly
  describes the explicit `laneRegistry.files: []` opt-out shape.
- Added one focused test: "mirrors the zero-config default: lane registries
  resolved in precedence order, LaneRef-backed ids only". It feeds
  `DEFAULT_LANE_REGISTRY_FILES` (imported from
  `src/utils/tasks-file-resolver.ts`, the same constant the proof helper
  derives from) through the snapshot projection and asserts the paths pass
  through verbatim with the OpenClaw bridge file leading, plus a lone
  LaneRef-backed id. This locks the snapshot layer to the same
  single-source-of-truth constant the contract test and proof use.

## Defaults preserved (required by the task)

- `commandCentral.laneRegistry.files` default untouched —
  `package.json` and `DEFAULT_LANE_REGISTRY_FILES` still
  `["~/.config/openclaw/lanes.json", "~/.config/ghostty-launcher/tasks.json"]`;
  re-verified by `test/package-json/lane-registry-defaults-contract.test.ts`
  (green).
- `commandCentral.legacyLauncherTasks.enabled` default still `false` with
  its `markdownDeprecationMessage` — untouched, re-verified by the same
  contract test.

## Verification

| Check | Result |
| --- | --- |
| `bun test test/services/integration-test-api.test.ts test/package-json/lane-registry-defaults-contract.test.ts test/utils/tasks-file-resolver.test.ts test/integration/installed-vsix-proof-harness.test.ts` | 60 pass / 0 fail |
| `just fix` | No fixes needed (clean) |
| `just check` (biome ci + tsc + knip) | Clean (knip warnings informational only) |
| `just test` (full supported suite) | **2012 pass / 1 skip / 0 fail** (was 2011 pass; +1 = the new focused test) |

No network, push, fetch, pull, or install was performed.

## Files changed

- `src/services/integration-test-api.ts` — comment-only (FIXUP-1, FIXUP-2)
- `test/services/integration-test-api.test.ts` — test rename + 1 new test
- `research/RESULT-cc-lane-registry-review-fixups-20260611.md` — this receipt

## Residuals / next steps

- **FIXUP-3 (optional, from the review):** render the legacy-diagnostics
  deprecation marker in the Symphony view (`getChildren` returns
  `getSymphonyChildren()` before the marker is prepended). Still open;
  follow-up lane.
- **Manager gate unchanged:** execute the installed-VSIX proof on the
  dogfood host (`just dist` → install → `just
  test-installed-vsix-agent-status`), after removing any user-level
  `commandCentral.laneRegistry.files` override there.
- Producer gap residual stands: nothing writes `~/.config/openclaw/lanes.json`
  yet, so zero-config visibility rides the deprecated compat path.

— Implementer, task `cc-lane-registry-review-fixups-20260611`
