# RESULT — cc-worksystem-projection-reader-20260611

**Task:** cc-worksystem-projection-reader-20260611
**Repo:** ~/projects/command-central
**Role:** developer
**Date:** 2026-06-12 (work performed against the 2026-06-11 review)

## Objective

Close the cross-repo projection-reader gap from
`~/projects/ghostty-launcher/research/REVIEW-ghostty-contract-alignment-20260611.md`
(fixup 1): Command Central's default lane registry reader only understood the
legacy `{version, tasks: {...}}` registry shape, so the transitional Work
System lanes read-model/projection that the Ghostty Launcher bridge writes to
`~/.config/openclaw/lanes.json` in outbox mode — `{version: 1, kind:
"work-system-lanes-projection", lanes: {<lane_ref.id>: <lane_ref_update>},
updated_at}` (config@48b3fb3 §6.2) — parsed to **zero rows plus a fallback
warning**. The projection had no readers.

This is **transitional bridge compatibility only**. The long-term primary
source remains the OpenClaw-native Work System plugin/API
(`workSystem.lanes.list` + per-session `workSystem` projection); the file
defaults retire when that lands.

## What changed

### Reader (`src/providers/agent-status-tree-provider.ts`)

1. **Shape recognition.** `readRegistryFile` now branches on the
   self-describing `kind === "work-system-lanes-projection"` discriminator
   before the legacy `{version, tasks}` path. Version 1 is required (the only
   version the bridge writes); any other version falls back to an empty
   registry with an explicit `unsupported … version` warning, as does a
   missing/non-object `lanes` collection. Legacy registries are untouched.

2. **Envelope transform** (`laneRefUpdateToTaskRecord` +
   `normalizeProjectionLanes`). Each `lane_ref_update` envelope (per
   ghostty-launcher `scripts/laneref-update-schema.json`) becomes a raw task
   record fed through the existing `normalizeTask` path:
   - `lane_ref.task` → `id`/`task_id` (correlates stream files and
     pending-review receipts); `lane_ref.id` (`launcher:<task_id>`) is kept as
     `provenance.source_ref` with `adapter_kind:
     "work-system-lanes-projection"`.
   - `lane_ref.status` → `status` verbatim (launcher-native enum matches
     `AgentTaskStatus`; unknowns normalize to `stopped` as everywhere else).
   - `lane_ref.lane_kind` / `lane_ref.lane_kind_source` → preserved as-is
     (e.g. `review` + `release-proof`).
   - `lane_ref.session` → `session_id`; a session-less envelope falls back to
     `lane_ref.id`, which fails `isValidSessionId` by construction (contains
     `:`) so focus actions refuse loudly instead of acting on a fabricated
     session — no silent fallback.
   - `lane_ref.worktree` → `execution_dir` / `exec_cwd` / best-effort
     `project_dir`; `lane_ref.surface` → `terminal_backend` (guarded to the
     known enum; `auto` drops to undefined).
   - `lane_ref.updatedAt` → `updated_at` and `started_at` (the only timestamp
     the projection carries; stable across reads).
   - `project_ref` → passed through (registered records with
     `lanePolicy`/`resolution` extras tolerated); `project_ref.id` backfills
     legacy `project_id` per the contract ("legacy project_id equals it for
     registered lanes"); `lane_ref.provider` → `source_authority`.

3. **Model extension.** `AgentTask` gains `lane_kind_source?: string | null`
   (also normalized from plain registry rows) and the internal marker
   `lane_projection?: boolean` (set only by the projection transform,
   documented like `project_name_derived`).

4. **Projection is never authoritative truth.** Grouping by `project_ref.id`
   was already in place; the new merge rule in `readRegistry` adds the truth
   ordering: when a primary registry record and a projection row share a task
   id, the primary record wins **regardless of file order** — the projection
   row neither displaces it nor duplicates it under a suffixed key. This also
   means the projection's known stale-LWW terminal race (clobbered terminal
   update stuck at `running`) cannot override a settled tasks.json status.
   Existing suffix-disambiguation for non-projection collisions (hub/node
   mirrors) is unchanged.

5. **Quarantine preserved.** Projection rows pass through the same
   `lane-records-only` ingest filter as every lane registry source: envelopes
   with `project_ref: null` (legacy / resolution-skipped lanes) or
   `project_ref.id: null` (unregistered record shape) stay quarantined with
   the existing logged count. The projection never widens what a lane
   registry may admit, and `legacyLauncherTasks.enabled` stays `false`.

### Defaults (unchanged, as constrained)

`commandCentral.laneRegistry.files` default remains
`["~/.config/openclaw/lanes.json", "~/.config/ghostty-launcher/tasks.json"]`
(pinned by `test/package-json/lane-registry-defaults-contract.test.ts`, which
still passes). No new settings.

### Docs / framing

- `src/utils/tasks-file-resolver.ts` — `DEFAULT_LANE_REGISTRY_FILES` jsdoc now
  documents the projection shape on the lanes.json bullet and its
  read-model/never-truth status.
- `package.json` — `commandCentral.laneRegistry.files` description names both
  recognized shapes and the primary-wins rule.
- `.claude/skills/command-central-vscode-extension/SKILL.md` +
  `references/agent-status-sources.md` — projection document schema, field
  mapping, and the read-only/never-create framing. (Skill propagation to
  OpenClaw via `openclaw skills install` deferred — no network/install in this
  lane.)

## Tests

New focused suite `test/integration/worksystem-lanes-projection.test.ts`
(10 tests), with fixtures mirroring the bridge's emitted shape byte-for-byte
(`work_system_lane_ref_update` envelope + `work_system_bridge_write_outbox`
document, registered `project_ref_record_registered()` record), under a
sandboxed `$HOME`:

- bridge-shaped projection ingests with **no warnings/fallback** (console.warn
  spied; status, lane_kind, lane_kind_source, session/task/worktree ids,
  source labels, provenance, and updated timestamps all asserted verbatim);
- rows render grouped by `project_ref.id` (worktree lane joins the canonical
  group, no fabricated basename group);
- zero-config default reads the projection from `~/.config/openclaw/lanes.json`;
- `project_ref: null` and `id: null` envelopes stay quarantined;
- session-less envelope stays visible with the non-actionable placeholder;
- primary registry record wins over a projection row for the same task id in
  both default and reversed file order (stale projection `running` loses to
  settled `completed`);
- unsupported projection version / missing lanes collection warn and fall back
  to empty;
- malformed sibling envelopes are skipped without dropping valid rows.

## Gates (all green, local only)

| Gate | Result |
| --- | --- |
| `bun test test/integration/worksystem-lanes-projection.test.ts` | 10 pass / 0 fail |
| Targeted regression (`lane-registry-projection`, `read-registry`, `tasks-file-resolver`) | 56 pass / 0 fail |
| `just check` (biome ci + tsc + knip) | pass |
| `just test` (full suite + typecheck) | 2022 pass / 1 skip / 0 fail (144 files) |
| `just test-validate` (partition coverage) | pass — new file lands in the `integration` partition |

No push/fetch/pull/network/install performed.

## Cross-repo status after this change

The REVIEW fixup-1 decision triple (launcher emits CC rows / **CC learns the
projection** / contract reschedules §6.2) is resolved by the middle option:
contract §6.2's claim that lanes.json carries a shape Command Central's
default ingest reads is now true. CC-read dogfood of outbox mode is unblocked.
Expected dogfood behavior: lanes appear once (primary tasks.json record wins
while both defaults are populated), and the previously predicted benign
"missing a valid tasks collection" warnings for lanes.json no longer occur.

## Follow-ups (not in this lane)

1. Propagate the updated skill to OpenClaw:
   `openclaw skills install .claude/skills/command-central-vscode-extension --as command-central-vscode-extension --force`.
2. Launcher-side (already tracked in the review): `completed_dirty` emission
   assertion, spawn `project_ref` passthrough assertion, reaper/watchdog
   emission gaps, kill-path emission outside the tasks lock.
3. When the OpenClaw-native Work System projection lands, retire both file
   defaults behind a native service and drop this bridge path.
