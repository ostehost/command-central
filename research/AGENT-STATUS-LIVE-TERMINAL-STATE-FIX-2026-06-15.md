# Agent Status — Live-Terminal-State Fix

- **Task id:** `cc-agent-status-live-terminal-state-20260615`
- **Date:** 2026-06-15
- **Repo:** `/Users/ostehost/projects/command-central`
- **Mode:** Implementation. CC-side (this repo) only — no launcher/OpenClaw/Symphony edits, no config mutation, no publish/release/push.
- **Predecessor diagnosis:** `research/AGENT-STATUS-TEAM-LANE-VISIBILITY-2026-06-15.md` (review: 0 blockers).

---

## 1. Problem (what the incident proved)

`symphony-unmodified-openclaw-integration-20260615` was a live Agent Teams lead
(`session_live: true`, tmux window `@85`, panes `%93–%96`) while the launcher had
prematurely stamped the lead task `contract_failure` / `missing_handoff`. Command
Central could not truthfully surface "terminal status but provably alive":

- **B1 (grouping gate too narrow):** `getNodeStatusGroup` only ran the
  lifecycle-conflict liveness check for `completed*` statuses; `contract_failure`
  / `failed` / `stopped` / `killed` skipped it and fell through as plain dead
  failures — even though `classifyLifecycleConflict`'s own
  `CONFLICT_ELIGIBLE_STATUSES` already includes them.
- **No use of the launcher's own contradicting signal:** CC never read
  `session_live`. The grouping hot path uses a **cache-only** tmux probe (cold →
  `not-checked` → no conflict), and **remote-node lanes are never locally
  probed** — so in exactly the situations that matter, CC had no liveness verdict
  and surfaced nothing.
- The expand-only detail row + the `createTaskItem` description badge both
  depended solely on a live tmux probe, so a node-origin or cold-cache lane
  showed no "still alive" signal at all.

**Decision (honoring the task's hard constraint "truthful over pretty"):** a
terminal-but-alive lane is surfaced as **"live attention required"** — it stays
in **Action Required**, explicitly distinct from a genuine `running` lane (which
renders under Live with a spinner). We deliberately do **not** promote it into
the Live/running bucket (requirement #3: "CC does not falsely show completed
tasks as running; distinction should be explicit: running vs
terminal-but-live/anomalous"). This diverges from the unwired V2
`sectionFromSignals` doctrine ("alive process wins → live"); see §6 risks.

---

## 2. Changes

### `src/providers/agent-task-classification.ts`
- **`classifyLifecycleConflict(task, livenessEvidence, launcherSessionLive?)`** —
  new optional third arg. Evidence precedence is strict:
  1. Real-time tmux probe wins when conclusive: `alive` → conflict; `dead`
     overrides a stale `session_live: true` → **none**.
  2. `launcherSessionLive === true` is consulted **only** when the probe could
     not decide (`unknown` / `not-checked`).
  - **Provenance-honest wording:** a live probe says "…but process is still
    alive in terminal"; a launcher-record-only verdict says "…but the launcher
    recorded the session as still live (session_live) — verify on host", so a
    stale flag never masquerades as a real-time confirmation.
  - Backward compatible: all existing 2-arg callers/tests are unchanged
    (`launcherSessionLive` undefined → probe-only).

### `src/providers/agent-status-tree-provider.ts`
- **`AgentTask` type:** added `session_live?: boolean | null` and
  `team_requested?: boolean | null`, both normalized from the raw record
  (mirroring the `exec_visible` boolean pattern). These launcher fields were
  previously dropped on the floor.
- **`isAgentTeamLead(task)`** — new exported pure predicate
  (`team_requested === true` OR a non-empty `team_template`).
- **`getNodeStatusGroup` (B1 fix):** the lifecycle-conflict gate now spans every
  non-running status (the classifier filters by `CONFLICT_ELIGIBLE_STATUSES`
  internally) and passes `node.task.session_live`. Net bucket effect: terminal
  *failure* statuses already landed in `attention`, so they are unchanged; the
  one new transition is `completed_dirty`/`completed_stale` **+ session_live**
  (cold cache) → `attention` instead of `limbo` (correct — an alive lane is not
  "needs review").
- **`createTaskItem` row badge:** passes `session_live` and renders
  **`⚠ live · lifecycle conflict`** (was `⚠ lifecycle conflict`) — loud,
  un-buried, on the row itself. Plus an **Agent Team lead badge** (`team: <tpl>`
  / `team`) so the otherwise-invisible fan-out (teammates are subagents of the
  lead's Claude session, not sibling launcher tasks) is legible at a glance.
- **Expand detail builder:** passes `session_live` to the same classifier.

### `test/tree-view/agent-status-live-terminal-state.test.ts` (new, 19 tests)
Covers every requested fixture class:
- **terminal + session_live (cold cache/missing stream):** row shows
  `⚠ live · lifecycle conflict`, group `attention`, tooltip cites `session_live`.
- **real-time probe wins:** `alive` pane → "still alive in terminal" wording.
- **truthful death:** confirmed-`dead` pane overrides stale `session_live:true`
  → no badge.
- **grouping bucket change:** `completed_dirty` + session_live → `attention`,
  control (no session_live) → `limbo`.
- **node registry source-of-truth / remote:** remote-node `contract_failure`
  + session_live → badge from the launcher record even though the lane is never
  locally probed (a local `alive` mock is ignored for the remote lane).
- **team child panes (optional):** lead badge from metadata only.
- **missing stream:** `stream_file: null` is no obstacle.
- **ingestion admittance:** `isRegistryBackedLaneTask` admits a
  `contract_failure` row with `project_ref.id` and quarantines one without —
  proves terminal status is not the hiding mechanism.
- **no false "live":** clean dead terminal lane stays a plain failure.
- **pure classifier:** session_live corroboration, provenance wording,
  failed/stopped/killed eligibility, running-never-conflict.

---

## 3. Tests / verification run

```
bun test test/tree-view/agent-status-live-terminal-state.test.ts   # 19 pass
bun test test/tree-view/                                            # 515 pass
just test                                                          # 2163 pass / 1 skip / 0 fail
just check                                                         # biome+tsc clean (8 pre-existing knip/style warnings in other files)
bun run build                                                     # ok
bunx tsc --noEmit                                                  # exit 0
```

Regression focus confirmed green: `agent-status-completed-tmux-regression`,
`agent-status-tree-provider-pure-helpers`, `agent-status-task-classification`,
`agent-status-limbo-tier`.

---

## 4. Manual UI verification (optional — no live incident lane required)

The behavior is fully exercised by unit tests against the real render path
(`getTreeItem → createTaskItem`), so no manual step is required to trust it. To
eyeball it on a real node:

1. Find a terminal-status launcher row whose tmux session is still alive (or
   inject `"session_live": true` into a `contract_failure` row in
   `~/.config/ghostty-launcher/tasks.json`).
2. Reload the Agent Status view. The lane appears under **Action Required** with
   `⚠ live · lifecycle conflict` on the row (not just in the expanded detail).
3. Hover for the tooltip: a live pane reads "process is still alive in
   terminal"; a launcher-record-only signal reads "recorded the session as still
   live (session_live) — verify on host".
4. A team lead row additionally shows `team: <template>`.

---

## 5. Scope / constraints honored

- CC repo only. No launcher / OpenClaw / Symphony source touched. No VS Code
  settings or installed-extension mutation. No marketplace/release/push.
- No broad refactor: four call-sites + one classifier arg + two type fields.
- Truthful status preserved over pretty status: a real-time `dead` probe always
  beats a stale `session_live`; launcher-record-only verdicts are worded as
  such.
- Working tree after commit: only the two source files + the new test file.

---

## 6. Remaining config / mirroring risks (not in scope here)

1. **Launcher premature finalization (PRIMARY, owner: ghostty-launcher).** The
   root cause is unchanged: the launcher stamps an Agent Teams lead terminal
   while its session is live. This CC fix makes the contradiction *visible and
   truthful*; it does not stop the launcher from producing it. The durable fix
   is launcher-side (defer finalization while `session_live`, or a non-terminal
   `team_active` state) — see the diagnosis §5.1.
2. **Hub mirroring gap.** A node-origin lane absent from the hub `tasks.json` is
   still invisible on the hub — CC has no cross-host registry federation. This
   fix improves truthfulness *once the row is present* (and now badges remote
   lanes from `session_live` without a probe), but does not federate registries.
   Operator workaround unchanged: view on the node, or point
   `commandCentral.laneRegistry.files` at a shared registry. Durable fix: the
   Work System projection.
3. **V2 `sectionFromSignals` divergence.** The unwired M3 engine routes
   `livenessAlive → "live"`. This task's product decision routes
   terminal-but-alive → **action** (explicit, not Live). When M3 is wired into
   the render path, that engine must be reconciled with this doctrine (either
   keep terminal-but-alive in action with a live badge, or consciously flip to
   Live) — otherwise the section a lane lands in will change silently.
4. **`session_live` staleness.** It is a snapshot from the launcher's last write,
   not a live heartbeat. We mitigate by (a) letting any conclusive local probe
   override it and (b) wording launcher-record-only verdicts as "verify on host".
   A very old terminal row that still carries `session_live: true` and cannot be
   locally probed (remote) will show the badge on the launcher's word alone —
   which is the correct, honest surfacing of the launcher's own self-contradiction.
