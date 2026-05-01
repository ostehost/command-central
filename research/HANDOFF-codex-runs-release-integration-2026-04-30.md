# Handoff: Codex Runs Legacy Matching Stabilization

Date: 2026-05-01
Repo: `/Users/ostehost/projects/command-central`
Status: rc17 preview cut; ready for reviewer verification

## Context

This pass completes the narrow post-rc16 stabilization for the Symphony / Codex Runs visibility
slice. It follows `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md`:

- Symphony is display vocabulary only, not a Command Central scheduler.
- Launcher joins use explicit identity: `taskId`, `runId`, or normalized session identity.
- Display labels, broad human titles, project paths, and prompt text are not join keys.
- `sourceStatus` remains raw source lifecycle truth, `status` is display grouping, and `phase`
  remains observability-stage vocabulary.
- Artifact links come only from already-fetched source fields.

## Scope Boundary

No scheduler, acquisition, lifecycle mutation, tracker writes, SQLite writes, Codex launching, retry
queues, workspace hooks, dashboard work, or legacy-row removal was added.

No legacy row-removal project was added; existing OpenClaw, TaskFlow, Background, and launcher
surfaces remain governed by Agent Status as the raw/actionable surfaces. `Symphony / Codex Runs`
remains a read-only projected visibility surface.

## Implementation

The narrow source correction is in `src/providers/agent-status-tree-provider.ts`.

- `shouldDedupOpenClawTask(task)` now dedupes only when
  `openClawTaskMatchesLauncherTask(task, launcherTask)` returns true.
- `findLauncherTaskForFlowTask(task)` now reuses a launcher only when
  `openClawTaskMatchesLauncherTask(task, launcherTask)` returns true.
- Label-only launcher id matching was removed from both paths.
- Substring session matching was removed from both paths.
- The existing helper path is reused:
  - `openClawTaskMatchesLauncherTask(owner, task)`
  - `codexRunSessionsMatch(left, right)`
  - `codexRunSessionCandidates(value)`

`CodexRunObserverService` was not changed in this pass.

## Regression Coverage

Focused provider regressions were added in `test/tree-view/openclaw-task-nodes.test.ts`:

- OpenClaw `label === launcher.id` does not dedupe or hide the OpenClaw row.
- OpenClaw `childSessionKey = "session:abc-extra"` does not match launcher `session_id = "abc"`.
- TaskFlow `label === launcher.id` remains a `taskFlowChild` placeholder.
- TaskFlow `childSessionKey = "session:abc-extra"` does not reuse launcher `session_id = "abc"`.
- Positive exact normalized session matching still dedupes OpenClaw and reuses TaskFlow launcher rows.

Older empty-tree smoke expectations were updated as test contract changes only: the always-visible
empty `Symphony / Codex Runs` root is now included alongside the waiting state.

## Verification

Focused verification:

```bash
bun test test/services/codex-run-observer-service.test.ts test/tree-view/openclaw-task-nodes.test.ts
```

Result: `31 pass`, `0 fail`, `102 expect`.

Expanded stale smoke verification:

```bash
bun test test/integration/tasks-json-startup-smoke.test.ts test/tree-view/agent-status-tree-provider.test.ts test/tree-view/agent-status-tree-provider-discovery.test.ts test/services/codex-run-observer-service.test.ts test/tree-view/openclaw-task-nodes.test.ts
```

Result: `122 pass`, `0 fail`, `395 expect`.

Typecheck and diff hygiene:

```bash
bunx tsc --noEmit --pretty false
git diff --check
```

Both passed.

Full gate:

```bash
just ready
```

Result: `1468 pass`, `1 skip`, `0 fail`, `4060 expect`.

Preview cut:

```bash
just cut-preview
```

Result: `oste.command-central@0.6.0-rc.17`.

## Release Artifact

Source stabilization commit:

```text
2ca27d776b134b7c3d8b204042c4b2bef80ad602
```

Preview paths:

- `releases/command-central-0.6.0-rc.17.vsix`
- `releases/digest-v0.6.0-rc.17.md`

Artifact identity:

```text
oste.command-central@0.6.0-rc.17
```

SHA256:

```text
6146a0bd999f6a1ae55ed61ca22880f83be5218f101135541dd5d4b0d51eedbd  releases/command-central-0.6.0-rc.17.vsix
f826b194dcc516267dfae9fa4b29480220c31e4fff51cf8528aadcf09f13c3c9  releases/digest-v0.6.0-rc.17.md
```

Prerelease gate:

```text
research/prerelease-gate/latest.json
generatedAt: 2026-05-01T14:24:03.085Z
commandCentral.sha: 2ca27d776b134b7c3d8b204042c4b2bef80ad602
success: true
```

## Unsafe Join Grep

Source grep:

```bash
git grep -n -E 'run\.title === task\.id|title===task\.id|task\.label.*launcherTask\.id|includes\(launcherTask\.session_id' -- src test || true
```

Result: no output.

Bundle grep:

```bash
unzip -p releases/command-central-0.6.0-rc.17.vsix extension/dist/extension.js | rg -n -e 'run\.title === task\.id|title===task\.id|task\.label.*launcherTask\.id|includes\(launcherTask\.session_id' || true
```

Result: no output.

## Dogfood Notes

The fixture EDH command succeeded:

```bash
just fixture-edh test/fixtures/agent-status/dogfood-live-tasks.json
```

Computer Use could attach to the regular VS Code window, but not to the fixture EDH window during
the final evidence pass. Provider-level inspection against the same fixture produced these exact
tree facts:

- Root label: `Symphony / Codex Runs · 101`
- Root description: `15 needs attention · 26 stopped · 60 completed`
- Source mix: `101` launcher-only Codex projected runs
- Status mix: `15 failed`, `26 stopped`, `60 succeeded`
- First run label: `cc-steer-contract-fix`
- First run description: `Failed · Launcher-only row · codex · 32d ago`
- First run context: `codexRun.failed`
- First run command: `null`
- Expanded detail rows include status, source status, lifecycle authority, ownership, workspace,
  run id, sources, field provenance, last event, and artifact rows.

Empty-state inspection produced:

- Root label: `Symphony / Codex Runs · 0`
- Root description: `no projected runs`
- Empty child label: `No projected Codex runs`
- Empty child description: `OpenClaw, TaskFlow, or launcher rows will appear here`

Synthetic coexistence inspection and tests confirm launcher legacy tooltips disclose Codex Runs
projection through explicit OpenClaw session joins. Exact matching may still dedupe a matched
OpenClaw row in legacy flat mode; the corrected behavior is that unrelated label-only or substring
session matches no longer trigger that hiding.

## Review Focus

Review this as a legacy matching hardening and release stabilization patch only.

Check:

- Provider matching changed only at the two legacy paths described above.
- `CodexRunObserverService` was not widened.
- Source and bundle have no unsafe title/label/substr-session join patterns.
- rc17 artifact and digest match the SHA256 values above.
- `research/prerelease-gate/latest.json` points at the stabilization commit.
- No scheduler, acquisition, dashboard, lifecycle authority, tracker/SQLite, Codex launch, retry
  queue, workspace hook, or legacy-row-removal scope slipped in.
