# Plan: Symphony Conductor Slice for Next Command Central Prerelease

Date: 2026-05-09
Status: manager-reviewed implementation plan
Target: next internal preview RC, not full release

## Decision

The next best Symphony integration is **Conductor Grouping + Evidence Preview**:

- keep `Symphony / Run Attempts` as the normalized read-model layer
- make TaskFlow/workstream parents the operator-facing conductor shape
- surface already-known review evidence under each run
- preserve OpenClaw, TaskFlow, and Launcher as lifecycle owners

This is the smallest feature set that makes the prerelease feel meaningfully more like Symphony
without turning Command Central into a scheduler.

## Why This Slice

The current flat run projection is useful but still reads like a task list. The Symphony spec is
about orchestrated work: parent goal, run attempts, lifecycle owner, retry/review state, workspace,
and evidence. Command Central already has the raw pieces:

- `TaskFlowService`
- TaskFlow tree nodes
- `CodexRunObserverService`
- `WorkflowRunView` / `CodexRunView`
- source-owned action envelopes
- launcher artifacts such as prompt, stream, handoff, and pending-review paths

The next prerelease should connect those pieces into one inspectable workstream surface.

## Feature Set

### 1. Rename And Stabilize The Symphony Surface

Current UI language should settle on:

- root: `Symphony`
- child section: `Run Attempts`
- TaskFlow/workstream parent rows: `Workstreams`

Avoid `Codex Runs` as the primary user-facing phrase. Codex remains an implementation/runtime detail
inside a broader Symphony run-attempt model.

Acceptance:

- Tree labels, tooltips, and detail rows consistently use `Run Attempts`, `Lifecycle Owner`, and
  `Projection Boundary`.
- Tests no longer assert stale `Codex Runs` wording except where compatibility names remain in
  TypeScript APIs.

### 2. Workstream / TaskFlow Conductor Rows

Promote TaskFlow groups from a secondary section into the primary conductor shape:

```text
Symphony
  Workstreams
    cc-symphony-dogfood-team-20260509-1229 · completed · 4 lanes
      planner / lead
      tester
      writer
      reviewer
  Run Attempts
    launcher-owned run attempts not attached to a workstream
```

Acceptance:

- Flow parent rows show label, status, progress count, failed count, and freshness.
- Flow child rows reuse matched OpenClaw/launcher/run-attempt nodes by explicit identity only.
- Unmatched children render as placeholders with enough identity to debug.
- Duplicate top-level run-attempt rows are suppressed only when a strong identity match exists.
- Missing TaskFlow CLI or malformed output degrades to an unavailable/empty state, not a broken tree.

### 3. Evidence Preview Rows

Add an evidence section under run attempts and workstream children, using only source-owned fields
already present in records.

Candidate fields:

- `prompt_file`
- `stream_file`
- `handoff_file`
- `pending_review_path`
- `start_commit`
- `end_commit`
- `branch`
- `reviewState`
- `fixupState`
- `model`
- `exec_mode`
- `exec_node`

Acceptance:

- Evidence rows are explicit about source provenance.
- Missing evidence is shown as missing, not inferred.
- No directory crawling or Codex log parsing is added in this slice.
- Opening an evidence path is a read/open action only.

### 4. Source-Owned Read Actions

Add only non-mutating action envelopes for the prerelease:

- copy run/workstream id
- focus terminal
- open prompt / stream / handoff / pending-review file
- show raw source details

Defer mutation actions:

- cancel
- retry
- dispatch fixup
- mark reviewed
- write tracker state

Acceptance:

- Every action envelope includes `sourceRef`, `ownerKind`, `runId`, and specific task/flow/session
  identity when available.
- Unsupported owner/action pairs fail visibly and safely.
- No new lifecycle writes happen from Command Central.

### 5. Release Gate Fix

Before cutting the next preview RC, fix the current prerelease gate mismatch:

- remove/use `WorkflowRunStatus` and `WorkflowRunPhase`
- do not weaken `just ci` / Knip config just to hide dead exported aliases

Acceptance:

- `just prerelease-gate` passes from the hub.
- The gate artifact records Command Central and Ghostty Launcher SHAs.

Manager review update, 2026-05-09:

- Removed the unused compatibility aliases from `src/types/codex-run-types.ts`.
- Keep Knip strict for prerelease; stale compatibility exports should be real cleanup, not ignored warnings.

## Non-Goals

- No scheduler.
- No issue tracker reader/writer.
- No retry or reconciliation loop.
- No workspace hook execution.
- No persistent Symphony database.
- No mutation-capable TaskFlow/OpenClaw actions in this prerelease.
- No full public/stable release claim.

## Implementation Order

1. **Planning and audit**
   - update current-state review against the Symphony and TaskFlow specs
   - classify existing dirty/agent-produced changes before editing

2. **UI vocabulary cleanup**
   - complete the `Codex Runs` -> `Run Attempts` user-facing rename
   - keep API/type aliases only where useful for compatibility

3. **Conductor grouping**
   - add a `Symphony` root container if needed
   - move/compose TaskFlow groups and unattached run attempts under it
   - add rollup/freshness/status descriptions

4. **Evidence preview**
   - extend run-attempt child detail rows with source-owned evidence fields
   - add commands for read/open/copy only

5. **Tests**
   - projection truth tests for duplicate labels and conflicting owner statuses
   - tree tests for workstream grouping, child matching, placeholder children, and duplicate
     suppression
   - command tests for read-only action envelopes

6. **Dogfood**
   - run one real TaskFlow/team-style dogfood job
   - verify it appears as one workstream with child run attempts
   - verify evidence rows point to real files
   - use MacBook node real VS Code Electron harness as release smoke

## Validation Matrix

Required before preview RC:

- `bun test test/services/codex-run-observer-service.test.ts`
- `bun test test/services/taskflow-service.test.ts`
- `bun test test/tree-view/openclaw-task-nodes.test.ts`
- `bun test test/commands/workflow-run-actions.test.ts`
- `bunx tsc --noEmit`
- `just check`
- `just test`
- `just prerelease-gate`
- MacBook node: `bun test/integration/runTest.ts`

## Preview RC Definition Of Done

- Hub and MacBook node are aligned to one reviewed release source.
- `just prerelease-gate` passes.
- Node real VS Code harness passes.
- One real dogfood workstream is visible as Symphony conductor data.
- Evidence rows let Oste identify what to review without opening raw task JSON first.
- No new lifecycle authority moved into Command Central.

## Open Questions

- Should `Symphony` be a top-level Agent Status section, or should it replace separate Workstreams
  and Run Attempts root sections entirely? Current preview keeps two VS Code-native roots:
  `Symphony / Workstreams` and `Symphony / Run Attempts`.
- Should completed workstreams be capped separately from completed run attempts?
- Should Team roles use a fixed role vocabulary or display arbitrary launcher role strings?
- Should prerelease notes call this `Symphony conductor preview` or keep it internal/dogfood-only?
