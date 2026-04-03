# SPEC — TaskFlow Tree Nodes in Agent Status

Date: 2026-04-03
Status: implementation-ready
Owner: Oste

## Goal
Add OpenClaw-native workstream/group nodes to the Agent Status sidebar using TaskFlow as the grouping substrate.

Example UI:
- `ws-auth-refactor (2/3 complete)`
  - backend-codex
  - tests-claude
  - audit-gemini

This is the Command Central version of agent-deck groups, but built on OpenClaw TaskFlow instead of tmux session grouping.

## Why
Current sidebar is task-first. It shows individual agents well, but it does not expose the higher-level job/workstream shape.
TaskFlow lets CC become the conductor UI:
- one parent workstream
- many child agents/tasks
- clear progress
- one place to inspect, cancel, and understand the orchestration state

## Non-Goals
- No web UI in this phase
- No edit/create TaskFlow from CC yet
- No cross-session messaging controls yet
- No MCP management UI yet

## Data Source
Use OpenClaw TaskFlow CLI:
- `openclaw tasks flow list --json`
- optional follow-up detail command if available: `openclaw tasks flow show <id> --json`

## New Service
Create: `src/services/taskflow-service.ts`

Responsibilities:
1. Poll `openclaw tasks flow list --json`
2. Normalize raw flow objects into `TaskFlowInfo`
3. Debounce updates at 150ms (match task/cron/acp services)
4. Emit update events for tree refresh
5. Gracefully degrade when TaskFlow is unavailable or returns non-JSON

Suggested type:
```ts
export interface TaskFlowInfo {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled" | "queued";
  createdAt?: number;
  updatedAt?: number;
  completedCount: number;
  totalCount: number;
  childTaskIds: string[];
  childSessionKeys: string[];
  childLabels: string[];
}
```

## Tree Model
Add a new node type in `agent-status-tree-provider.ts`:
- `TaskFlowNode`

Shape:
```ts
interface TaskFlowNode {
  type: "taskflow";
  flowId: string;
  label: string;
  status: TaskFlowInfo["status"];
  completedCount: number;
  totalCount: number;
  childTaskIds: string[];
}
```

## Rendering
Add a top-level section or interleave with existing Agent Status groups.
Recommended initial rendering:
- show TaskFlows above individual agents
- each flow is collapsible
- label: `name (2/3 complete)`
- description: `TaskFlow · running`
- icon/color based on flow status

Children:
- child tasks rendered using existing agent/task nodes when matched
- unmatched child IDs render as lightweight placeholder nodes:
  - `task-id · queued`
  - `task-id · completed`

## Matching Logic
TaskFlow children should attach to existing visible nodes using this priority:
1. ACP taskId
2. launcher task id
3. session key
4. label/title fallback

If a child maps to an existing task node, reuse that node under the flow.
If the same task is shown under a TaskFlow, suppress duplicate top-level rendering for that task.

## Source Priority / Dedup
TaskFlow is a grouping layer, not a lifecycle source.
Lifecycle remains:
- ACP
- launcher tasks.json
- process/session inference

TaskFlow should annotate/group tasks, not override task status.

## Provider Changes
Modify:
- `src/providers/agent-status-tree-provider.ts`
- likely `src/extension.ts` for service wiring
- any tree node type definitions colocated with provider

Required changes:
1. inject `TaskFlowService`
2. fetch visible flows during reload
3. build flow nodes first
4. map child tasks to existing visible task nodes
5. suppress duplicated top-level children already shown inside a flow

## Commands / Actions (phase 1)
Expose minimal actions:
- Refresh flows
- Copy flow id
- View flow JSON/details

Phase 2 actions:
- Cancel flow
- Open child tasks
- Retry failed children

## Validation
Tests to add:
1. `test/services/taskflow-service.test.ts`
   - parses CLI JSON
   - handles missing/invalid CLI
   - emits updates only on change
2. tree/provider tests
   - renders `ws-auth-refactor (2/3 complete)`
   - attaches child tasks under flow
   - suppresses duplicate top-level child nodes
   - handles unmatched child tasks with placeholder nodes
   - preserves normal non-flow tasks

Manual validation:
1. create a real TaskFlow in OpenClaw
2. open CC sidebar
3. confirm flow node appears within one poll cycle
4. confirm progress counts and child nodes match CLI output
5. confirm no duplicate top-level child task entries

## Risks / Edge Cases
1. CLI availability mismatch across OpenClaw versions
2. flows with children not currently visible in ACP/tasks.json
3. cancelled/partial flows where child tasks outlive parent status
4. duplicate labels across unrelated tasks
5. large flows causing sidebar noise

## Rollout Plan
1. ship service + rendering + placeholder children
2. validate on one real TaskFlow
3. add cancel/details actions
4. later extend to web/control UI mirror

## Strategic Fit
This is the path from "task list" to "conductor UI":
- agent-deck groups → CC TaskFlow groups
- dmux parallel workstreams → CC workstream nodes
- OpenClaw-native durability → ledger-backed orchestration state

SPEC COMPLETE
