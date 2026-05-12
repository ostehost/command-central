# AUTOPROC — Command Central Symphony Proof/Test Snapshot Refactor

- **Task id:** `autoproc-cc-snapshot-refactor-20260511-2158`
- **Repo:** `/Users/ostehost/projects/command-central`
- **Branch:** `main`
- **Commit:** `6390f844` — `refactor(extension): extract integration test API into dedicated module`
- **Status:** ✅ success — committed locally, **not pushed**

## Problem

`src/extension.ts` had absorbed ~390 lines of integration-test/proof
snapshot serialization for Agent Status and Symphony trees:

- Nine `CommandCentral*` interfaces describing the wire-shape of the
  test API.
- Pure helpers (`treeItemLabelToString`, `treeItemDescriptionToString`,
  `serializeUnknown`, `serializeCommand`, `serializeCommandArgument`,
  `isVsCodeUriLike`, `selectedAgentStatusOwnerFields`,
  `matchesRequiredTaskId`).
- The bounded tree walker `getTreeSnapshotForProvider`.
- Two thin `getAgentStatusTreeSnapshot` / `getSymphonyTreeSnapshot`
  dispatchers that closed over module-level provider state.
- The `getIntegrationSnapshot` / `getAgentStatusSnapshot` helpers that
  closed over every module-level service handle.
- The literal object that the test API exports.

This made `extension.ts` (3958 lines) host two concerns: activation wiring
and a fully-fledged read-only serialization surface for the test harness.
It was the canonical anti-pattern of "test-mode logic inside activation."

## Change

New module: **`src/services/integration-test-api.ts`** (453 lines).

It exports:

- The full `CommandCentral*` interface surface (`...Snapshot`,
  `...TreeNode`, `...TreeSelectedNode`, `...TreeSnapshot`,
  `...TreeSnapshotOptions`, `...DeactivationSnapshot`,
  `...SerializedCommand`, `...IntegrationTestApi`).
- `IntegrationTestApiDeps` — a tiny accessor contract that lets the
  wiring file (extension.ts) hand over its module-level provider/state
  references without exposing them globally. Every dep is a lazy
  getter so `deactivateForTest`'s before/after pair always reads the
  current state, not a captured one.
- `getTreeSnapshotForProvider(provider, options)` — the bounded
  serializer (same `maxDepth`/`maxChildrenPerNode` caps, same
  `codexRuns`/`symphonyRunGroup` 5-child sub-cap, same
  required-label/required-task-id selection).
- `getAgentStatusSnapshot(provider)` and `getIntegrationSnapshot(deps)`
  as pure functions.
- `createIntegrationTestApi(deps)` — the factory that returns the
  same shape activation used to hand-roll inline.

All internal helpers (`serializeUnknown`, `serializeCommand`,
`selectedAgentStatusOwnerFields`, `matchesRequiredTaskId`,
`treeItemLabelToString`, `treeItemDescriptionToString`,
`isVsCodeUriLike`) stay non-exported — they are projection details, not
the public test contract.

### `src/extension.ts` shrinks to wiring

- Removes ~390 lines of snapshot logic and the `AgentNode` import that
  only existed for the projection helpers.
- Adds a 4-line import of `createIntegrationTestApi`, the deps type,
  and `CommandCentralIntegrationTestApi` (still needed as the
  `activate()` return type).
- Adds a single `export type { … } from "./services/integration-test-api.js"`
  re-export so any caller that imported these types from `./extension.js`
  keeps compiling. (None do today, but the types were previously
  `export interface`, so we preserve the surface conservatively.)
- Keeps `isIntegrationTestMode()` and
  `clearIntegrationTestContextSubscriptions()` in extension.ts because
  they read/mutate the local `integrationTestContext` `let` binding.
- Replaces the inline `return { kind: …, getSnapshot: …, … }` object in
  `activate()` with:

  ```ts
  const deps: IntegrationTestApiDeps = {
    getExtensionContext: () => integrationTestContext,
    getAgentStatusProvider: () => agentStatusProvider,
    getSymphonyProvider: () => symphonyProvider,
    hasProjectViewManager: () => projectViewManager !== undefined,
    …
    deactivate,
    clearIntegrationTestContextSubscriptions,
  };
  return createIntegrationTestApi(deps);
  ```

### Test update

`test/integration/installed-vsix-proof-harness.test.ts` has a guard
test that asserts `COMMAND_CENTRAL_TEST_MODE` is **only** used to
expose the inspection API and that the string `getAgentStatusTreeSnapshot`
appears somewhere in the union of "files that mention TEST_MODE."
Added `src/services/integration-test-api.ts` to that file list so the
assertion still describes the full surface after extraction.

External test API behavior is unchanged: same method names, same
parameter shapes, same return shapes, same bounded traversal caps.
`test/integration/suite/helpers.ts` (which duplicates the type surface
test-side rather than importing from src) was not touched — it is the
test contract and stays as a structural shadow of the public API.

## Files changed

- `src/extension.ts` — −398 lines, +41 lines (snapshot logic out; wiring + re-export in)
- `src/services/integration-test-api.ts` — **new** module (453 lines)
- `test/integration/installed-vsix-proof-harness.test.ts` — +1 line (add new module to inspection-only guard)

(`.oste-report.yaml` is an ephemeral final summary; it is not committed.)

## Tests run

| Command | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean (no output) |
| `just fix` (biome write) | "No fixes applied." (242 files) |
| `just check` (biome ci + tsc + knip) | ✅ all green |
| `bun test test/integration/installed-vsix-proof-harness.test.ts` | 6/6 pass, 19 expects |
| `bun test test/integration/*.test.ts` | 108/108 pass across 10 files |
| `just ci` (strict gate) | ✅ 1547 pass / 1 skip / 0 fail across 119 files in 10.9s; coverage + quality checks clean |

`just ci` is what GitHub Actions runs (`biome ci`, `tsc --noEmit`,
strict `knip`, full suite with coverage, `test-quality` gate). It
passed end-to-end.

## Verification of the contract

- `git status --porcelain` post-commit: clean.
- `test -s research/AUTOPROC-cc-snapshot-refactor-20260511-2158.md`: this file.
- No `--no-verify` was used (the project has no commit hooks defined
  beyond what `just ci` covers).
- No Ghostty Launcher / config changes; commit only touches
  `src/`, `test/`, and the new service file inside this repo.
- Not pushed.

## Residual risk

1. **Live extension activation, not just unit tests.** The new module is
   exercised by unit tests but the *integration* path that boots a real
   VS Code host (`runTest.ts`, the installed-VSIX proof) was not run end
   to end as part of this task — those require a downloaded VS Code
   binary and a built VSIX. The surface is byte-identical and `tsc`
   verifies the contract, but the first time `code --extensionDevelopmentPath`
   is used with `COMMAND_CENTRAL_TEST_MODE=1` after this refactor is
   the real regression gate. Run `bun test:integration` or
   `installed-vsix-proof-suite` against the next RC to close that loop.
2. **Lazy deps capture.** Each `getXxx` accessor closes over the
   `extension.ts` module-level `let` bindings. That mirrors the
   previous behavior of the inline factory exactly, but if any future
   refactor moves those bindings inside a class/scope, the deps object
   would need to follow.
3. **Type re-export.** The eight `CommandCentral*` types are still
   exported from `./extension.js` via `export type { … } from
   "./services/integration-test-api.js"`. Nothing imports them from
   either path today (`grep -rn "from.*extension\"" src test scripts-v2`
   returned no results), so the re-export is defensive — it can be
   pruned in a follow-up if knip's "unused exports" gate ever
   tightens, or once we are sure no out-of-tree consumer depends on
   the historic import path.
4. **`installed-vsix-proof-harness.test.ts` source-file list.** The
   inspection-only guard test now scans five files instead of four. If
   future code adds another `COMMAND_CENTRAL_TEST_MODE` touchpoint, it
   must be appended to that list to keep the assertion descriptive.

## Next steps (optional)

- Mirror the same extraction pattern on the next chunk of `extension.ts`
  that is candidate for a wiring-only file: workflow run / openclaw
  registration probably benefit similarly.
- Consider letting `test/integration/suite/helpers.ts` import the
  types from `src/services/integration-test-api.js` instead of
  re-declaring them, if/when the test compile path can safely pull
  the file without dragging the `vscode` module in.
