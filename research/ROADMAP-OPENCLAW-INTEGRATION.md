# Command Central × OpenClaw Native Integration Roadmap

> Created: 2026-04-01. Author: Oste (orchestrator).
> This extends ROADMAP.md milestones M3-7/8/9 and M5-6/7 with concrete implementation plans
> informed by OpenClaw v2026.3.28 + v2026.3.31 capabilities.

## Strategic Context

CC already talks to OpenClaw in two ways:
1. **OpenClawConfigService** — file-watches `~/.openclaw/openclaw.json` for model/agent config
2. **CronService** — wraps `openclaw cron list --json` + file-watches `jobs.json`

Both follow the same pattern: CLI for reads/mutations, file watcher for reactivity.

The Ghostty Launcher now emits `TASK_SPAWNED` and `TASK_COMPLETE` system events into OpenClaw (hybrid bridge, shipped 2026-04-01). OpenClaw v2026.3.31 added a SQLite-backed task ledger, blocked state detection, and task flow scaffolding. CC should consume these.

## Architecture Decision: CLI + File Watch (Not WebSocket)

**Decision: CC continues using CLI + file watch, not direct WebSocket/API.**

Rationale:
- OpenClaw's gateway WS protocol is internal and subject to change
- CLI (`openclaw tasks list --json`) is the stable contract
- File watch on `~/.openclaw/tasks/ledger.db` (or its JSON export) provides reactivity
- This matches the existing CronService and OpenClawConfigService patterns
- No API keys or auth needed — same-host CLI access

---

## Phase 1: OpenClaw Task Service (M3.5 scope — 2-3 sessions)

**Goal:** Surface OpenClaw background tasks in the CC sidebar alongside launcher tasks and discovered agents.

### New Service: `src/services/openclaw-task-service.ts`

Pattern: identical to CronService.

```typescript
interface OpenClawTask {
  taskId: string;
  runtime: "acp" | "subagent" | "cron" | "cli";
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "blocked";
  label: string;
  agentId: string;
  childSessionKey: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  deliveryStatus: string;
  notifyPolicy: string;
}
```

**Implementation:**
1. Call `openclaw tasks list --json` on startup and periodically (30s interval)
2. File-watch on task ledger directory for change detection
3. Emit `onDidChange` event for tree provider to react
4. Expose `getRunningTasks()`, `getRecentTasks(limit)`, `getTaskById(id)`
5. `cancelTask(id)` via `openclaw tasks cancel <id>`

**Tests:** Mock CLI output, test parsing, error handling, debounce.

### Tree Provider Integration

Add a new node type to `AgentStatusTreeProvider`:

```typescript
type AgentNode =
  | SummaryNode
  | TreeElement          // launcher task
  | DetailNode
  | FileChangeNode
  | DiscoveredNode       // process/session discovery
  | OpenClawTaskNode     // NEW: background task from openclaw tasks
```

**Display:** OpenClaw tasks appear in the sidebar with:
- Icon: 🦞 (OpenClaw) + status color
- Label: task label or source description
- Description: runtime type (cron/acp/subagent/cli), elapsed time
- Detail children: Agent, Session, Status, Delivery, Timing
- Context menu: Cancel (if running), Show Details

**Dedup:** When an OpenClaw task's `childSessionKey` matches a launcher task's `session_id`, hide the OpenClaw node (launcher task has richer metadata). Show OpenClaw-only tasks (cron runs, ACP spawns not from the launcher).

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/services/openclaw-task-service.ts` | CREATE | CLI wrapper + file watcher |
| `src/types/openclaw-task-types.ts` | CREATE | Interface definitions |
| `src/providers/agent-status-tree-provider.ts` | MODIFY | Add OpenClawTaskNode, merge into tree |
| `src/extension.ts` | MODIFY | Wire service, pass to provider |
| `test/services/openclaw-task-service.test.ts` | CREATE | Unit tests |
| `test/tree-view/openclaw-task-nodes.test.ts` | CREATE | Tree rendering tests |

### Success Criteria
- `openclaw tasks list` data appears in CC sidebar
- Running tasks show live status (30s refresh)
- Cron runs visible as a collapsed "Background Tasks" group
- Cancel action works from context menu
- No regression on launcher task display

---

## Phase 2: Blocked State + Notifications (M3 scope — 1-2 sessions)

**Goal:** Surface the new `blocked` status and enhance completion notifications.

### 2a: Blocked State Detection

OpenClaw v2026.3.31 marks ACP runs as `blocked` when they hit write/auth barriers. CC should:

1. Add `"blocked"` to `AgentTaskStatus` type
2. Map blocked → yellow warning icon with "Needs Approval" label
3. Show blocked reason in detail node (from `openclaw tasks show <id> --json`)
4. Dock bounce on blocked transition (same as failed)
5. Quick action: "Approve" → opens relevant approval surface

### 2b: Task Completion Notifications

Enhance the existing completion notification flow:

1. When an OpenClaw task transitions to terminal state, fire VS Code notification
2. Include task label, runtime type, and duration in the notification
3. "View Details" action → expand task in sidebar
4. Respect existing `commandCentral.notifications.enabled` toggle

### Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `src/providers/agent-status-tree-provider.ts` | MODIFY | Add `blocked` status mapping |
| `src/services/openclaw-task-service.ts` | MODIFY | Add `showTask(id)` for detail fetch |
| `src/commands/agent-quick-actions.ts` | MODIFY | Add approve action for blocked |
| `package.json` | MODIFY | Add blocked status icons |

---

## Phase 3: ACP Session Visibility (M3-7 — 2-3 sessions)

**Goal:** Show ACP-bound agents (Discord/Telegram/iMessage) alongside local agents.

### What ACP Sessions Look Like

ACP sessions run through the gateway. They show up in:
- `openclaw tasks list --runtime acp` — task record
- `openclaw sessions` — session record with child key
- The agent's session store at `~/.openclaw/agents/*/sessions/`

### Implementation

1. **OpenClawTaskService already handles this** (Phase 1). ACP tasks are just `runtime: "acp"` in the task list.
2. Additional context: fetch `openclaw tasks show <id> --json` for requester origin (channel, sender).
3. Display origin channel badge: 💬 Discord, 📱 iMessage, 📲 Telegram
4. Show conversation context: session label, requester, thread info

### ACP Channel Binds (from v2026.3.28)

The new `--bind here` feature turns a chat into a Codex workspace. CC could show:
- "Bound to: Discord #ops-channel" in detail node
- Link to open the chat in Discord (deep link)

---

## Phase 4: Task Flows Visualization (M5-7 scope — when OpenClaw ships flows CLI)

**Goal:** Show parent→child task relationships as a tree.

### Prerequisite: `openclaw flows` CLI

The v2026.3.31 release added SQLite scaffolding for task flows but the CLI isn't fully exposed yet. When it ships:

1. **FlowService** — wraps `openclaw flows list --json`
2. **Flow tree nodes** — parent flow with child task nodes
3. **Flow status** — aggregated from child statuses (all succeeded = flow succeeded)
4. **Flow actions** — cancel all, retry failed children

### How Launcher Tasks Map to Flows

When the launcher emits `TASK_SPAWNED` and OpenClaw gains a flow creation API:
1. Multi-step orchestration (spec → implement → review) becomes one flow
2. Each `oste-spawn.sh` call registers as a child task in the flow
3. CC shows the flow as a collapsible parent with children

This is the endgame for the hybrid bridge: launcher tasks get parent→child tracking without replacing any launcher infrastructure.

---

## Phase 5: Model Policy Dashboard (M5-6 scope — 1-2 sessions)

**Goal:** Visualize model assignments, drift, and costs in CC.

### Implementation

Extend `OpenClawConfigService` with:

1. **Policy view** — show all agent→model assignments from `openclaw.json`
2. **Drift detection** — compare policy model vs runtime model (from `openclaw status --json`)
3. **Cost attribution** — when token tracking is available, show cost per agent per session
4. **Policy sync action** — "Sync Policy" command that runs `oc-policy sync`

This builds on the existing `OpenClawConfigService` and the model policy work from 2026-03-30/31.

---

## Priority Order

| Phase | Scope | Effort | Value | Dependency |
|-------|-------|--------|-------|------------|
| **1: Task Service** | M3.5 | 2-3 sessions | HIGH | None — CLI exists today |
| **2: Blocked State** | M3 | 1-2 sessions | HIGH | Phase 1 |
| **3: ACP Visibility** | M3-7 | 2-3 sessions | MEDIUM | Phase 1 |
| **4: Task Flows** | M5-7 | 2-3 sessions | HIGH | OpenClaw flows CLI (not yet shipped) |
| **5: Model Policy** | M5-6 | 1-2 sessions | MEDIUM | Phase 1 + model policy tool |

**Recommended start:** Phase 1 (Task Service). It unblocks everything else and uses only capabilities available today.

---

## Integration Pattern Summary

```
OpenClaw Gateway
  │
  ├─ ~/.openclaw/openclaw.json ──→ OpenClawConfigService (file watch) ──→ Model display
  ├─ ~/.openclaw/cron/jobs.json ──→ CronService (CLI + file watch) ──→ Cron tree
  ├─ `openclaw tasks list --json` ──→ OpenClawTaskService (NEW, CLI + poll) ──→ Task tree
  └─ `openclaw tasks show <id>` ──→ OpenClawTaskService (detail fetch) ──→ Detail nodes
  
Ghostty Launcher
  │
  ├─ ~/.config/ghostty-launcher/tasks.json ──→ readRegistry() (file watch) ──→ Agent tree
  ├─ TASK_SPAWNED system event ──→ Gateway ──→ orchestrator hook ──→ Oste awareness
  └─ TASK_COMPLETE system event ──→ Gateway ──→ orchestrator hook ──→ Oste review + iterate
```

All integration follows the **CLI + file watch** pattern. No direct WebSocket connections. No API keys. Graceful degradation when OpenClaw is not installed.
