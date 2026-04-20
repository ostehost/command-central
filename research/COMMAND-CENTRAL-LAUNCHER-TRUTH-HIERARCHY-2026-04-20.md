# Command Central — Launcher Truth Hierarchy

**Date:** 2026-04-20
**Task:** `cc-launcher-truth-hierarchy-20260420-1510`
**Author:** implementation agent (autonomous)

## Context

Three recent fixes closed concrete misses in how Command Central decides the
status of launcher-managed tasks and whether an interactive Claude pane
belongs to the launcher:

- `2164443` — skip Strategy 0 routing for tmux-mode tasks without a matching
  bundle (prevents opening a sibling window by bundle-cache accident).
- `37e0417` — trust the pending-review receipt over stale `tasks.json`
  (closes the "exit gap" where a completed agent kept rendering as running).
- `2e72f91` — keep launcher-managed interactive Claude lanes visible when
  the JSONL stream is silent (positive tmux pane evidence is authoritative).

Each was a point patch. This task defines the underlying **truth hierarchy**
these patches are protecting and applies one more push in that direction.

## Truth hierarchy

Launcher-managed lanes obey this precedence when Command Central reconciles
a `tasks.json` record into a display task. Higher tier wins.

### Tier 1 — Launcher-local authoritative state

| Signal | Source | Who writes it |
|---|---|---|
| Terminal status | `tasks.json` status field | Launcher (`oste-launch.sh`, `oste-complete.sh`) |
| Pending-review receipt | `/tmp/oste-pending-review/<task_id>.json` | Launcher `oste-complete.sh` hook |

**Rule:** a terminal status (`completed`, `failed`, `stopped`, `killed`,
`completed_dirty`, `completed_stale`, `contract_failure`) already in
`tasks.json` is final — we never probe any other source to re-decide it.

The receipt is ground truth for `running` records. It's written the moment
the agent actually exits, which can precede the `status: completed` update
to `tasks.json` by seconds (race) or minutes (in the original bug). It
**overlays every downstream signal** including CC's own staleness cache and
any runtime health inference.

### Tier 2 — Launcher-local secondary

| Signal | Source |
|---|---|
| CC staleness cache (`staleTaskReasons`) | Sticky decision cached in-memory from prior reconciliation runs |
| JSONL stream terminal event | `turn.completed` / `turn.failed` / `result` lines in the agent's streaming output file |

Both live on the local machine and are written by the launcher's child
process (or CC itself). They're authoritative *in the absence of a Tier 1
signal* — a stream-side `turn.completed` with no receipt still reliably
indicates the agent finished.

### Tier 3 — Liveness overlay

| Signal | Source | Role |
|---|---|---|
| tmux pane evidence (`alive` / `dead` / `unknown`) | `inspectTmuxPaneAgent()` via `tmux list-panes` + descendant ps scan | Liveness only |
| Live discovered session | Process scanner / session-file watcher finding a matching `sessionId` | Liveness only |

**Rule:** Tier 3 signals **never decide a terminal status on their own.**
They feed `isRunningTaskHealthy()` to answer one question — "should I keep
trusting `running`?" — and nothing more. Positive evidence keeps the lane
running (interactive Claude fix). Explicit `dead` evidence drops it out of
running (and Tier 4 inference takes over). `unknown` falls back to the
staleness heuristic.

### Tier 4 — Last-resort inference

Only consulted after Tier 1–3 say "unhealthy":

1. `exit_code === 0` or `completed_at` set → `completed`.
2. Non-zero `exit_code` → `failed`.
3. Commits since `start_commit` → `completed_dirty`.
4. Default → `stopped`.

## Attribution for discovered agents

`AgentRegistry.getDiscoveredAgents(launcherTasks)` decides which
process-discovered / session-file Claude instances to show **alongside**
launcher work vs. hide as "already tracked."

**Rule (now):** only suppress a discovered agent when it matches a running
launcher task by:

- PID equality, OR
- `session_id` equality, OR
- same `project_dir` **plus** compatible `agent_backend` **plus** start-time
  within 15 minutes.

This is the same `matchesLauncherTask()` logic already used for the
session-watcher suppression path. Before this commit, `getDiscoveredAgents`
carried a parallel, coarser filter: a `Set<projectDir>` that hid **every**
discovered Claude sharing a directory with any running launcher task. That
over-claimed — an ad-hoc interactive Claude that the user opened in the
same repo as a launcher lane silently vanished from the tree.

The two filters are now unified on the strict rule.

## What shipped in this patch

1. **`src/discovery/agent-registry.ts`** — `getDiscoveredAgents()` now
   delegates to `matchesLauncherTask()` for per-task attribution instead of
   the coarse `projectDir` set. Keeps PID and session_id matching, adds
   backend + start-time-window guard on project_dir overlap. Comment
   explains the over-claim this avoids.
2. **`src/providers/agent-status-tree-provider.ts`** — `toDisplayTask()`
   carries an explicit Tier 1–4 doc comment enumerating the hierarchy and
   pointing back at this file. Strategy markers inline at each tier.
3. **`test/discovery/agent-registry.test.ts`** — new regression test
   "external Claude in same project_dir as launcher lane stays visible"
   pins the fixed attribution.
4. **`test/tree-view/agent-status-pending-review-truth.test.ts`** — two
   new precedence tests:
   - receipt wins over a JSONL stream terminal event that disagrees
     (Tier 1b > Tier 2b).
   - no-receipt + no-liveness task lands in a *recognized* Tier 4 terminal
     state rather than the disappearing-tasks bug.

## Remaining gaps (follow-up candidates)

- **Honest "starting" state.** A task under ~15–30s old with no stream
  output is currently assumed healthy by `isRunningTaskHealthy()` because
  `looksStale` only fires for age ≥ 1h. Works in practice but leaves no
  explicit UI hint for truly-starting-up lanes. A `(starting)` description
  hint parallel to `(interactive)` would be easy to add in
  `getTreeItemImpl()` and would make boot-up state less ambiguous.
- **`(unknown liveness)` UI hint.** When tmux pane evidence is `unknown`
  AND no discovered session AND no receipt for a stale task, CC currently
  falls through to Tier 4 inference silently. Surfacing `(unknown
  liveness)` in the description before the status flip would give the user
  one render tick to notice before the task moves out of "running."
- **Stream terminal trust window.** `getStreamTerminalState()` trusts any
  `turn.completed` / `turn.failed` / `result` event ever written, even if
  the stream file has been dormant for days. Tightening this to require
  the terminal event to be within (e.g.) the staleness window, or to
  require `mtime` within N minutes of `started_at + duration`, would kill
  a long-tail failure mode where a crashed early turn pins the status.
- **OpenClaw ledger role.** `src/services/openclaw-task-service.ts` is
  today the authoritative source only for *background / ACP* tasks
  (they're rendered via `toSyntheticOpenClawTask()` and never overlap
  with `tasks.json`). We don't currently query the OpenClaw ledger for
  launcher-managed `tasks.json` records and we shouldn't start — the
  hierarchy explicitly makes launcher-local state primary for those. If
  the OpenClaw ledger ever gains launcher-lifecycle visibility, it would
  sit between Tier 1b (receipt) and Tier 2 (staleness/stream) rather than
  compete with Tier 1a.
- **Synthetic discovered tasks in `getTasks()`.** Discovered agents
  promoted to synthetic `AgentTask` records with `status: running` (line
  5008 of `agent-status-tree-provider.ts`) never receive the Tier 1–4
  reconciliation — they are always reported as running. That's correct
  (they're inferred from live PIDs) but worth pinning in a comment so a
  future reader doesn't accidentally feed them through `toDisplayTask`.

## Verification

- `just check` — biome + tsc + knip all green.
- `just test` — 1391 tests pass (107 files).
- Added coverage:
  - `test/discovery/agent-registry.test.ts` — attribution rule unit test.
  - `test/tree-view/agent-status-pending-review-truth.test.ts` —
    receipt-vs-stream precedence + Tier 4 fallback.
