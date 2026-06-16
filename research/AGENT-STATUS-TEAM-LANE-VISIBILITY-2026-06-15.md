# Agent Status — Team/Lane Visibility Diagnosis

- **Task id:** `cc-agent-status-team-lane-visibility-20260615`
- **Date:** 2026-06-15 (investigation), task ran 2026-06-16T02:37:04Z → mis-finalized 02:43:20Z
- **Repo:** `/Users/ostehost/projects/command-central`
- **Execution host:** MacBook node — ComputerName `Mike’s MacBook Pro`, user `ostehost`
- **Subject task:** `symphony-unmodified-openclaw-integration-20260615` (node repo `/Users/ostehost/projects/symphony-daemon`)
- **Mode:** Read-only diagnosis. No production code, config, or external system was mutated.

---

## 1. Executive Diagnosis

**The Opus Agent Team is genuinely alive and was actively working the entire time. Command Central never showed it as "running" because of a *layered* failure — it is NOT a single bug. In order of causal weight:**

1. **PRIMARY — Launcher premature contract finalization (launcher task-state bug).**
   The launcher evaluated the completion contract ~6 minutes after launch (`started_at` 02:37:04Z → `completed_at` 02:43:20Z), found the declared handoff missing, and stamped the lead task `status: contract_failure`, `failure_reason: missing_handoff`, `exit_code: 0`. **But the Agent Team session was never dead** — the launcher's own record admits this with `session_live: true`. The lead and its 3 teammates kept running for hours afterward. **Direct proof captured during this investigation:** the declared handoff `research/UNMODIFIED-OPENCLAW-SYMPHONY-INTEGRATION-PLAN-2026-06-15.md` was *absent* at the first probe and *present (untracked)* minutes later — the "missing" artifact materialized while the supposedly-failed lane was still typing it. The launcher applied a single-shot, lead-Stop-triggered contract gate to an Agent Teams `delegate` lane whose real work outlives the lead's first turn.

2. **SECONDARY / LATENT — Command Central cannot represent "terminal status but provably alive" as Live (CC classification gap).**
   Given the launcher's `contract_failure` record, CC's status engine routes the lane to **Action Required**, never **Live/Running**, even though CC *can* probe the tmux pane and prove the agent is alive on this host. The "alive process wins" doctrine that CC documents for itself is only implemented in the not-yet-wired V2 classifier; the shipped render path does not honor it for terminal-failure statuses. (Details in §3.B.)

3. **MIRRORING GAP — node-origin launcher task is invisible on the hub.**
   The hub registry `/Users/ostemini/.config/ghostty-launcher/tasks.json` does **not** contain this task. CC has no cross-host registry federation. **If Mike was looking at Command Central on the hub, the team was simply absent from the tree** — the most likely literal match to "not showing." On the node it shows under Action Required (see §3).

4. **DATA-INTEGRITY BUG (separate, non-blocking for the symptom) — cross-task report bleed.**
   The pending-review receipt `/tmp/oste-pending-review/symphony-...json` carries `report.original_task_id: ackwake-p0-fixes-20260615` and `files_changed: [research/ACKWAKE-P0-FIXES-2026-06-15.md]`. The launcher's completion hook attached the *previous* task's `.oste-report.yaml` (the symphony team started from the ackwake end-state in a shared working copy — symphony HEAD is `3356a3dc`, the ackwake result commit). This corrupts the review surface but is inert for CC's status display of this task (the receipt is only read for `running` tasks; see §3.A Tier 1b).

**Verdict: all of the above — expected-given-the-data on the CC side, but driven by a launcher bug, exposed by a CC classification gap, and amplified by a mirroring gap.**

---

## 2. Source / Data Evidence

### 2.1 Ground truth — the team is alive (node)

tmux session `agent-symphony-daemon` (socket `~/.local/state/ghostty-launcher/tmux/symphony-daemon.sock`), window `@85` (idx 86), **4 panes**:

| Pane | Role | Process (live) |
|------|------|----------------|
| `%93` | team lead | Claude Code, title "Design Symphony-OpenClaw integration without core patches" — captured mid-turn ("Recombobulating… 3m 11s"), `[Opus 4.8] · 3 teammates` |
| `%94` | teammate | `topology-scout@session-896a5640` (Explore, haiku) |
| `%95` | teammate | `primitive-scout@session-896a5640` (Explore, haiku) |
| `%96` | teammate | `spec-scout@session-896a5640` (Explore, haiku) |

All three teammates run with `--parent-session-id c8fd1dc1-da7d-4abc-8843-e0c7f9a83406`, which **exactly matches** the record's `claude_session_id`. This is unambiguously the team for this task, and it is alive.

### 2.2 Launcher record (node `~/.config/ghostty-launcher/tasks.json`)

```
status              = contract_failure
failure_reason      = missing_handoff
artifact_status     = missing
stream_status       = missing      # /tmp/claude-stream-…jsonl never created (confirmed absent)
session_live        = true         # launcher's own contradicting liveness signal
exit_code           = 0
started_at          = 2026-06-16T02:37:04Z
completed_at        = 2026-06-16T02:43:20Z   # ~6 min — far shorter than the real team run
team_requested      = true
team_template       = full
prompt_summary      = "You are the team lead … operating in Agent Teams delegate …"
exec_host           = "Mike’s MacBook Pro"   # == this machine's ComputerName → treated LOCAL by CC
exec_mode           = hub
project_ref.id      = symphony-daemon        # ← present → admitted by CC lane-records-only filter
tmux_session/_pane  = agent-symphony-daemon / %93
claude_session_id   = c8fd1dc1-da7d-4abc-8843-e0c7f9a83406
handoff_file        = research/UNMODIFIED-OPENCLAW-SYMPHONY-INTEGRATION-PLAN-2026-06-15.md
review_dispatch_failed = true (spawn_failed, exit 1)
```

### 2.3 The "missing" handoff materialized during investigation (smoking gun)

- First probe: `ls research/UNMODIFIED-OPENCLAW-SYMPHONY-INTEGRATION-PLAN-2026-06-15.md` → **No such file**.
- Minutes later: `git status` in symphony-daemon → `?? research/UNMODIFIED-OPENCLAW-SYMPHONY-INTEGRATION-PLAN-2026-06-15.md` (now present, untracked).
- The live lead pane was observed running `mkdir -p "$(dirname "research/UNMODIFIED-OPENCLAW-…md")"` then "Now I'll write the comprehensive handoff artifact."
- Symphony HEAD `3356a3dc` == record `start_sha`/`end_commit`/`agent_commit` → **the team has committed nothing yet**; it is still in-flight. The `missing_handoff` verdict was a race against an unfinished, healthy lane.

### 2.4 Stale pending-review receipt

`/tmp/oste-pending-review/symphony-unmodified-openclaw-integration-20260615.json`:
- top-level `status: contract_failure` (launcher-overwritten),
- but `report.original_task_id: ackwake-p0-fixes-20260615`, `report.status: success`, `files_changed: [research/ACKWAKE-P0-FIXES-2026-06-15.md]`, summary about "ackWake P0 BLOCKERs".
- symphony-daemon git log confirms the working copy's recent commits are all `ackwake-p0-fixes-20260615` — the leftover `.oste-report.yaml` from that lane was consumed by this lane's completion hook.

### 2.5 Hub registry

`/Users/ostemini/.config/ghostty-launcher/tasks.json` does **not** contain `symphony-unmodified-openclaw-integration-20260615`. No mirroring.

---

## 3. Why CC classifies it as it does (source walk)

### A. Ingestion — the task IS admitted on the node

- Lane registry default (`commandCentral.laneRegistry.files`) = `["~/.config/openclaw/lanes.json", "~/.config/ghostty-launcher/tasks.json"]` (`package.json`; `src/utils/tasks-file-resolver.ts:64`). Zero-config, no opt-in required.
- The node `tasks.json` is read with the `lane-records-only` filter (`resolveTaskRegistrySources`, `tasks-file-resolver.ts:208`).
- `applyIngestFilter` (`agent-status-tree-provider.ts:3680`) admits only `isRegistryBackedLaneTask` rows; that predicate is just `Boolean(task.project_ref?.id?.trim())` (`agent-status-tree-provider.ts:973`).
- The subject task has `project_ref.id = "symphony-daemon"` → **ADMITTED**. (Measured: 186 of 214 node rows are admittable; this task is among them.) **So the legacy-quarantine default is NOT why it's hidden** — that mechanism passes it through.

`toDisplayTask` (`agent-status-tree-provider.ts:2282`):
- Tier 1a (line 2305): `if (task.status !== "running") return task;` — a terminal status is returned **unchanged**. `contract_failure` survives verbatim.
- Tier 1b pending-review overlay only runs when `task.status === "running"` (line 2289) → the stale receipt (§2.4) is **never read** for this task, so it does not corrupt the displayed status (good) — but it also can't rescue it.
- **The reconciler can only DEMOTE a `running` lane; it never PROMOTES a terminal one back to running, regardless of liveness.** This is by design (Tier 2c comment, lines 2261-2267).

### B. Classification — routed to Action Required, never Live (the CC gap)

Live render uses the legacy four-bucket engine `getNodeStatusGroup` (`agent-status-tree-provider.ts:4569`), mapped to V2 sections via `AGENT_STATUS_GROUP_TO_SECTION` (`src/utils/agent-status-sections.ts:85`: running→live, limbo→review, attention→action, done→history). For `contract_failure`:

```
status = getNodeStatus(node)            // = node.task.status = "contract_failure"  (line 4502)
if (status === "running") return "running";                    // skipped
if (status === "completed"|"completed_dirty"|"completed_stale") // ← GATE excludes contract_failure
    { …liveness/lifecycle-conflict check… return "attention"; } // never entered
if (status === "completed") {…}                                 // skipped
if (status === "completed_dirty"|"completed_stale") return "limbo"; // skipped
return "attention";                                            // ← contract_failure lands here
```

Two distinct defects compound here:

- **B1 — the liveness gate is too narrow.** The lifecycle-conflict liveness probe (lines 4578-4591) is gated to `completed* ` statuses only. Yet `classifyLifecycleConflict`'s own `CONFLICT_ELIGIBLE_STATUSES` (`src/providers/agent-task-classification.ts:374`) explicitly includes `contract_failure`, `failed`, `stopped`, `killed`. So a `contract_failure`-but-alive lane is never even checked for liveness during grouping.
- **B2 — even a detected conflict routes to `attention`, not `running`.** The conflict branch `return "attention"` (line 4589) means "terminal-but-alive" is surfaced as **Action Required**, never **Live**. The richer `sectionFromSignals` (`agent-status-sections.ts:198`) *does* implement the documented doctrine — `if (signals.livenessAlive) return "live";` (line 201) — but it is the post-RC M3 engine and is **not wired into the live render path**.

Net: on the node, the lane renders under **Action Required** labeled `contract_failure`. If the operator *expands* it, the detail builder (lines 5666-5682) *does* probe any terminal status and appends a **"Lifecycle conflict — Launcher marked contract_failure but process is still alive in terminal"** detail row (it calls the un-gated `getTerminalTaskLivenessEvidence`). But that badge does not relocate the lane to Live, and it requires the user to already have found and expanded a lane sitting in the failure bucket.

### C. Host gating — liveness is probed (local), but only in the detail view

`exec_host = "Mike’s MacBook Pro"` equals this machine's `scutil --get ComputerName`, so `isRemoteNodeTaskForCurrentHost` (`agent-task-classification.ts:166`) is **false** → the task is local → `getTerminalTaskLivenessEvidence` (`agent-status-tree-provider.ts:2196`) is allowed to run the tmux probe against pane `%93`. So CC *has the evidence* to know the lane is alive; it just doesn't use it in the grouping engine (B1/B2). On the hub the same task wouldn't be present at all (§2.5).

### D. Discovery

Discovery (`commandCentral.discovery.enabled` default true) can mark agents stale via stream-file mtime; the stream file here never existed, so discovery offers no liveness rescue. The four-source merge ranks **launcher tasks.json above SessionWatcher/ProcessScanner**, and the live processes are *subagents of the parent session* (`--parent-session-id`), not independent sessions/launcher tasks — Agent Teams children are not represented as launcher tasks by design. So discovery does not independently surface a "running" row for this work. (`getNodeStatus` returns `"running"` for `type === "discovered"` nodes — line 4503 — but no discovered node is produced for this team.)

---

## 4. What CC *should* show

Ground truth = **alive and productive**. Recommended target behavior:

| Surface | Should show as | Rationale |
|---------|----------------|-----------|
| Node CC (registry has the task, host local, pane alive) | **Live / Running**, badged "lifecycle conflict — launcher marked contract_failure but session is alive" | Alive process must win over a stale terminal verdict — this is CC's own documented doctrine (`agent-status-sections.ts:24,199-201`). |
| Node CC, acceptable interim | **Action Required** *with the lifecycle-conflict badge promoted to the row label* (not buried in expand-only detail) | At minimum the alive-but-"failed" contradiction must be visible without expansion. |
| Hub CC | **Visible at all** (today: hidden) | Requires mirroring/federation of node-origin lanes, or the Work System projection. |
| Never | **Hidden** / **plain history** | The current hub outcome (hidden) and the risk of it aging into History are both wrong for a live lane. |

The team children (`topology-scout`/`spec-scout`/`primitive-scout`) are not expected as separate launcher rows, but the lead row should communicate "Agent Team (N teammates) active" using `team_requested`/`team_template` + live pane count.

---

## 5. Recommended fix paths

### 5.1 Launcher (primary — owner: ghostty-launcher / oste-spawn + completion hook)
- **Do not finalize an Agent Teams lead as terminal while its session is live.** When `team_requested` and `session_live` (tmux window/pane still alive), the completion/contract gate must **defer** rather than stamp `contract_failure`. Options: poll the handoff/commit contract with backoff until the session actually dies, or introduce a non-terminal `team_active` / `running_team` state that CC maps to Live.
- **Stop attaching a stale `.oste-report.yaml`.** The completion hook must verify the report's `original_task_id`/`task_id` matches the lane before ingesting it; otherwise treat the report as absent. The ackwake bleed (§2.4) proves cross-task contamination in a shared working copy.
- Fix the review dispatch `spawn_failed` so a real review can run once the lane truly completes.

### 5.2 Command Central (secondary — this repo; recommendations only, not applied here)
- **B1 fix:** widen the `getNodeStatusGroup` liveness gate (lines 4578-4583) to all `CONFLICT_ELIGIBLE_STATUSES` (include `contract_failure`/`failed`/`stopped`/`killed`), so a terminal-but-alive lane is detected during grouping, not only in expand-only detail.
- **B2 decision (needs product call):** when a lifecycle conflict is detected, either (a) route the lane to **`running`** (honor "alive wins", matching `sectionFromSignals`) with a conflict badge, or (b) keep it in **`attention`** but promote the conflict reason to the row label. Recommendation: (a) for true backend-truthfulness; the lane is running.
- Consider consuming the launcher's own `session_live` field as a corroborating liveness signal for terminal-status lanes on the local host (cheap, no subprocess), to cover cases where the tmux probe cache is cold.
- These are **not applied in this lane** (diagnosis-only mandate). They are clearly scoped and unit-testable (see §6).

### 5.3 Mirroring / config
- Short term, no code: an operator viewing on the hub will not see node lanes. Either (a) view CC on the node where the lane runs, or (b) point `commandCentral.laneRegistry.files` at a shared/synced registry. **Do not** flip `commandCentral.legacyLauncherTasks.enabled` — it does not fix this (the task is already admitted) and re-imports stale rows.
- Durable fix: the OpenClaw-native Work System projection (`workSystem.lanes.list` + per-session projection) referenced in `tasks-file-resolver.ts:40-44`, which would carry lane liveness/host across machines and retire the per-host file bridges.

### 5.4 Symphony team usage
- The lead must write its declared `handoff_file` **before** ending its turn / spawning the long-running team, or the launcher contract must key off session death, not first-turn Stop. Either side closes the race.

---

## 6. Minimal test cases to add (CC repo)

All pure / fast (`just test-unit`). Specs only — not implemented in this diagnosis lane.

1. **`getNodeStatusGroup`: contract_failure + alive tmux → not silently "attention-as-dead".**
   Fixture: task `status:"contract_failure"`, `terminal_backend:"tmux"`, valid `session_id`, local `exec_host`; warm the liveness cache to `"alive"`. Assert the chosen group reflects the lifecycle conflict (target: `"running"` under the B2(a) decision, or at minimum that `classifyLifecycleConflict` is consulted — guards B1).
2. **Regression for the gate:** parametrize over `{failed, stopped, killed, contract_failure}` × `liveness:"alive"` and assert each is treated as a lifecycle conflict, mirroring `CONFLICT_ELIGIBLE_STATUSES`.
3. **`toDisplayTask` does not read a foreign-task receipt for a terminal lane:** receipt with `report.original_task_id !== task.id` must not influence a `contract_failure` task's display (locks in current safe behavior; documents the bleed).
4. **Ingestion admittance:** a `{version,tasks}` row with `project_ref.id` set and `status:"contract_failure"` is admitted under `lane-records-only` (not quarantined) — proves the legacy-quarantine default is not the hiding mechanism.
5. **Lane-registry contract:** existing `test/package-json/lane-registry-defaults-contract.test.ts` already pins the default file list — extend with an assertion that a registry-backed lane survives the filter regardless of terminal status.

---

## 7. Immediate operator action to recover the current run

The team is **alive and has already written the handoff** — nothing needs killing or restarting.

1. **Let it finish.** Pane `%93` (window `@85`, socket `~/.local/state/ghostty-launcher/tmux/symphony-daemon.sock`) holds the live lead; teammates in `%94/%95/%96`. The declared handoff now exists untracked in symphony-daemon.
2. **Watch on the node, not the hub.** On the node the lane is in **Action Required** as `contract_failure`; expand it to see the "process still alive" lifecycle-conflict detail. On the hub it is absent (no mirroring).
3. **Ignore the contract_failure verdict for this lane** — it is a premature-finalization false negative, corroborated by `session_live:true` and the live processes.
4. **Disregard the pending-review receipt content** for this task — it is ackwake's report bled in via the shared working copy; do not action it as a symphony review.
5. When the team ends, re-evaluate the lane against the real (now-present) handoff and a clean report. Do not let the launcher's stale `contract_failure` drive any cleanup/clear of this lane while the session is live.

---

## 8. Scope / constraints honored

- Read-only investigation. No CC config changed, no Command Central reset, no launcher/OpenClaw/Symphony source edited, no processes touched.
- The only write in this lane is this handoff document (the requested deliverable), committed scoped to its own path.
- All §5.2 CC code changes are recommendations, deliberately **not** applied, per the diagnosis-only mandate.
