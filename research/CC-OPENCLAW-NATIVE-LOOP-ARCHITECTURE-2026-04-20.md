# Command Central × OpenClaw: Native Loop Architecture

> Date: 2026-04-20
> Task: `cc-openclaw-native-bridge-20260420-1241`
> Scope: research-only; no code changes
> Preceding work: Ghostty Launcher node commits `9d87ebe` (dashboard reap + reconciliation receipts) and `5a19f6e` (live agent subshell terminates after completion marker)

## TL;DR

Command Central today renders **three parallel worlds** as one tree and hopes they line up:

1. **Launcher truth** — `~/.config/ghostty-launcher/tasks.json`, ingested via `readRegistry()` and layered with heuristic overlays (`toDisplayTask`, `isRunningTaskHealthy`, `completed_stale`, `completed_dirty`).
2. **OpenClaw truth** — `~/.openclaw/tasks/runs.sqlite`, read through `OpenClawTaskService` and `TaskFlowService`.
3. **Process truth** — `ProcessScanner` + `tmux-pane-health`, producing `DiscoveredAgent` records for anything outside either ledger.

These worlds are reconciled at the UI layer with a single check (`shouldDedupOpenClawTask`, `src/providers/agent-status-tree-provider.ts:1770`). Launcher and OpenClaw don't actually share a taskId; CC matches on `childSessionKey ⊂ session_id` or `task.label === launcherTask.id`. Everything else is inferred.

The recommendation is **flip the arrow**: OpenClaw's `runs.sqlite` becomes the lifecycle source of truth, the launcher writes into it, CC stops inferring lifecycle for launcher-bound tasks, and CC keeps exclusive ownership of the VS Code-native operator surface (tree, context menus, dock bounce, notifications, keybindings). `tasks.json` stays as a legacy read-model and a transport for launcher-only fields (bundle_path, tmux_socket, persist socket). Process scanning stays as a fallback for external terminals, but promotes discoveries into OpenClaw rows instead of living as synthetic nodes forever.

---

## Current state: what's actually wired up

### OpenClaw read path

- **`src/services/openclaw-task-service.ts`** (all 157 lines)
  - `reload()` — synchronous `execFileSync("openclaw", ["tasks", "list", "--json"])` at startup and on ledger change (`:37-48`)
  - `startWatching()` — `fs.watch(~/.openclaw/tasks/)` filtered to `runs.sqlite` + `runs.sqlite-wal`, 150 ms debounce (`:119-142`)
  - 7-day lookback filter (`LOOKBACK_MS`, `:10, :100-101`)
  - `getTasks()`, `getRunningTasks()`, `getRecentTasks()`, `cancelTask()`, `setNotifyPolicy()` — thin wrappers; no event emitter, single `onChange` callback (`:19, :31-34`)

- **`src/services/taskflow-service.ts`** (154 lines)
  - Mirror of OpenClawTaskService against `openclaw tasks flow list --json`
  - Same 150 ms debounce, same lookback, same single `onChange`
  - `TaskFlow.tasks?: TaskFlowTask[]` is embedded JSON returned by the CLI — no independent relation to `OpenClawTask` records even though `TaskFlowTask extends OpenClawTask` (`src/types/taskflow-types.ts:18-23`)

- **`src/types/openclaw-task-types.ts`** — full lifecycle vocabulary already exists:
  `"queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "blocked"`. CC has theme icons and human labels for every one (`openclawStatusToIcon`, `openclawStatusToLabel`). This is a richer terminology than the launcher's `AgentTaskStatus` (`agent-status-tree-provider.ts:92-100`): `running | stopped | killed | completed | completed_dirty | completed_stale | failed`.

### Launcher read path

- **`AgentStatusTreeProvider.readRegistry()`** (`agent-status-tree-provider.ts:698-715`) parses `tasks.json`
- **`isRunningTaskHealthy`** (`:1302-1342`) — process liveness inference:
  - `terminal_backend === "persist"` → persist socket probe
  - `terminal_backend === "tmux" | undefined` → `isTmuxWindowAlive` or `isTmuxSessionAlive`, then `isTmuxPaneAgentHealthy`
  - Fallback: `hasLiveDiscoveredSession`
  - Plus a "stuck" heuristic on top (`:1311`)
- **`toDisplayTask`** (`:1344-1394`) — applies `completed_stale | completed | completed_dirty | stopped` overlays when the stored status says `running` but health says otherwise
- Ground-truth escape hatches: `task.exit_code === 0`, `task.completed_at`, `hasCommitsSinceStart` (`:1366, 1382`)

This is the inference layer that lies — not because it's buggy, but because it runs on partial signal. Every "the UI looks wrong or late" failure mode lives in these two functions or in their interaction with filesystem watcher latency.

### Bridge between worlds

- **`shouldDedupOpenClawTask`** (`agent-status-tree-provider.ts:1770-1789`) — the ONLY unification point:
  ```
  hide OpenClaw task if (task.childSessionKey contains any launcher session_id)
                     or (task.label === any launcher.id)
  ```
  There is no explicit cross-ID. The match is substring-based. If the launcher renames or redacts `session_id`, the dedup silently breaks and the UI double-renders.
- **`getNonLauncherOpenClawTasks`** (`:1791-1803`) — merges OpenClaw + ACP session service maps; launcher wins.

### Launcher → OpenClaw write path

- `scripts/oste-spawn.sh:68, 2521-2531` — `TASK_SPAWNED` system event **is off by default** (`OSTE_EMIT_TASK_SPAWNED_EVENT=0`) because the author considered it noisy. Comment at `:2522` explicitly says "these direct system events leak noisy spawn receipts."
- `scripts/oste-complete.sh:480`, `scripts/oste-done.sh:31`, `scripts/oste-notify.sh:495` — emit `openclaw system event` as wake pings, not as lifecycle writes. They do not create or transition rows in `runs.sqlite`.
- Net effect: **launcher tasks do not exist in OpenClaw's ledger** unless the operator opts in per-spawn. CC's OpenClaw view is currently populated mostly by ACP / cron / subagent runtimes, not by the launcher.

### Recent fixes, for context

`9d87ebe` and `5a19f6e` are launcher-side. They close two long-standing loops: the dashboard now reaps stale visible lanes, and completion now actually kills the live agent subshell so the wrapped tail can advance. Neither fix touches CC. But they raise the stakes: when the launcher's internal truth is cleaner, CC's inference-based view becomes the obvious remaining lie.

---

## Source-of-truth precedence, today vs. recommended

### Today (de-facto)

```
process table ──┐
tmux session  ──┤
persist socket ─┼──→  isRunningTaskHealthy  ──→  toDisplayTask  ──→  CC tree
tasks.json     ─┘          (inference)           (overlay)

openclaw       ─────────→  OpenClawTaskService  ──→  filter ≠ launcher  ──→  BackgroundTasksNode
runs.sqlite                                                                 (second-class group)
```

Problems:
- Inference layer is authoritative for launcher work; OpenClaw status is never consulted for launcher rows
- Dedup is substring-based; off-by-one in `session_id` format silently double-renders
- OpenClaw status vocabulary (blocked, timed_out, lost) is unreachable for launcher tasks
- External-terminal agents are synthetic forever; they never get a taskId or participate in notifications, cancel, or flow grouping

### Recommended (target)

```
launcher spawn ──→ openclaw tasks register ──→ runs.sqlite  ──┐
launcher marker ─→ openclaw tasks complete ──→ runs.sqlite  ──┤
process scanner ─→ openclaw tasks register (runtime=discovered) ┤
                                                                ↓
                          OpenClawTaskService (SINGLE LIFECYCLE TRUTH)
                                                                ↓
                          CC tree / dock / notifications / quick actions
                                                                ↑
                          tasks.json (launcher-only metadata: bundle, socket, pane)
```

Precedence rules, in order:

1. **OpenClaw `runs.sqlite`** owns lifecycle status for anything with a taskId. `running | succeeded | failed | timed_out | blocked | cancelled | lost` come from the ledger, not from inference.
2. **`tasks.json`** owns launcher-only metadata: bundle_path, tmux_window_id, tmux_socket, persist socket, prompt_file. CC joins on taskId and reads these for quick actions (attach, steer, capture).
3. **Process scanner** is a fallback for terminals spawned outside the launcher and not registered in OpenClaw. When discovered, CC calls `openclaw tasks register --runtime=discovered --source-id=<pid>:<sessionId>`; subsequent renders read the new row like any other.
4. **Inference** (`isRunningTaskHealthy`, `toDisplayTask`) shrinks to a single narrow role: detecting ledger-vs-world drift (e.g. OpenClaw says `running` but tmux window is dead for > N minutes) and reporting it as a receipt, not as a silent status mutation. The receipt goes to a new "reconciliation" stream that CC surfaces as a badge, identical in spirit to the dashboard reap receipts landed in `9d87ebe`.

This is the OpenClaw-native move: tasks are the background-work ledger, TaskFlow is orchestration above tasks, and CC is the operator UI above TaskFlow. CC does not compute lifecycle; it renders it and steers it.

---

## Why this preserves CC's role

CC's value is not "we also know about lifecycles." It is:

- Native VS Code tree view with VS Code sort/group/filter affordances
- Quick actions keyed to VS Code menus and keybindings
- Dock bounce + VS Code notifications keyed to status transitions
- Webview panels for per-task detail
- Deep integration with the editor workspace (project scoping, file-change overlay, commit attribution)

All of these are orthogonal to *who computes the status*. Moving authoritative lifecycle into OpenClaw makes CC more honest, not less central. The operator-facing surface doesn't change; the signal behind it gets trustworthy.

---

## Hub/node divergence — where it gets hard

Today's reality (from `openclaw-codex-harness/pending-work.md` and node state dirs):

- Hub runs the OpenClaw gateway and keeps its own `~/.openclaw/tasks/runs.sqlite`
- Node has its own `~/.openclaw/` (and sometimes a stale second one, e.g. `/Users/mike/.openclaw`)
- Launcher tasks execute on the node; operator may be watching CC on either machine

Design choice: **CC reads the local `runs.sqlite`.** That is the cheapest correct answer:

- On the node (where the launcher runs), the local ledger is authoritative for local tasks
- On the hub, CC sees hub-originated tasks (main agent, ACP, cron) plus whatever the gateway sync replicates from node
- Cross-machine views are an OpenClaw problem, not a CC problem. Pushing CC into multi-host federation is a layering mistake.

Risks to flag:

- **Stale second state dir** (S1, S2 in pending-work). CC's `os.homedir()` is non-negotiable; if the user starts a process under a different home, CC will silently read the wrong ledger. Worth a diagnostic at startup: log the absolute path and row count, same shape as CronService's init.
- **Gateway sync lag.** If hub-side CC shows a node task, its lifecycle updates arrive on the hub's ledger only as fast as the gateway replicates. That is OpenClaw's SLO, not CC's. Surface the replication timestamp as a tooltip field so the user can see staleness rather than mistake it for bugs.
- **Node without launcher.** Perfectly legal: a node can run only ACP/cron. The architecture degrades cleanly because CC already tolerates an empty `tasks.json` (`readRegistry` returns `{}` with a fallback log, `:715`).

---

## External-terminal discovery — the tricky one

`ProcessScanner` today produces `DiscoveredAgent` synthetic records (`agent-status-tree-provider.ts:1822-1833, 1844-1856`). These have no taskId, don't participate in OpenClaw quick actions, can't be cancelled via `openclaw tasks cancel`, and survive only as long as the process does.

Recommended shape:

- On first scan, `openclaw tasks register --runtime=discovered --source-id=<pid>:<sessionId> --scope-kind=ambient --label=<inferred>` to adopt the process into the ledger
- OpenClaw v2026.3.31 already has a `runtime: "discovered"` slot semantically (the type union in `openclaw-task-types.ts:5` is `"acp" | "subagent" | "cron" | "cli"` — this needs one more variant; cross-repo change)
- Once adopted, the process becomes a first-class row and CC stops rendering synthetic nodes for it
- On process death, a small reaper either transitions it to `lost` or `completed` based on exit evidence (same heuristic as `toDisplayTask:1366-1388`, now run exactly once at adoption-end, not on every render)

This closes the last "second-class citizen" in the tree.

---

## Minimum practical next slice

**Goal:** make OpenClaw authoritative for launcher-task lifecycle without rewriting anything else. Three commits across two repos. ~1-2 sessions.

### Slice A — launcher writes to the ledger (ghostty-launcher repo)

1. `scripts/oste-spawn.sh:68` — flip `OSTE_EMIT_TASK_SPAWNED_EVENT` default to `1`, AND replace the `system event` emission at `:2526-2531` with `openclaw tasks register --task-id="$task_id" --runtime=launcher --session-key="$session" --label="$project_name" --status=running`. Wrap in `command -v openclaw` guard to preserve graceful-degradation when OpenClaw isn't installed.
2. `scripts/oste-complete.sh:480` — add, after the existing wake event: `openclaw tasks complete "$task_id" --exit-code=$exit_code` (or `fail` on non-zero).
3. `scripts/oste-kill.sh` — equivalent `openclaw tasks cancel "$task_id"`.

Prereq: OpenClaw CLI must expose `tasks register` and `tasks complete` for the `launcher` runtime. Confirm; if not, add a one-commit PR to OpenClaw first. (The `subagent` runtime already supports register/complete, so the precedent exists.)

### Slice B — CC trusts OpenClaw for launcher-bound tasks (command-central repo)

4. `src/types/openclaw-task-types.ts` — add `"launcher"` and `"discovered"` to the runtime union.
5. `src/providers/agent-status-tree-provider.ts:1770` — invert `shouldDedupOpenClawTask`. Rename to `joinOpenClawTaskToLauncherEntry`. When a launcher `AgentTask.id` matches an OpenClaw `taskId`, **merge** them: OpenClaw status wins; launcher metadata (bundle_path, tmux_socket, pane health) stays. Render ONE row.
6. `src/providers/agent-status-tree-provider.ts:1302-1394` — gate `isRunningTaskHealthy` / `toDisplayTask` on `task.id ∈ openclawTasks`. If the ledger knows the task, CC does NOT overlay status; it reports drift via a new tooltip receipt. Keep existing inference for tasks that are ledger-less (back-compat).
7. `src/services/openclaw-task-service.ts` — add `getTaskByLauncherId(id)` and `getTasksByLauncherSession(sessionId)` lookup helpers so the join in step 5 is a map lookup, not a filter.

### Slice C — diagnostics (same repo, same slice)

8. Log absolute `runs.sqlite` path + row count on `OpenClawTaskService.start()`, identical shape to CronService's init log. Lets the user spot hub/node state-dir drift immediately.
9. Surface OpenClaw CLI `ENOENT` state in the tree as a one-line banner node ("OpenClaw not installed — launcher lifecycle inferred") instead of silently collapsing to `_isInstalled = false`.

### What we are NOT doing in this slice

- No TaskFlow UI restructure. Flows keep rendering as they do today. They get correct child status for free as a side effect of Slice A/B.
- No ACP session rework. ACP already lives in OpenClaw.
- No process-scanner → ledger adoption. That's Slice D, separate session, depends on OpenClaw adding a `discovered` runtime type. File-level target: `src/discovery/process-scanner.ts:261-268` is where the adoption call would go, beside the existing stale-process filter.

---

## Risks and trade-offs

| Risk | Where it bites | Mitigation |
| --- | --- | --- |
| OpenClaw CLI contract drift (`tasks register`, `tasks complete` signatures change) | Slice A silently stops writing rows; launcher → CC becomes blind | Pin CLI version at launcher install; add `openclaw --version` check in `oste-spawn.sh` preamble; keep `isRunningTaskHealthy` inference as fallback for ledger-less rows |
| Hub/node ledger federation lag | Hub-side CC shows stale status for node-executed tasks | Surface `lastEventAt` as a "last seen" timestamp; do not engineer around this in CC |
| Double-write race (spawn writes `running`, completion writes `succeeded`, CC reads in-between) | Transient flicker in tree | 150 ms debounce on the fs-watcher already absorbs this; no action |
| External-terminal agents lose their ledger row (process killed, reaper loses it) | Row stuck `running` forever | Reaper transitions to `lost` after a configurable quiescence; `lost` is already in the status vocabulary |
| Migration for in-flight tasks during rollout | A running task spawned before Slice A ships has no ledger row | Keep full legacy inference path intact; new rows start working on next spawn; no backfill needed |
| `shouldDedupOpenClawTask` substring matching on `childSessionKey` | Already broken silently; a rename in launcher `session_id` format double-renders the tree | Slice B step 5 removes the substring match entirely in favor of taskId join |
| Operator sees "OpenClaw not installed" banner on a clean machine | False alarm on fresh install | Only show banner when `openclaw --version` succeeds but `runs.sqlite` is missing; stay silent when the binary is missing |
| VSIX size creep from new service code | Bundle budget in CLAUDE.md says < 100 KB | Slices A-C add ~200 lines of TS; comfortably under budget |

---

## Open questions for the operator

1. **Should `launcher` be a distinct runtime in OpenClaw, or should it piggyback on `subagent`?** Distinct makes the tree more explicit; piggyback is cheaper. I lean distinct because the operator surface (bundle path, tmux pane) is meaningfully different.
2. **Do we want TaskFlow to auto-group launcher tasks when multi-step orchestration spawns them via `oste-dispatch-coder.sh`?** Yes eventually, but out of this slice. Requires OpenClaw flow creation API the launcher can call; the roadmap already scopes this as Phase 4 in `ROADMAP-OPENCLAW-INTEGRATION.md`.
3. **Do we keep `completed_stale` and `completed_dirty` as CC-private statuses, or push them into OpenClaw?** Keep them private. They are UX hints about ledger/world drift; they do not describe the task itself. They belong on top of OpenClaw status, not instead of it.

---

## Pointers

- Existing roadmap: `research/ROADMAP-OPENCLAW-INTEGRATION.md` — Phases 1-2 are already shipped; this document is a mid-course correction on what "Phase 1.5" actually means.
- Dedup point: `src/providers/agent-status-tree-provider.ts:1770`
- Inference layer: `src/providers/agent-status-tree-provider.ts:1302-1394`
- OpenClaw service: `src/services/openclaw-task-service.ts:37-48, 119-142`
- Launcher emit defaults: `ghostty-launcher/scripts/oste-spawn.sh:68, 2521-2531`
- Launcher completion: `ghostty-launcher/scripts/oste-complete.sh:480`
