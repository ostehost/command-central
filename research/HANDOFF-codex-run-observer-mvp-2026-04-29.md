# Handoff: Codex Run Observer MVP

Date: 2026-04-29
Repo: `/Users/ostemini/projects/command-central`
Status: ready for implementation

Primary spec:

- `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md`

## Objective

Implement the first, deliberately boring slice of the Codex/Symphony visibility work:

- One read model: `CodexRunView`.
- One pure projection service: `CodexRunObserverService`.
- One visible surface: a root-level `Codex Runs` container in Agent Status.

This MVP makes native OpenClaw/Codex work visible in Command Central without moving lifecycle
authority into Command Central.

## Hard Boundary

Command Central is the operator UI, not the scheduler.

For every work item displayed by this MVP, lifecycle authority must remain singular. When an
OpenClaw task or TaskFlow row exists, OpenClaw remains the lifecycle authority. Command Central may
project, group, and display that work, but it must not create a second source of truth for claim,
retry, stall, handoff, cancellation, or reconciliation state.

Operator actions are allowed only when routed through existing owner APIs outside the observer. The
observer itself stays read-only.

Do not add:

- scheduler behavior
- retry queues
- claim state
- stall timers
- local reconciliation
- tracker writes
- SQLite writes
- Codex launches
- workspace hooks
- Codex app-server client
- JSONL crawler/parser
- dashboard surface
- evidence packet view

The observer must not shell out, watch files, call OpenClaw commands, mutate state, or render VS
Code tree items. It should accept already-fetched source arrays and project them into
`CodexRunView[]`.

## Build

Add:

- `src/types/codex-run-types.ts`
- `src/services/codex-run-observer-service.ts`
- `test/services/codex-run-observer-service.test.ts`

Wire:

- `src/extension.ts`
- `src/providers/agent-status-tree-provider.ts`

Use existing source owners:

- `src/services/openclaw-task-service.ts` owns `OpenClawTaskService.getTasks()`.
- `src/services/taskflow-service.ts` owns `TaskFlowService.getFlows()`.
- Existing Agent Status discovery owns launcher `AgentTask` records.

The live code already exports:

- `OpenClawTask` from `src/types/openclaw-task-types.ts`
- `TaskFlow` from `src/types/taskflow-types.ts`
- `AgentTask` from `src/providers/agent-status-tree-provider.ts`

Use `import type` when importing `AgentTask` into the observer to avoid a runtime provider-service
cycle.

## Service API Shape

Prefer a deterministic projection API:

```ts
project(inputs: CodexRunObserverInputs): CodexRunView[]
```

`CodexRunObserverInputs` should carry already-fetched arrays:

```ts
interface CodexRunObserverInputs {
	agentTasks: AgentTask[];
	openClawTasks: OpenClawTask[];
	taskFlows: TaskFlow[];
}
```

Optional cached wrappers such as `setInputs(...)`, `getRuns()`, or `onDidChangeRuns` are fine only
if they recompute from caller-supplied data.

Avoid a `refresh()` method unless it clearly means "recompute projection from current
caller-supplied inputs," not fetch from OpenClaw, the filesystem, SQLite, or Codex logs.

## Type Contract

Use source references, not bare source strings:

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
```

`CodexRunView` must include:

- `runId`
- `title`
- `source: CodexRunSourceRef`
- `mergedFrom: CodexRunSourceRef[]`
- `sourceStatus?: string`
- normalized display `status`
- optional `phase`
- optional `runtime` as a display/runtime classification, not lifecycle authority
- task/flow/session/thread/turn ids where available
- workspace/model/activity fields where available
- `artifactPaths?: string[]`
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

Normalized `status` should be display-safe:

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

Do not use `preparing` as a normalized status. Stage language such as `PreparingWorkspace` belongs
in `phase`.

## Projection Rules

OpenClaw task projection:

- Every relevant `OpenClawTask` can become a `CodexRunView`.
- Preserve raw `OpenClawTask.status` in `sourceStatus`.
- Normalize status only for display grouping.
- Raw source lifecycle must remain available through `sourceStatus`, `source`, `mergedFrom`, and
  `fieldSources`.
- `source` should include `{ kind: "openclaw-task", id: task.taskId }`.

TaskFlow join:

- TaskFlow child data can enrich an existing run.
- TaskFlow must not override a joined child task's lifecycle status.
- A standalone flow may produce a flow-level run view only when there is no child task record to
  represent that work item.
- Add `{ kind: "taskflow", id: flow.flowId }` to `mergedFrom` when joined.

Launcher join:

- Join launcher metadata when matching by `taskId`, `label`, `childSessionKey`, session id, or
  stable path-like fields already available in memory.
- Launcher can enrich title, workspace, model, prompt/handoff/artifact fields.
- Launcher does not become lifecycle authority when an OpenClaw task row exists.

Artifacts:

- MVP artifact links only come from already-fetched source fields such as `stream_file`,
  `prompt_file`, `handoff_file`, or OpenClaw-provided metadata.
- Do not crawl the filesystem for artifacts.

Ordering:

- Projection must be deterministic.
- Prefer active/running work first, then most recent activity, then stable `runId` lexical ordering.

## Tree Surface

Add Agent Status nodes:

- `CodexRunsContainerNode`
- `CodexRunNode`

Render one root-level `Codex Runs` group.

Each run should expand into detail rows for:

- `Model`
- `Phase`
- `Current/last tool`
- `Workspace`
- `Thread`
- `Turn`
- `Run ID`
- `Source`
- `Last event`
- artifact links, only when already available

The tree provider renders from `CodexRunView[]`. The observer service does not render VS Code tree
items.

No dashboard work in this slice.

## Tests

Start with projection tests:

- OpenClaw task becomes a `CodexRunView` with `sourceStatus` and normalized `status`.
- TaskFlow child fields attach to an existing run but do not override lifecycle status.
- Launcher task metadata joins through `taskId`, `label`, `childSessionKey`, session id, or stable
  path-like fields.
- `fieldSources` identify where title, status, last activity, model, task id, flow id, and session
  id came from.
- `source` and `mergedFrom` contain `{ kind, id?, path? }` source refs, not bare strings.
- Artifact links come only from already-fetched source fields.
- Projection is deterministic: the same inputs produce the same ordered run list.
- Observer boundary stays pure: no shelling out, file watching, filesystem crawling, OpenClaw
  command calls, Codex launches, or lifecycle mutations.

Then add a small tree test:

- `Codex Runs` container appears and expands to detail rows.

Do not start with JSONL parser fixtures. Those are next-slice work after the projection model is
stable.

## Acceptance

Done means:

- Existing tests pass for touched areas.
- New service tests cover the projection/join rules.
- Agent Status shows a root-level `Codex Runs` group.
- No execution behavior changed.
- No new scheduler-like behavior exists in Command Central.
- Worktree changes stay scoped to the files above.

## Suggested Implementation Order

1. Add `src/types/codex-run-types.ts`.
2. Add pure projection helpers and `CodexRunObserverService.project(...)`.
3. Add projection tests before UI wiring.
4. Wire `CodexRunObserverService` near OpenClaw and TaskFlow construction in `src/extension.ts`.
5. Add `Codex Runs` nodes in `src/providers/agent-status-tree-provider.ts`.
6. Add the small tree rendering test.
7. Run `just test` for touched areas, or `just test-unit` first if iterating.

## Worktree Note

At handoff recreation time, the repo had a clean status before these docs were added. If `.agents/`
or `AGENTS.md` appear untracked in another checkout, treat them as unrelated unless explicitly
asked.

`stash@{0}` on this hub currently contains an older untracked copy of these docs plus unrelated
pre-release local process files (`.agents/skills/cut-preview/SKILL.md` and `AGENTS.md`). Use the
live working-tree docs as the refined handoff unless Mike explicitly asks to recover the stashed
versions.
