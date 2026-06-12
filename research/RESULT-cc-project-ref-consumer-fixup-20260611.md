# RESULT — cc-project-ref-consumer-fixup-20260611

Work Registry consumer fixup: Command Central now displays **active
registry-backed LaneRef records** without re-enabling stale global launcher
`tasks.json` as authoritative truth.

## Regression being fixed

Dogfood screenshot (2026-06-11): SYMPHONY showed `0` / "no projected runs"
and Agent Status sat on "Waiting for agents..." while live launcher lanes
existed whose task records carry `project_ref`, `canonical_project_dir`,
`execution_dir`, and `lane_kind`.

Root cause: cc-003 (`64d5ca45`) quarantined **all** launcher `tasks.json`
sources behind `commandCentral.legacyLauncherTasks.enabled` (default off).
Active Work Registry-backed lanes live in the same global registry file as
the stale launcher-era rows, so the quarantine removed the only source for
them — the extension had no model of `project_ref` at all (zero references
in `src/`/`test/` before this change).

## Fix design

1. **Explicit lane registry source** — new machine-scope setting
   `commandCentral.laneRegistry.files` (default `[]`, never auto-detected).
   Operator-provided paths in launcher `tasks.json` schema. Resolved
   independently of the legacy quarantine via the new
   `resolveTaskRegistrySources()` (each source carries an ingest mode).
2. **Record-level quarantine instead of file-level** — lane registry
   sources ingest with `lane-records-only`: only records carrying a Work
   Registry `project_ref.id` (`isRegistryBackedLaneTask`) are admitted;
   launcher-era rows in the same file stay hidden and the quarantined count
   is logged. `TASKS_FILE` (hermetic fixtures) and legacy-opt-in sources
   keep full `all` ingest; a path resolved through both channels keeps the
   wider `all` ingest.
3. **Grouping prefers `project_ref.id`** — identity precedence is
   `project_ref.id` → launcher `project_id` → the new test-injectable
   `ProjectRefResolver` adapter (`src/utils/project-ref-resolver.ts`),
   which resolves legacy/fixture records by `canonical_project_dir`,
   `project_dir`, `execution_dir`, `exec_cwd`, or repo origin. Default is a
   null resolver (no sync CLI calls in render paths; a CLI/oc-project-backed
   adapter must precompute/cache outside the tree render path).
   Dirs claimed by identity lanes (project_dir, canonical_project_dir,
   execution_dir, exec_cwd) route worktree lanes, legacy rows, and
   discovered agents in the same checkout into one canonical group; group
   dir prefers `canonical_project_dir`.
4. **UNREGISTERED PROJECTS bucket** — records with no registry identity and
   no explicit launcher-assigned `project_name` (normalization now marks
   basename-derived names with `project_name_derived`) collapse into a
   single synthetic bucket: label `UNREGISTERED PROJECTS`, ⚠️ icon,
   `no Work Registry resolution` description, explanatory tooltip,
   `projectGroupUnregistered` contextValue, pinned after real project
   groups. Path basenames and worktree labels (`visible_project_name`)
   never name a top-level project group anymore.
5. **Quarantine preserved** — `commandCentral.legacyLauncherTasks.enabled`
   default-off behavior and the cc-003 resolver/provider/discovery guards
   are untouched; no global auto-detect was restored.

### Interpretation decisions (flag for review)

- "Unknown/unresolved → UNREGISTERED" is scoped to records with **no
  identity and no explicit launcher name**. Legacy records with an explicit
  launcher-assigned `project_name` still form a named group (the name is
  operator/launcher-provided metadata, not path-derived); collapsing them
  too would have made legacy diagnostics mode unreadable and rewritten most
  existing fixtures. The resolver adapter is the bridge for attributing
  such records to registry projects.
- Discovered-agent (process-scanner) groups still fall back to
  `basename(projectDir)` naming when no identity lane claims their dir —
  discovery is a separate, non-record surface and changing it would regress
  ad-hoc session visibility. Noted as residual work below.

## Files changed

- `package.json` — new `commandCentral.laneRegistry.files` setting.
- `src/utils/tasks-file-resolver.ts` — `TaskRegistryIngest`,
  `ResolvedTaskRegistrySource`, `resolveTaskRegistrySources()`,
  `laneRegistryFiles` option; legacy resolution semantics unchanged.
- `src/utils/project-ref-resolver.ts` — **new**: `ProjectRefResolver`
  adapter interface, `nullProjectRefResolver`,
  `createStaticProjectRefResolver` (dir + normalized repo-origin lookup).
- `src/providers/agent-status-tree-provider.ts` — `AgentTaskProjectRef` +
  `project_ref`/`lane_kind`/`canonical_project_dir`/`execution_dir`/
  `project_name_derived` on `AgentTask`; normalization of those fields;
  `isRegistryBackedLaneTask`; per-source ingest filter + quarantine log;
  `laneRegistry.files` config watcher; identity-precedence grouping with
  resolver adapter; UNREGISTERED bucket (node flag, TreeItem, sort
  pinning); `projectRefResolver` provider option.
- `test/utils/tasks-file-resolver.test.ts` — `resolveTaskRegistrySources`
  coverage (lane files resolve while legacy stays quarantined; env
  precedence; dedup/ingest precedence; `~` expansion).
- `test/integration/lane-registry-projection.test.ts` — **new** screenshot
  regression acceptance suite (temp lane registry through the real
  config → resolver → read → filter → group → render pipeline).
- `test/tree-view/agent-status-project-ref-grouping.test.ts` — **new**
  grouping unit tests via the provider harness.

## Behavior proven by tests

| Requirement | Test |
| --- | --- |
| Active LaneRef records render/count as visible lanes | `lane-registry-projection`: "active LaneRef records render instead of the empty state" (root non-empty, Symphony summary `2 standalone run attempts · 2 running`, group `Command Central`, lane_kinds visible) |
| Screenshot regression prevented | same test asserts no `Waiting for agents...` state node and no `no projected runs` when active LaneRef records are supplied; "Symphony view projects active LaneRef records as run attempts" covers the Symphony view (`codexRuns` non-empty, status `running`) |
| Stale/no-project_ref rows hidden under default settings | "lane registry holding only stale legacy rows stays empty under default settings" + quarantine-count log |
| Legacy diagnostics opt-in still works | "legacy diagnostics opt-in still ingests the full file" |
| No basename/worktree-derived project groups | "worktree lanes group under project_ref.id, never a basename or worktree label"; "unresolved records collapse under UNREGISTERED PROJECTS instead of a basename group" (incl. TreeItem warning metadata + pinned-last); tree-view "derived-name records never form a basename group" |
| project_ref preferred for grouping; resolver adapter | tree-view "project_ref.id is preferred over project_id"; "execution_dir claimed … routes legacy records"; integration "injectable resolver adapter attributes legacy records by canonical directory" |

## Verification

- `bun test test/integration/lane-registry-projection.test.ts` — 7 pass.
- `bun test test/tree-view/agent-status-project-ref-grouping.test.ts` — 5 pass.
- `bun test test/utils/tasks-file-resolver.test.ts` — 34 pass.
- `just ready` (fix → check → test) — biome/tsc/knip clean, **1997 pass /
  0 fail** (1 pre-existing skip), test partitions validated
  (`just test-validate`).

## Incident note (lane disruption)

Mid-lane, an external rc57 sync (`chore: cut command central rc57`,
`3ff311d5`) stashed this WIP (`stash@{0}: post-rc57 node command-central
project-ref WIP 2026-06-11`), fast-forwarded main `ff7b3ae1 → 3ff311d5`,
and hard-reset the tree. Work was recovered via `git stash apply stash@{0}`
(untracked files included) and re-verified; this commit therefore lands on
`3ff311d5`, not the `ff7b3ae1` recorded at launch. The stash entry was left
in place as a recovery artifact — safe to drop once this commit is
confirmed.

## Residual risks

- **Default-off live source**: per the mission constraint ("explicit
  operator-provided … must not silently auto-detect stale global state"),
  `laneRegistry.files` defaults empty, so the dogfood UI stays empty until
  the operator sets it (one-time, see next proof). If the manager wants
  zero-config recovery, the follow-up is a deliberate decision to default
  the lane source to the well-known registry path **with** the
  `lane-records-only` filter.
- A future launcher defect that stamps `project_ref` on garbage rows would
  pass the record filter; the filter trusts the launcher's registry
  resolution.
- Discovered-agent groups may still be basename-named when no identity lane
  claims their dir (see interpretation decisions).
- The resolver adapter ships null by default; legacy rows under legacy
  diagnostics group by explicit name or fall to UNREGISTERED until a
  registry-projection-backed adapter (cached `oc-project.mjs` table) is
  wired — candidate follow-up lane.
- No live/VSIX proof was run in this lane (node-guarded recipe; see below).

## Exact next live/VSIX preview proof (manager gate)

1. On the dogfood host, set (machine scope, keep
   `commandCentral.legacyLauncherTasks.enabled` **false**):
   `"commandCentral.laneRegistry.files": ["~/.config/ghostty-launcher/tasks.json"]`
2. Cut/install the preview: `just dist` →
   `code --install-extension releases/command-central-<ver>.vsix`.
3. Run `just test-installed-vsix-agent-status` on the MacBook node and
   visually confirm against the regression screenshot: active lanes with
   `project_ref` appear grouped under their registry display names, the
   Symphony surface shows non-zero run attempts, and stale launcher-era
   rows stay absent.
4. Flip `legacyLauncherTasks.enabled` on briefly to confirm diagnostics
   mode still shows legacy rows (UNREGISTERED bucket for unresolved ones),
   then back off.
