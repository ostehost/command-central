# Handoff: Symphony Dogfood Delegation Round

Date: 2026-05-10
Owner: Oste
Repo: `/Users/ostemini/projects/command-central`
Status: ready for visible launcher delegation

## Prompt For Lead Agent

ULTRATHINK. Use Claude Opus-level reasoning.

You are the lead implementation agent for the next Command Central Symphony dogfood round. Your job is to delegate the work through visible launcher lanes, review their output, and produce one cohesive, verified slice. Use the Symphony Draft v1 service spec as the product vocabulary, but preserve Command Central's boundary: Command Central is an OPTIONAL read-only `Status Surface`, not the `Orchestrator`, scheduler, tracker reader/writer, retry owner, workspace manager, or lifecycle controller.

Work from `/Users/ostemini/projects/command-central`. Do not push, tag, publish, create GitHub releases, modify external trackers, or use `--no-verify`.

## Goal

Dogfood the Symphony integration by making a real delegated OpenClaw/Launcher workstream visible and understandable in Agent Status.

The MVP should prove that an operator can answer:

- What Symphony-shaped workstream is active?
- Which delegated `Run Attempt` rows belong to it?
- Which rows are `Running`, `RetryQueued`, or `Released` from source-owned evidence?
- What is the current `Orchestrator Runtime State` snapshot summary?
- Where are the workspace, session, handoff, pending-review, test, and provenance receipts?
- What action is next, without Command Central owning the action?

## Product Decision

Keep `Symphony` as a first-class top-level root inside `Agent Status`.

Do not create a separate VS Code Activity Bar container or a sibling view beside Agent Status in this round. The official spec says the human-readable status surface is optional and implementation-defined, and if present it should be driven by orchestrator state/metrics only and must not be required for correctness. Command Central is that status surface.

## Delegation Requirement

This round must dogfood delegation.

The lead agent should launch at least two visible child lanes through launcher tooling:

- Implementation worker: owns the narrow code change.
- Review/proof worker: read-only until the implementation worker reports completion; then validates the installed/source behavior and reports gaps.

Assign disjoint ownership. Do not let two agents edit the same file at the same time. If the implementation proves too small for safe parallel code editing, keep the second lane read-only and focused on proof, fixture design, or gap analysis.

Use visible Ghostty/launcher lanes only. No headless subagents.

## Implementation Slice

Minimal viable slice: `Symphony` should show a delegated dogfood workstream as a readable kanban-style status surface.

Expected Agent Status shape:

- `Symphony`
- `Operations Dashboard`
- `Running Sessions`
- `Retry Queue`
- `Released`, only when source-owned evidence exists
- `Workstreams`
- `Run Attempts`

Within `Workstreams`, add or tighten grouping so delegated launcher/OpenClaw/TaskFlow rows can be read as one workstream with child run attempts. Use explicit identity fields only; do not broad-match by title text.

Within each child `Run Attempt`, surface source-owned details when present:

- issue identifier/state/url
- workspace path
- session id / thread id / turn count
- lifecycle phase, using spec terms such as `PreparingWorkspace`, `LaunchingAgentProcess`, `StreamingTurn`, `Stalled`, `CanceledByReconciliation`
- runtime and token totals
- retry attempt / due_at / error
- latest rate-limit payload
- last Codex or launcher event
- handoff, pending-review, test, commit, branch, and stream evidence paths
- provenance / field source rows

## Operations Dashboard

Tighten the dashboard summary around the spec's runtime snapshot language:

- `running`
- `retrying`
- `codex_totals.input_tokens`
- `codex_totals.output_tokens`
- `codex_totals.total_tokens`
- `codex_totals.seconds_running`
- `rate_limits`
- snapshot status: `fresh`, `timeout`, or `unavailable`

If source records do not provide a field, show that it is not provided by the lifecycle owner. Do not synthesize lifecycle truth.

## Hard Boundaries

Do not implement:

- drag/drop kanban
- retry/cancel buttons unless routed through an existing source-owned action envelope
- Linear polling inside Command Central
- tracker writes
- scheduler state
- workspace creation/cleanup
- lifecycle mutation
- filesystem crawling to invent evidence
- a custom web dashboard

If a feature needs claim, dispatch, retry, reconciliation, tracker writes, workspace hooks, or app-server launch, stop and record it as owner-layer work for OpenClaw/TaskFlow/Launcher/Symphony proper.

## Verification Gates

Run the smallest meaningful gates first, then the project gate:

- focused tree/provider tests covering the new workstream/grouping behavior
- focused observer/projection tests for any new fields or source mappings
- `bunx tsc --noEmit --pretty false`
- `git diff --check`
- `just check`
- strict `just ci` before committing if the slice touches shared Agent Status behavior

Dogfood proof must include:

- one real visible delegated workstream launched through the launcher
- proof that Agent Status shows the top-level `Symphony` root
- proof that the delegated lanes appear under `Workstreams` and/or associated `Run Attempts`
- no boundary violations in the UI or code
- a short handoff summarizing commits, tests, live proof, and remaining owner-layer gaps

## Acceptance Criteria

Accept the round only if:

- Command Central remains a read-only Symphony `Status Surface`.
- `Symphony` stays top-level within Agent Status.
- Delegated work is visible enough that an operator can inspect status, evidence, and next action without reading raw JSON first.
- All new labels use official spec vocabulary where it exists.
- Missing `Claimed` / `Unclaimed` state is treated honestly unless a source adapter provides it.
- Tests pass and the repo is clean except for intentional committed changes.

## Sources

- Official Symphony spec: https://github.com/openai/symphony/blob/main/SPEC.md
- Existing CC spec: `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md`
- Existing CC plan: `research/PLAN-symphony-vscode-native-integration-2026-05-09.md`
