# Plan: Symphony VS Code Native Integration

Date: 2026-05-09
Owner: Oste
Status: implementation plan after Draft v1 spec review

## Decision

Command Central should implement Symphony as a VS Code-native status surface and operator control router, not as the Symphony scheduler/runner.

The Symphony Service Specification defines the full service as tracker reader, scheduler/runner, workspace manager, agent runner, logging, and optional status surface. In this system, OpenClaw, TaskFlow, and Ghostty Launcher already own the scheduling and execution responsibilities. Command Central should therefore map those owner records into the Symphony observability language:

- `Issue` -> future tracker/TaskFlow work item metadata when available.
- `Run Attempt` -> projected `CodexRunView` / future renamed `SymphonyRunAttemptView`.
- `Live Session` -> launcher/OpenClaw session metadata.
- `Retry Entry` -> TaskFlow/OpenClaw retry or fixup state when source records expose it.
- `Status Surface` -> VS Code Activity Bar tree, details, context menus, status bar, and optional webview.

Hard boundary: Command Central MUST NOT claim, dispatch, retry, reconcile, or mutate lifecycle state directly. Any mutation-capable action must route through a source-owned action envelope to OpenClaw, TaskFlow, or Launcher.

## Current Verification Against Spec

Implemented or substantially aligned:

- Run attempt phases preserve the Symphony lifecycle vocabulary: `PreparingWorkspace`, `BuildingPrompt`, `LaunchingAgentProcess`, `InitializingSession`, `StreamingTurn`, `Finishing`, `Succeeded`, `Failed`, `TimedOut`, `Stalled`, `CanceledByReconciliation`.
- Normalized status stays separate from source status, matching the spec distinction between internal orchestration state and run-attempt phase.
- Projection preserves source provenance through `fieldSources`.
- Launcher/OpenClaw/TaskFlow identity joins avoid broad title/path matching.
- The VS Code surface now labels the root as `Symphony / Run Attempts`.
- Detail rows now use spec-aligned terms: `Owner status`, `Lifecycle owner`, `Projection boundary`, `Run attempt ID`, and `Provenance from ...`.
- Source-owned action envelopes exist and do not write owner state files directly.
- The TaskFlow conductor root now reads as `Symphony / Workstreams`.
- Elixir-style tree snapshot fixtures now cover idle run attempts, active joined source-owned/launcher metadata, and a workstream conductor view.

Partial or missing:

- `WorkflowRunView` and `CodexRunView` are still internal names. Product-facing UI is now aligned, but a later code rename to `SymphonyRunAttemptView` would reduce drift.
- TaskFlow grouping now has first-pass Workstreams language, but the surface still needs a composed top-level Symphony shape if we decide to merge Workstreams and Run Attempts under one parent.
- Snapshot-style metrics from the spec are not fully surfaced: retry queue, aggregate token totals, rate-limit payload, and runtime seconds need a VS Code-native detail/status presentation once source records expose them.
- Evidence rows exist for known artifact paths, but there is no grouped `Evidence` section yet.
- Dynamic `WORKFLOW.md` and Linear tracker concepts are represented only when source owners expose them. CC now projects owner-provided tracker, issue, workflow-run, and workflow-contract fields read-only; it still does not poll Linear.

Intentionally rejected for Command Central:

- Polling Linear directly.
- Creating per-issue workspaces.
- Running `codex app-server`.
- Owning retry/backoff timers.
- Implementing tracker writes.
- Restart recovery for scheduler state.

Those belong to Symphony/OpenClaw/TaskFlow/Launcher, not the VS Code extension.

## Linear Integration Decision

The upstream Symphony Draft v1 spec requires `tracker.kind: linear` for dispatch in the full long-running automation service. Command Central should not implement that adapter directly for the MVP release candidate.

Decision:

- A Linear adapter is necessary for a conforming Symphony scheduler/runner.
- It is not necessary inside the VS Code extension because CC is the optional Status Surface, not the Issue Tracker Client or Orchestrator.
- CC should render Linear when the lifecycle owner supplies normalized issue metadata (`trackerKind`, `issueIdentifier`, `issueState`, `issueUrl`) and should show when tracker metadata is not provided.
- Any future mutation-capable ticket action must route through the source owner. CC must not write Linear state or infer scheduler eligibility itself.

## Execution Placement Guardrail

MacBook/node-only computer-use validation is an execution-placement policy, not a Command Central runtime feature.

Decision:

- The Symphony runner may define a placement policy for a workstream or run attempt, including target node, workspace root, execution mode, and allowed verification commands.
- OpenClaw native node routing must enforce MacBook/node execution for VS Code installed-extension smoke tests before VS Code can launch.
- Command Central should project owner-provided placement fields (`exec_node`, `exec_host`, `exec_mode`, workspace, evidence paths) and show mismatches as status/evidence.
- Command Central must not make its extension activation dependent on host-specific user names or paths.
- Hub-side source, packaging, and review may continue when scoped to repository work. Real VS Code/computer-use proof must run on the MacBook node.

Implementation:

- `just test-electron` now has a pre-launch guard that refuses to run outside `/Users/ostehost` on the MacBook node.
- The guard belongs to release/test orchestration, not extension product code.
- A hub-side failure of the guard is a successful prevention event, not a skipped test or product failure.

Rejected anti-patterns:

- Adding host checks to extension activation.
- Faking node proof by running `@vscode/test-electron` on the hub.
- Moving Linear polling, scheduler ownership, retry/reconcile ownership, or tracker writes into Command Central to compensate for process gaps.

## Elixir Test Implementation Lessons

Reviewed upstream `openai/symphony` Elixir tests from a shallow clone in `/tmp/symphony-review-mhTLe0`.

Patterns to copy into Command Central:

- Snapshot-driven operator surfaces: `StatusDashboardSnapshotTest` uses named fixtures for idle, busy, retry/backoff pressure, credits/rate-limit variants, and escaped error text. CC should add tree snapshot fixtures for `Symphony / Run Attempts` instead of relying only on scattered assertions.
- Runtime snapshot contract: `OrchestratorStatusTest` validates live session fields, `turn_count`, token totals, app-server PID, last event, and timeout/unavailable behavior. CC should mirror this as projected run-attempt fixtures from source records.
- Safety-first workspace tests: `WorkspaceAndConfigTest` proves deterministic workspace keys, reuse without destructive reset, symlink escape rejection, hook failure/timeout behavior, and cleanup. CC does not manage workspaces, but should surface owner-provided workspace path, host, and evidence without inferring or crawling.
- App-server policy tests: `AppServerTest` proves invalid cwd rejection, sandbox pass-through, and user-input-required as a documented failure. CC should display those policy outcomes from owner records as `Owner status` / `Last event`, not decide them.
- Dynamic tool tests: `DynamicToolTest` verifies unsupported tools fail without stalling and `linear_graphql` failures preserve structured error payloads. CC should show unsupported-tool and input-required events as attention states when owner records expose them.
- Live E2E tests are opt-in and clearly skipped unless credentials are present. CC should treat MacBook/node dogfood and real tracker tests the same way: explicit profile, visible skip, no silent pass.

## VS Code Native Form Factor

Use VS Code primitives before adding a custom dashboard:

1. Activity Bar tree roots: `Symphony / Workstreams` and `Symphony / Run Attempts`.
2. First-level grouping: TaskFlow/workstream parent nodes, not decorative sections.
3. Child rows: run attempts with compact descriptions: status, projection boundary, role, runtime, recency, model.
4. Detail children: owner status, lifecycle owner, phase, workspace, host, thread/turn/session, evidence/artifacts, provenance.
5. Context menus: read/open/copy/focus first; cancel/retry/fixup only through source-owned envelopes.
6. Status bar: aggregate active/attention counts only after source truth is stable.
7. Webview: optional later for dense metrics; it must consume the same projected state and not become a second source of truth.

## Integration Plan

### Phase 1 - Language and Fixture Lock

Goal: make the VS Code UI language match the Symphony spec without renaming every internal type.

Work:

- Keep internal `CodexRunView` temporarily.
- Product-facing root: `Symphony / Run Attempts`.
- Detail labels use spec language.
- Add tree fixture snapshots for empty, active, failed, launcher-owned, TaskFlow-joined, and node-owned run attempts.
- Remove stale `WorkflowRunStatus` / `WorkflowRunPhase` compatibility aliases so strict prerelease gates stay meaningful.

Validation:

- `bun test test/tree-view/openclaw-task-nodes.test.ts test/services/codex-run-observer-service.test.ts`
- `bunx tsc --noEmit`
- `git diff --check`

### Phase 2 - Workstream / Conductor Shape

Goal: make one orchestration goal readable as one parent with child run attempts.

Work:

- Promote TaskFlow/workstream nodes adjacent to `Symphony / Run Attempts` as `Symphony / Workstreams`.
- Show progress counts, active/attention/complete rollup, and degraded states.
- Suppress duplicates only when explicit identity joins prove the child is already represented.
- Keep raw Agent Status sections available for debugging.

Validation:

- Flow parent renders matched children.
- Unmatched children render as placeholders.
- Flow status does not override child run-attempt lifecycle.
- Missing TaskFlow service shows a degraded state instead of breaking Agent Status.

### Phase 3 - Evidence and Monitoring

Goal: use the surface to monitor launched agents and make next-feature work testable.

Work:

- Add grouped `Evidence` details for owner-provided prompt, stream, handoff, pending-review, test summary, commit, and branch fields.
- Add `Retry` details when owner records expose retry attempt, due time, or error.
- Add `Runtime` details when owner records expose duration, token totals, rate limits, or turn count.
- Treat `contract_failure` as an attention state in the UI and process.

Validation:

- Fixture-backed tests for every evidence field.
- Live MacBook dogfood: one workstream, two child launcher lanes, one completion, one review/fixup decision.
- Compare CC projection to node `tasks.json`, pending-review receipts, and source test output.

### Phase 4 - Source-Owned Actions

Goal: make CC useful for iteration without becoming the scheduler.

Work:

- Add context menus for `Copy Run Attempt ID`, `Open Artifact`, `Focus Terminal`, and `Show Source JSON`.
- Add guarded `Cancel`, `Request Review`, and `Dispatch Fixup` only when the owner route is explicit.
- Render the owner route before executing mutation-capable actions.

Validation:

- Missing owner identity blocks mutation actions.
- Unsupported owner/action pairs throw.
- Mutation-capable actions produce no direct writes to `tasks.json`, pending-review, pending-fixup, or OpenClaw state files.

### Phase 5 - Dogfood Loop

Goal: use the UI itself to test and create the next features.

Work loop:

1. Create a small TaskFlow/workstream spec.
2. Launch child lanes through Ghostty Launcher on the MacBook node.
3. Monitor `Symphony / Run Attempts` in VS Code.
4. Review completions from receipts, artifacts, diff, and tests.
5. Route a fixup through a source-owned envelope or launch a new lane.
6. Capture screenshot/EDH evidence plus test output.
7. Update memory and the integration plan with anything the loop proves wrong.

Exit criteria:

- Operator can answer: what is running, what is retrying, who owns lifecycle, which workspace/host is involved, what evidence exists, and what action is safe next.
- Hub/node repo state is host-labeled and preserved before reconciliation.
- No hidden scheduler behavior is introduced in Command Central.

## Current Launched-Agent State

Node `Mike MacBook Pro` latest relevant lanes:

- `cc-symphony-dogfood-team-20260509-1229`: completed; pending review receipt exists; useful research artifact exists; commit swept up cross-lane WIP, so do not bless the commit as-is.
- `cc-node-host-context-fix-20260509-1229`: `contract_failure` despite exit code 0; receipt exists; manager already ported the deterministic host-context fix to hub separately.

Process implication:

- The next implementation lane should not start until launcher/manager commit ownership is aligned enough to prevent a writer lane from auto-committing another lane's work.
- The next UI work should be fixture-backed and hub-reviewed first, then dogfooded on the MacBook node.
