# RESULT — cc-004 Preview proof + local prerelease cut (2026-06-11)

Task: `cc-004-preview-proof-cut-20260611`
Scope: local dogfood only. No push, no tag, no publish, no PR, no network.

## Starting point

- Starting commit: `64d5ca45b20460c1cfee6eebf8f7bb05eab57185`
  (cc-003 quarantine of launcher tasks.json behind
  `commandCentral.legacyLauncherTasks.enabled`).
- Starting version: `0.6.0-rc.55` — note rc.55 was cut from the commit
  *before* the quarantine fix, so no shipped artifact contained the
  quarantine behavior when this lane started.
- Tree clean, `main...origin/main [ahead 12]` at launch.

## Proof gap found and closed

The installed-VSIX proof (`just test-installed-vsix-agent-status`) only
exercised the legacy escape hatch, and its default registry path was the
operator's real `~/.config/ghostty-launcher/tasks.json`. There was no live
Extension Host proof of the quarantine default at all.

Closed in commit `60063b2f` (`test(agent-status): two-phase installed-VSIX
proof for launcher quarantine`):

- New read-only inspection API `getLauncherRegistrySnapshot()`
  (`src/services/integration-test-api.ts`) — resolved launcher registry
  paths + launcher-only task ids per provider (Agent Status and Symphony),
  so ingestion/quarantine is asserted at the data layer.
- The proof runner now runs two phases per invocation:
  - **quarantine-default** — pristine `settings.json` (`{}`); asserts both
    providers resolve zero launcher registries and ingest zero launcher
    tasks, and that none of the operator's real registry task ids surface
    as launcher-attributed tree rows (OpenClaw-native appearances of the
    same ids are not flagged).
  - **legacy-fixture** — `legacyLauncherTasks.enabled: true` +
    `agentTasksFile` pointing at a generated temp sentinel registry
    (2 tasks, `agent_backend` claude + codex); asserts the fixture path
    resolves, both sentinel ids ingest, and both are visible in the tree.
- Hermetic by default: the legacy phase uses the generated sentinel
  fixture; reading a real registry now requires the explicit
  `COMMAND_CENTRAL_TASK_REGISTRY_PATH` override. `TASKS_FILE` is
  force-cleared in the Extension Host env so an operator shell can never
  leak a registry into the proof.

## Proof runs (real VS Code 1.124.0 Extension Host, installed VSIX)

1. **Pre-cut, temporary proof artifact** built from `60063b2f`
   (`bun build` prod bundle + `bunx @vscode/vsce package` →
   `/tmp/cc-004-proof/command-central-temp-proof.vsix`,
   sha256 `fe34aafd…e25d8757`, identity `temporary-proof-artifact`):
   - `VSCODE_VERSION=1.124.0 just test-installed-vsix-agent-status --vsix <tmp> --expected-sha <sha> --identity-kind temporary-proof-artifact`
   - quarantine-default: launcher registry `0 task(s) from [none]` on both
     providers; **14 forbidden ids supplied (12 from the real global
     registry + 2 sentinels), 0 launcher-attributed hits**; errors `[]`.
   - legacy-fixture: fixture resolved, 2/2 sentinel ids ingested and
     visible; 0 forbidden hits; errors `[]`.
2. **Post-cut, published rc.56 artifact**
   (`releases/command-central-0.6.0-rc.56.vsix`, sha256
   `636ff329…b62e02fc`, identity `published-prerelease`):
   - Same two-phase run; both phases green; manifests record
     `published_release_match: true`, `vsix_matches_expected_sha: true`,
     `errors: []` (logs/installed-vsix-agent-status-proof-1781214785879-*.json).

This is the live proof that with default settings Command Central does
**not** ingest the operator's real global launcher registry, and that the
legacy diagnostics hatch still works against a temp fixture registry.

## Gates run

- `bun test test/integration/installed-vsix-proof-harness.test.ts
  test/services/integration-test-api.test.ts` — 16 pass
- `just fix` + `just check` — biome ci + tsc + knip clean
- `just test` — 1970 pass / 1 skip / 0 fail (137 files), quality checks pass
- `just cut-preview` internally ran `_preview-preflight`, `sync-launcher`,
  `_preview-rehearsal` (`just ci`), and the cross-repo `prerelease-gate`
  (launcher repo clean; gate provenance in `research/prerelease-gate/`).

## Preview cut

- Command: `just cut-preview` (defaults to `--prerelease`).
- Result: version bump `0.6.0-rc.55 → 0.6.0-rc.56`, VSIX content gate
  green (269820 bytes compressed / 893271 uncompressed / 52 files, all
  within budget), artifact `releases/command-central-0.6.0-rc.56.vsix`,
  digest `releases/digest-v0.6.0-rc.56.md`, rc.53 VSIX pruned by the
  keep-last-3 policy.
- Installed to the local VS Code profile by the dist step;
  `just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.56.vsix
  --expected-version 0.6.0-rc.56` → `success: true`
  (`installedVersionFromCode: 0.6.0-rc.56`).
- `just preview-status` → exit code 0, artifact sha matches.

## Commits

- `60063b2f` — test(agent-status): two-phase installed-VSIX proof for
  launcher quarantine (src inspection API + harness + unit tests).
- `93185bd3` — chore(release): cut rc56 dogfood preview (version bump,
  digest, gate provenance).
- This receipt is committed separately on top.

Not pushed — local only, per task constraints.

## Residual risks

- A `Developer: Reload Window` is still required in any already-open
  VS Code window before rc.56 is active there (install is on disk and
  verified; the running session was not force-reloaded).
- The quarantine id sweep is only as strong as the real registry on the
  proof machine (14 forbidden ids here). On a machine with no global
  registry the sweep is vacuous — the harness logs that case explicitly
  and the registry-snapshot assertions (no resolved paths, zero launcher
  tasks) still hold.
- Live action probes (`--live` + `COMMAND_CENTRAL_REQUIRED_TASK_ID`) were
  not exercised in this lane (passive mode both phases); they remain
  legacy-phase-only by design since quarantine ingests no launcher tasks.
- `TASKS_FILE` remains an unconditional per-process override in the
  resolver (accepted in cc-003); the proof now shields itself from it but
  operator shells exporting it still feed real registries into dogfood.
- Next: design the OpenClaw/Symphony-native source of truth, then delete
  `legacyLauncherTasks` and the launcher resolution paths outright
  (per cc-003 receipt "Next").
