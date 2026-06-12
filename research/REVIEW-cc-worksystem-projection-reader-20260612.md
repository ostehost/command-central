# REVIEW — cc-worksystem-projection-reader-20260612

**Task:** review-cc-worksystem-projection-reader-20260612
**Repo:** ~/projects/command-central
**Role:** reviewer (read-only manager review)
**Date:** 2026-06-12
**Commits under review:** b1803349 `feat(agent-status): ingest work-system-lanes-projection lane registry shape`; f94ec43d `docs(agent-status): add work-system projection reader receipt`
**Receipt under review:** `research/RESULT-cc-worksystem-projection-reader-20260611.md`

## Verdict: **ACCEPT**

All five review questions answer favorably. Every gate the receipt claims was independently re-run by this review and reproduced exactly (full suite 2022 pass / 1 skip / 0 fail across 144 files). The cross-repo shape was verified directly against the Ghostty Launcher bridge writer and schema — the CC reader matches what the bridge emits field-for-field. No blockers for dry-run/outbox CC-read dogfood; four non-blocking observations are listed for the dogfood watch list.

---

## Q1 — Does CC correctly ingest the projection shape without warnings and transform lane_ref_update into AgentTask rows?

**Yes.**

- **Shape recognition.** `readRegistryFile` (src/providers/agent-status-tree-provider.ts:3312) branches on the self-describing `kind === "work-system-lanes-projection"` discriminator *before* the legacy `{version, tasks}` path. Legacy registries carry no `kind`, and the §6 drainable op-queue lives at a different path with a different envelope, so misclassification is structurally impossible. Version is strictly `=== 1` (the only version the bridge writes — confirmed in `work_system_bridge_write_outbox()`, ghostty-launcher scripts/lib/work-system-bridge.sh:154–180, which hard-sets `.version = 1` via jq).
- **Cross-repo shape match verified at source.** The bridge maintains `{version: 1, kind: "work-system-lanes-projection", lanes: {<lane_ref.id>: <update>}, updated_at}`; the envelope fields the CC transform reads (`lane_ref.id/provider/surface/session/task/worktree/lane_kind/lane_kind_source/status/updatedAt`, envelope-level nullable `project_ref`) match `scripts/laneref-update-schema.json` exactly. Every launcher-native status the schema names (running, completed, completed_dirty, contract_failure, failed, killed, stopped) is in CC's `VALID_TASK_STATUSES`; unknown values normalize to `stopped` as everywhere else.
- **Transform correctness.** `laneRefUpdateToTaskRecord` (provider:1117) feeds the existing `normalizeTask` path: `lane_ref.task` → `id`/`task_id`; `lane_ref.id` retained as `provenance.source_ref` with `adapter_kind: "work-system-lanes-projection"`; `provider` → `source_authority`; `surface` → `terminal_backend` guarded to the known enum (`auto` drops to undefined); `worktree` → `execution_dir`/`exec_cwd`/best-effort `project_dir`; `updatedAt` → `updated_at`/`started_at`. Session-less envelopes get the `launcher:<task_id>` placeholder, which is always non-empty (so `normalizeTask` admits the row) yet fails `isValidSessionId` by construction (`:` is outside `[a-zA-Z0-9._-]`, provider:153) — focus actions refuse loudly rather than fabricating a session, consistent with the no-silent-fallback policy.
- **Warning-free.** Verified by running the new suite: the happy-path tests spy `console.warn` and assert zero fallback warnings; the previously predicted benign "missing a valid tasks collection" warning for lanes.json is gone.

## Q2 — Are primary registry records authoritative over projection rows regardless of file order?

**Yes, for every realistic configuration.**

The merge rule in `readRegistry` (provider:3193–3217) checks the preferred key (`task.id || key`) before suffix disambiguation: a projection row is skipped when a primary record already holds the key (`continue` at 3202), and a primary record replaces a previously merged projection row in place (3203–3207) instead of suffix-duplicating. Both directions are covered by tests — default order (projection file read first, later primary replaces it: stale projection `running` loses to settled `completed`) and reversed order. Suffix disambiguation for non-projection collisions (hub/node mirrors) is untouched.

One **theoretical** edge (observation 2 below): with *two* projection sources carrying the same task id, the second projection row would suffix-disambiguate (both rows are `lane_projection`, so neither precedence branch fires), and a later primary record would replace only the unsuffixed row, leaving the suffixed projection duplicate. This requires a non-default config with multiple projection files containing the same lane; the default config has exactly one projection file, so the path is unreachable in practice. Not a blocker.

## Q3 — Is lane-record quarantine preserved for missing/null project_ref?

**Yes.**

- Every `laneRegistry.files` source — projection or legacy shape — is assigned `ingest: "lane-records-only"` by `resolveTaskRegistrySources` (src/utils/tasks-file-resolver.ts:230), and the projection path routes through the same `applyIngestFilter` (provider:3332) as the legacy path. The projection never widens admission.
- `normalizeTaskProjectRef` (provider:870) returns null when `project_ref.id` is missing/empty, so both quarantine variants — `project_ref: null` (legacy/resolution-skipped lanes) and `project_ref: {id: null, ...}` (unregistered record shape) — fail `isRegistryBackedLaneTask` and stay quarantined with the existing logged count. Both variants have dedicated test coverage.
- `legacyLauncherTasks.enabled` default remains `false`.

## Q4 — Are defaults unchanged and tests credible?

**Yes on both.**

- **Defaults.** `DEFAULT_LANE_REGISTRY_FILES` is unchanged (`~/.config/openclaw/lanes.json`, `~/.config/ghostty-launcher/tasks.json`); the package.json diff touches only the setting's `markdownDescription`, not the default array; no new settings. The `lane-registry-defaults-contract` test pins this and passes.
- **Tests credible.** The new suite (test/integration/worksystem-lanes-projection.test.ts, 10 tests) is well constructed: sandboxed `$HOME` so zero-config defaults resolve inside the fixture dir; fixtures mirror the bridge writer's document and the schema's envelope byte-shape (including the `release-proof` → `review` + `lane_kind_source` case and `project_ref_record_registered()` extras like `lanePolicy`/`resolution`); `console.warn` spied with a fallback-message filter; merge precedence asserted in both file orders; malformed-sibling skip; version/lanes fallback diagnostics asserted by content, not count.
- **Gates independently reproduced by this review (read-only):**

| Gate | Receipt claim | Reviewer re-run |
| --- | --- | --- |
| `bun test test/integration/worksystem-lanes-projection.test.ts` | 10 pass / 0 fail | **10 pass / 0 fail** |
| Targeted regression (lane-registry-projection, read-registry, tasks-file-resolver, + defaults-contract) | 56 pass / 0 fail | **60 pass / 0 fail** (4 files; the extra 4 are the defaults-contract file — trivial file-set difference, not material) |
| `just check` (biome ci + tsc + knip) | pass | **pass** |
| `just test` (full suite + typecheck) | 2022 pass / 1 skip / 0 fail (144 files) | **2022 pass / 1 skip / 0 fail (144 files)** — exact match |
| `just test-validate` | pass | **pass** (new file lands in the `integration` partition, 13 tests) |

- **Docs coherent.** The resolver jsdoc, package.json description, SKILL.md, and `references/agent-status-sources.md` all describe the same two recognized shapes, the read-only/never-create framing, and the primary-wins rule; the schema block in agent-status-sources.md matches the launcher schema. The receipt itself is accurate — no claim it makes was contradicted by inspection or re-execution.

## Q5 — Any blocker before dry-run/outbox CC-read dogfood?

**No blockers.** Four non-blocking observations for the dogfood watch list:

1. **lanes.json never prunes.** The bridge only upserts (`.lanes[$id] = $update`); rows for tasks later pruned from tasks.json will resurface in CC as projection-only rows (no primary left to win the merge). Mostly these land in the done group, but a lane that hit the documented stale-LWW race (terminal update clobbered, stuck at `running`) could reappear as a perpetually-running row with a dead session. CC's behavior is correct per the contract (the projection only fills gaps and never overrides a primary), but expect ghost rows after task pruning during extended dogfood; convergence-needing consumers must read tasks.json, as the launcher docs already state.
2. **Dual-projection suffix duplicate (theoretical).** See Q2 — only reachable with a non-default config naming two projection files that carry the same lane. If multi-host projection mirroring ever becomes a real configuration, extend the precedence rule to also sweep suffixed projection keys.
3. **`surface: "auto"` rows.** The schema permits `auto` verbatim; CC's enum guard drops it to undefined, which downstream focus logic treats as legacy tmux-backed. Only matters for projection-only rows (a primary record carries its own `terminal_backend` and wins); failure mode is a loud tmux-attach error, not a silent fallback. If it surfaces in dogfood, the cleaner fix is launcher-side: emit the resolved backend instead of the `auto` literal.
4. **Skill propagation deferred.** `openclaw skills install` for the updated `command-central-vscode-extension` skill is correctly deferred (no network/install in these lanes) and already tracked as receipt follow-up 1 — run it before relying on the skill's projection documentation from OpenClaw.

## Cross-repo status

The REVIEW-ghostty-contract-alignment-20260611 fixup-1 decision triple is resolved by the middle option (CC learns the projection): contract §6.2's claim that lanes.json carries a shape Command Central's default ingest reads is now true, verified against both sides of the contract. Expected dogfood behavior matches the receipt: lanes appear once (primary tasks.json record wins while both defaults are populated) and the lanes.json fallback warning no longer fires. Launcher-side follow-ups (completed_dirty emission assertion, spawn project_ref passthrough assertion, reaper/watchdog emission gaps, kill-path emission outside the tasks lock) remain tracked in the launcher review and are not blockers for CC-read dogfood.

---

*Review performed read-only: working tree left untouched (verified clean at HEAD f94ec43d before and after); no fetch/pull/push/install/network. All test/gate executions were local and non-mutating.*
