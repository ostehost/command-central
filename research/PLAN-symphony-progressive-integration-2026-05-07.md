# Plan: Progressive Symphony Integration for Command Central

Date: 2026-05-07
Owner: Oste
Status: proposed execution plan

## Decision Frame

Command Central should continue absorbing Symphony as an orchestration visibility pattern, not as a scheduler.

The invariant is:

- OpenClaw tasks, TaskFlow, and Ghostty Launcher receipts own lifecycle.
- Command Central owns projection, provenance, operator ergonomics, and source-owned action routing.
- Every phase must preserve the source-owner boundary. If a step requires Command Central to claim, dispatch, retry, reconcile, or mutate lifecycle directly, stop and write an OpenClaw/TaskFlow/Launcher spec instead.

## Current State

Already implemented or substantially present:

- `CodexRunView` and `WorkflowRunView` read model.
- `CodexRunObserverService` projection from OpenClaw tasks, TaskFlow, and launcher rows.
- `Symphony / Codex Runs` root in Agent Status.
- TaskFlow service and TaskFlow tree nodes.
- Source/provenance detail rows and lifecycle authority wording.
- Workflow run action envelope scaffolding with owner routing.

Current gap:

- The pieces exist, but the product/process path is not yet staged as a progressive conductor workflow with explicit gates, owner checks, UI evidence, and rollback rules.

## Rollout Principles

1. Ship in thin vertical slices.
2. Read-only before action.
3. Fixture-backed tests before live dogfood.
4. Live dogfood before release.
5. CC can route source-owned actions, but cannot become the owner.
6. Each phase must have a rollback path that preserves existing Agent Status behavior.

## Phase 0 - Baseline Audit and Contract Lock

Goal: freeze the authority contract before adding more UI/action surface.

Scope:

- Compare current implementation against:
  - `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md`
  - `research/SPEC-taskflow-tree-nodes-v2.md`
  - `research/ROADMAP-OPENCLAW-INTEGRATION.md`
- Add or update a short `research/REVIEW-symphony-current-state-YYYY-MM-DD.md`.
- Record implemented, partial, missing, and intentionally rejected items.

Checks and balances:

- Code check: `bun test test/services/codex-run-observer-service.test.ts test/tree-view/openclaw-task-nodes.test.ts test/commands/workflow-run-actions.test.ts`
- Type check: `bunx tsc --noEmit`
- Authority check: no new command path can mutate task/flow/launcher state.
- Oste review: verify findings against code, not changelog claims.

Exit criteria:

- Current state review exists.
- All existing Symphony/TaskFlow tests pass.
- Any missing acceptance item is classified as `required`, `deferred`, or `rejected`.

Rollback:

- Documentation-only phase. Revert review doc if incorrect.

## Phase 1 - Projection Truth Hardening

Goal: make `Symphony / Codex Runs` boringly trustworthy before expanding controls.

Scope:

- Strengthen projection tests around identity joins:
  - OpenClaw task id.
  - TaskFlow child task id.
  - child session key.
  - launcher task id.
- Add disagreement cases:
  - OpenClaw says running, launcher says stopped.
  - TaskFlow complete, child task failed.
  - launcher-only row without explicit Codex runtime.
  - duplicate labels across unrelated tasks.
- Add UI detail rows that clearly show:
  - lifecycle owner.
  - source status.
  - merged sources.
  - field source for model/workspace/artifacts.

Checks and balances:

- Unit tests must prove no broad title/path matching.
- Tree tests must prove disagreement is visible, not silently normalized away.
- Snapshot/manual review: expand one fixture-backed `Symphony / Codex Runs` tree and inspect details.
- No new commands or side effects allowed in this phase.

Exit criteria:

- Projection is deterministic under duplicate/noisy source data.
- Source-owner boundary is visible in the UI.
- No regressions in normal Agent Status rows.

Rollback:

- Feature flag or localized revert of added detail rows/tests. Existing flat Codex Runs projection remains intact.

## Phase 2 - Conductor Grouping

Goal: turn flat run projection into understandable workstream structure.

Scope:

- Promote TaskFlow/workstream parent nodes as the primary conductor shape:
  - one parent orchestration goal.
  - child runs/lanes below it.
  - progress counts and status rollup.
- Keep `Symphony / Codex Runs` as the source/projection layer.
- Avoid duplicating child lanes between top-level task sections and TaskFlow groups unless provenance requires it.
- Add empty, loading, degraded, and unavailable states for TaskFlow.

Checks and balances:

- Tests:
  - flow parent renders with matched children.
  - unmatched children render as placeholders.
  - duplicates are suppressed only when identity match is explicit.
  - flow status does not override child lifecycle status.
- Live fixture smoke in Extension Development Host.
- Visual review requires a verified local URL or EDH/screenshot artifact before asking Mike to approve visual behavior.

Exit criteria:

- A multi-lane workflow is understandable from the tree without opening raw JSON.
- Disconnected/missing TaskFlow does not break Agent Status.
- Existing process/session/launcher discovery remains visible.

Rollback:

- Hide TaskFlow grouping behind an internal setting while preserving `Symphony / Codex Runs`.

## Phase 3 - Evidence Layer

Goal: add enough evidence to make review decisions from CC without making CC a crawler.

Scope:

- Surface already-known evidence only:
  - handoff file.
  - prompt file.
  - stream file.
  - pending review path.
  - test summary fields if present in source records.
  - commit/branch metadata if present.
- Add detail rows or child sections:
  - `Evidence`.
  - `Artifacts`.
  - `Review state`.
  - `Fixup state`.
- Do not crawl workspaces or parse Codex logs in this phase.

Checks and balances:

- Tests prove artifact paths only come from existing source fields.
- UI shows missing evidence as missing, not inferred.
- Oste review compares evidence rows to raw source records.

Exit criteria:

- A completed run can show what should be reviewed and where the artifact lives.
- No filesystem discovery, log parsing, or shadow evidence store was added.

Rollback:

- Remove evidence child rows. Projection model remains valid.

## Phase 4 - Source-Owned Actions

Goal: let CC route operator intent to the real owner without becoming the owner.

Scope:

- Expand action envelopes around already-supported actions:
  - `showDetail`.
  - `focusTerminal`.
  - `copy id`.
  - `open artifact`.
- Add guarded actions only when owner API is available:
  - OpenClaw/TaskFlow `cancel`.
  - launcher `requestReview`.
  - launcher/OpenClaw `dispatchFixup`.
- Every action must produce an envelope containing:
  - `sourceRef`.
  - `ownerKind`.
  - `runId`.
  - task/flow/session identity when present.

Checks and balances:

- Tests prove unsupported owner/action pairs throw.
- Tests prove missing owner identity blocks mutation-capable actions.
- Manual smoke must show the exact source command or owner route before execution.
- Tier classification:
  - read/copy/open/focus: Tier 0.
  - cancel/retry/fixup on local internal tasks: Tier 1, Oste reviews.
  - anything external/public/billing: Tier 2, Mike approves.

Exit criteria:

- CC can route source-owned actions without writing lifecycle state itself.
- Failed actions are visible and do not corrupt task state.

Rollback:

- Disable mutation-capable context menu items first.
- Keep read-only detail actions.

## Phase 5 - Process Integration and Dogfood Loop

Goal: make Symphony/TaskFlow the normal way Oste and Mike inspect orchestrated work.

Scope:

- Update process docs and memory with the adopted loop:
  - plan/spec in Oste.
  - TaskFlow/workstream parent visible in CC.
  - child launcher lanes visible under the parent.
  - completion event wakes Oste.
  - Oste reviews evidence in CC plus git/tests.
  - next action routes through source-owned envelope or new launcher lane.
- Add one real dogfood run:
  - one TaskFlow/workstream.
  - two child lanes.
  - one completion.
  - one review/fixup decision.
- Capture receipts:
  - test output.
  - screenshot/EDH artifact.
  - git status/diff.
  - daily memory note.

Checks and balances:

- Oste review after dogfood run.
- Mike review only if a visual/product behavior approval is needed, and only with a verified clickable local URL or screenshot artifact.
- No release/tag/publish without explicit Tier 2 approval.

Exit criteria:

- The process works once end-to-end on real data.
- CC reflects the same truth as OpenClaw/TaskFlow/Launcher.
- The operator can answer: what is running, who owns it, what evidence exists, and what action is safe next?

Rollback:

- Preserve code but mark feature as internal/dogfood-only.
- Fall back to existing Agent Status task rows for operator workflow.

## Phase 6 - Release Readiness

Goal: graduate from dogfood-only to internal preview/release candidate.

Scope:

- Stabilize labels, empty states, degraded states, and context menu wording.
- Update changelog and docs.
- Run full release gates.
- Cut internal preview only after tests and visual smoke pass.

Checks and balances:

- Required gates:
  - `just check`
  - full test suite or documented targeted suite plus reason.
  - `bunx tsc --noEmit`
  - `git diff --check`
  - fixture-backed EDH or live UI screenshot.
- Partner review requires a verified URL/screenshot artifact.
- Marketplace release/tag remains Tier 2.

Exit criteria:

- Internal preview artifact exists.
- Review notes identify no scheduler/lifecycle ownership regression.
- Mike can inspect the UI and understand the workstream shape quickly.

Rollback:

- Do not publish.
- Revert release bump if needed before commit.
- Keep dogfood branch/state local until fixed.

## Phase Ownership

| Phase | Primary Owner | Reviewer | Mike Needed? |
| --- | --- | --- | --- |
| 0 Baseline audit | Oste | Oste | No |
| 1 Projection truth | Developer lane | Oste | No |
| 2 Conductor grouping | Developer lane | Oste | Only for visual approval |
| 3 Evidence layer | Developer lane | Oste | No |
| 4 Source-owned actions | Developer lane | Oste | Maybe, if action is destructive/external |
| 5 Dogfood loop | Oste + developer lane | Oste | Maybe, for product direction |
| 6 Release readiness | Oste | Mike for Tier 2 release | Yes for publish/tag |

## Stop Conditions

Stop and re-spec if any phase requires:

- Command Central to claim or dispatch work.
- Command Central to retry/reconcile lifecycle directly.
- Command Central to write OpenClaw task state, TaskFlow state, launcher task state, or workspace hooks.
- Joining records by broad display title, prompt text, or workspace path alone.
- Hiding disagreement between lifecycle sources.
- Shipping visual review without a verified UI artifact.

## Recommended Immediate Next Step

Run Phase 0 now.

Concrete task:

1. Write `research/REVIEW-symphony-current-state-2026-05-07.md`.
2. Compare current code to the two specs.
3. Run the focused Symphony/TaskFlow test set and typecheck.
4. Produce a short gap list that can feed Phase 1 implementation.

This gives the next developer lane a bounded, reviewable target instead of letting Symphony sprawl into another orchestration framework.
