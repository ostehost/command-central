# Spec: Codex/Symphony Visibility Layer for Command Central

Date: 2026-04-29
Status: MVP implementation spec
Repo: `/Users/ostemini/projects/command-central`

## Decision

Command Central should not port Symphony as a scheduler.

Use Symphony as vocabulary and shape for operator visibility, not as lifecycle authority. Command
Central remains a read-first VS Code surface that projects already-known OpenClaw, TaskFlow, and
launcher data into one operator-facing Codex run view.

Exactly one runtime owner must control lifecycle for any given work item. For the MVP, when an
OpenClaw task or TaskFlow row exists, OpenClaw remains authoritative for claim, retry, stall,
handoff, cancellation, reconciliation, and terminal state. Command Central may display that state
with normalized labels, but must not create another lifecycle ledger.

## Authority Boundary

Command Central may:

- Project already-fetched task, flow, and launcher records into `CodexRunView`.
- Normalize status labels for display while preserving raw source status.
- Group related source records with auditable provenance.
- Render one tree/detail surface for operator inspection.
- Link to artifacts already present in source records.

Command Central must not:

- Claim or dispatch work.
- Retry, continue, or reconcile work.
- Stop, cancel, or mutate task lifecycle from the observer.
- Launch Codex, OpenClaw, or any scheduler from the observer.
- Write tracker state, SQLite rows, OpenClaw task state, or workspace hooks.
- Crawl the filesystem or parse Codex JSONL logs in the MVP.
- Build the dashboard or evidence packet in the MVP.

If implementation starts needing a retry loop, task claim, Codex launch, tracker write, SQLite
write, workspace hook, or file crawler, stop. That belongs in OpenClaw or a dedicated scheduler spec,
not this Command Central MVP.

## Four-Layer View

The long-term UI should preserve these layers:

1. Work layer: issue/task/flow, claim state, retry/stall/handoff.
2. Agent layer: Codex thread/turn, phase, last event, current tool.
3. Workspace layer: path, host, branch, dirty state, artifacts.
4. Evidence layer: tests, diff, final answer, handoff/PR links.

The MVP implements the first reliable read model and tree surface. It may show fields from these
layers only when already present in source records. Evidence packet and artifact discovery are later
work.

## MVP Components

Build exactly this first slice:

- `CodexRunView` in `src/types/codex-run-types.ts`
- `CodexRunObserverService` in `src/services/codex-run-observer-service.ts`
- projection tests in `test/services/codex-run-observer-service.test.ts`
- a root-level `Codex Runs` container in `AgentStatusTreeProvider`

The observer is a pure adapter over caller-supplied data:

- `AgentTask[]`
- `OpenClawTask[]`
- `TaskFlow[]`

It must not shell out, watch files, mutate state, render VS Code tree items, or call OpenClaw
commands. Existing owner services keep source acquisition:

- `OpenClawTaskService.getTasks()` owns OpenClaw task data.
- `TaskFlowService.getFlows()` owns TaskFlow data.
- Existing Agent Status discovery owns launcher `AgentTask` data.

## Read Model

Use structured source references:

```ts
export type CodexRunSourceKind =
	| "openclaw-task"
	| "taskflow"
	| "launcher"
	| "codex-harness"
	| "trajectory"
	| "process";

export interface CodexRunSourceRef {
	kind: CodexRunSourceKind;
	id?: string;
	path?: string;
}

export type CodexRunStatus =
	| "queued"
	| "running"
	| "waiting"
	| "blocked"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "lost"
	| "stopped"
	| "unknown";

export type CodexRunPhase =
	| "PreparingWorkspace"
	| "BuildingPrompt"
	| "LaunchingAgent"
	| "LaunchingAgentProcess"
	| "InitializingSession"
	| "StreamingTurn"
	| "Finishing"
	| "Succeeded"
	| "Failed"
	| "TimedOut"
	| "Stalled"
	| "CanceledByReconciliation";
```

`LaunchingAgent` is retained for the local MVP vocabulary. `LaunchingAgentProcess`, terminal phase
names, `Stalled`, and `CanceledByReconciliation` preserve the official Symphony run-attempt
lifecycle vocabulary. Phase values are observability labels; normalized `status` remains the
display-safe grouping field.

`CodexRunView` should include:

- `runId: string`
- `title: string`
- `source: CodexRunSourceRef`
- `mergedFrom: CodexRunSourceRef[]`
- `sourceStatus?: string`
- `status: CodexRunStatus`
- `phase?: CodexRunPhase`
- optional `runtime` as a display/runtime classification, not lifecycle authority
- optional `taskId`, `flowId`, `sessionKey`, `threadId`, `turnId`
- optional `workspacePath`, `host`, `branch`, `model`
- optional `currentTool`, `lastEvent`, `lastEventAt`, `startedAt`, `endedAt`
- optional `artifactPaths`
- `fieldSources: Partial<Record<keyof CodexRunView, CodexRunSourceRef[]>>`

For MVP, populate `fieldSources` at least for fields that can be synthesized or joined:

- `runId`
- `title`
- `sourceStatus`
- `status`
- `lastEventAt`
- `startedAt`
- `endedAt`
- `model`
- `taskId`
- `flowId`
- `sessionKey`
- `workspacePath`
- `artifactPaths`

Normalized statuses:

- `queued`
- `running`
- `waiting`
- `blocked`
- `succeeded`
- `failed`
- `timed_out`
- `cancelled`
- `lost`
- `stopped`
- `unknown`

Do not add `preparing` as a normal status. `PreparingWorkspace` is a phase when a source provides
that stage language.

## Projection Rules

OpenClaw task projection:

- Every relevant `OpenClawTask` can become a `CodexRunView`.
- Preserve `OpenClawTask.status` in `sourceStatus`.
- Use `source = { kind: "openclaw-task", id: task.taskId }`.
- Use `task.runId`, `task.taskId`, or a stable `openclaw:<taskId>` fallback for `runId`.
- Use task label/task text for title.
- Map source timing fields directly when present.

TaskFlow join:

- Join flow child data into an existing run by `taskId`, `childSessionKey`, or `runId` when present.
- Do not join TaskFlow children by broad human labels or display titles.
- Add `{ kind: "taskflow", id: flow.flowId }` to `mergedFrom`.
- Add `flowId` and parent context.
- Do not let flow-level status override a joined child task's lifecycle status.
- A standalone flow may produce a flow-level run view only when there is no child task record to
  represent that work item.

Launcher join:

- Join launcher `AgentTask` metadata only by explicit run identity:
  - OpenClaw/TaskFlow `taskId` matching launcher `AgentTask.id`.
  - Existing `runId` matching launcher `AgentTask.id`.
  - Session identity, including `childSessionKey` / launcher `session_id` matches with the
    `session:` prefix normalized away.
- These identity joins may target existing OpenClaw/TaskFlow owner rows, but they must not target an
  existing launcher-only row.
- Session identity may join launcher metadata onto an existing owner row, but it must not collapse
  two launcher-only rows into one run. Launcher session ids such as `agent-ghostty-launcher` are not
  unique run identities by themselves.
- Do not join by project/workspace path alone.
- Do not join by broad human labels or display titles.
- Workspace/project path can enrich a run after a stronger identity match, but it is not itself a
  join key.
- Launcher data can enrich model, workspace, session, prompt, stream, and handoff artifact fields.
- Launcher data does not become lifecycle authority when an OpenClaw task exists.
- Launcher-only rows should become standalone Codex runs only when explicit launcher metadata marks
  the row as Codex, such as `agent_backend` or `cli_name`. Task ids, session ids, project names, and
  prompt text that merely contain the word `codex` are not sufficient.

Artifact handling:

- Use only source fields already present, such as `stream_file`, `prompt_file`, `handoff_file`, or
  OpenClaw-provided metadata.
- Do not crawl directories or parse Codex logs for artifact discovery in this slice.

Ordering:

- Projection must be deterministic.
- Prefer active/running work first, then most recent activity, then stable `runId` lexical ordering.

## Tree Surface

Add one root-level `Codex Runs` container to Agent Status.

Each run expands into detail rows for:

- `Model`
- `Phase`
- `Current/last tool`
- `Workspace`
- `Thread`
- `Turn`
- `Run ID`
- `Source`
- `Last event`
- artifact links when already available

The tree provider renders `CodexRunView[]`; the observer service does not render tree items.

## Tests

Start with projection tests:

- OpenClaw task projection preserves `sourceStatus` and normalizes `status`.
- TaskFlow child joins add flow context without overriding task lifecycle status.
- Launcher joins enrich model/session/workspace/artifact fields.
- Launcher joins do not use project/workspace path alone and do not use broad label/title matching.
- Launcher-only rows require explicit Codex runtime metadata.
- TaskFlow joins do not use broad human labels or display titles.
- `fieldSources` identify where synthesized fields came from.
- `source` and `mergedFrom` contain source refs, not bare strings.
- Artifact links only come from already-fetched source fields.
- Phase projection preserves official Symphony phase names separately from normalized display
  status.
- Projection is deterministic for identical inputs.
- Observer boundary stays pure: no shelling out, file watching, filesystem crawling, OpenClaw command
  calls, Codex launches, or lifecycle mutations.

Then add small tree tests proving the `Codex Runs` container appears, expands to detail rows, and
respects the Agent Status project filter.

## MVP Acceptance

Done means:

- New type file exists.
- New observer service exists and is pure.
- New projection tests cover projection, joins, provenance, and deterministic ordering.
- Agent Status shows one root-level `Codex Runs` group.
- No execution behavior changes.
- No scheduler-like behavior exists in Command Central.
