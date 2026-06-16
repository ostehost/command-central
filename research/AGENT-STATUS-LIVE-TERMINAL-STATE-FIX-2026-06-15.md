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
- **Release-hygiene guard (responds to Mike's steer — see §6):** added
  `release_generation?` (alias `source_version`) to `AgentTask` + normalizer, a
  pure `isSupersededByReleaseReset(task, currentGeneration)` predicate, a
  provider `getCurrentReleaseGeneration()` seam (null today) and
  `effectiveLauncherSessionLive(task)` that suppresses a pre-reset lane's
  recorded `session_live`. A lane whose Ghostty app/window belongs to a prior
  generation is badged **`stale (pre-release)`** (row) / **Stale terminal app**
  (detail) and is never promoted to live-attention — even if its tmux pane is
  still a live orphan.

### `test/tree-view/agent-status-live-terminal-state.test.ts` (new, **27 tests** across both predecessor commits — see §8 correction; "19" in an earlier draft was wrong)
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

> **Provenance qualifier (added 2026-06-16, see §8):** the broad `just test` /
> `just check` / `bun run build` figures below were taken in the author's **main
> working checkout** (deps already installed). They do **not** reproduce in a
> fresh isolated worktree that lacks `bun install` + `@types/vscode` — there only
> the **focused** test reliably runs, and it passed in the follow-up review. Treat
> the focused-test line as the portable, independently-confirmed evidence.

```
bun test test/tree-view/agent-status-live-terminal-state.test.ts   # 27 pass  (portable — confirmed in review)
bun test test/tree-view/                                            # all green (main checkout)
just test                                                          # 2171 pass / 1 skip / 0 fail (main checkout w/ deps)
just check                                                         # biome+tsc clean (8 pre-existing knip/style warnings in other files; main checkout)
bun run build                                                     # ok (main checkout)
bunx tsc --noEmit                                                  # exit 0 (main checkout)
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
5. Release-hygiene (§6) cannot be eyeballed until `getCurrentReleaseGeneration()`
   is wired; it is exercised only by the unit tests today (inject a current
   generation + a differing `release_generation` → the row shows
   `stale (pre-release)` instead of the live badge).

---

## 5. Scope / constraints honored

- CC repo only. No launcher / OpenClaw / Symphony source touched. No VS Code
  settings or installed-extension mutation. No marketplace/release/push.
- No broad refactor: the lifecycle-conflict call-sites + one classifier arg +
  three type fields (`session_live`, `team_requested`, `release_generation`) +
  two pure predicates + the release-hygiene guard.
- The release-hygiene guard (§6) is a **gated no-op today**: with no
  current-generation source wired, `getCurrentReleaseGeneration()` returns null,
  so nothing is judged stale and behavior is unchanged. It activates only once
  the launcher stamps generations and CC has a current-generation source.
- Truthful status preserved over pretty status: a real-time `dead` probe always
  beats a stale `session_live`; launcher-record-only verdicts are worded as
  such; a superseded-generation lane reads "stale", never "live".
- Working tree after commit: only the two source files + the new test file.

---

## 6. Release hygiene — stale pre-reset Ghostty apps vs recreated terminals

**Steer (Mike):** after significant changes / on release, terminals are cleared
and recreated automatically. The unit recreated is the **actual Ghostty
`.app` / application window / bundle — not the tmux pane**. A live tmux pane
*inside a pre-release Ghostty app* may be stale even though it is alive. CC must
distinguish an old Ghostty app/window generation from the current one so a stale
app's pane is not mistaken for a current running agent. (CC does **not** kill
anything — representation/data handling only.)

### Why this matters to the fix above
The §2 fix makes "terminal status + alive" loud. Without a generation guard that
loudness would *backfire* on release: a `contract_failure` (or even `running`)
lane whose Ghostty app was superseded by a release, but whose pane is still a
live orphan, would be badged **"live · lifecycle conflict"** as if it were
current work. The guard closes that hole.

### Data handling (what CC compares)
- **Marker:** `release_generation` (alias `source_version`) — an opaque token
  identifying the **Ghostty app/window generation** a lane was created in. The
  per-app identity is the existing `ghostty_bundle_id` / `bundle_path`; the
  generation token is the cross-lane value those share within one release/reset.
- **Current generation:** `getCurrentReleaseGeneration()` — the active
  generation. **Not yet sourced** (returns null → guard inert). Candidate
  sources, in order of preference:
  1. The launcher/reset routine writes a `current_generation` (release version
     or reset epoch) to a state file CC reads — authoritative and cross-host.
  2. CC's own installed release version (`package.json`), matched against the
     launcher's per-lane `release_generation` stamped at spawn.
  3. The Ghostty app instance identity (e.g. the bundle generation / app launch
     epoch of the currently-live launcher Ghostty app) compared to the lane's.
- **Predicate:** `isSupersededByReleaseReset` compares the two tokens for
  **inequality** (tokens may be versions/epochs/uuids with no reliable order;
  `currentGeneration` is assumed authoritative/latest). Judged only when **both**
  are known → safe no-op otherwise.

### UI representation (two explicit, distinct states)
| Lane | Today (no generation source) | With generation wired |
|------|------------------------------|-----------------------|
| **Current-generation** terminal-but-alive | `⚠ live · lifecycle conflict`, Action Required | unchanged |
| **Pre-reset stale** (Ghostty app from a prior generation, pane maybe alive) | (treated as current — the gap) | row `stale (pre-release)`; detail **Stale terminal app** explaining the Ghostty app/window predates the current release and the pane is a non-current orphan; **never** promoted to live-attention; keeps its plain terminal bucket |

The two are mutually exclusive in the render path: a superseded lane shows the
stale badge and its live-conflict badge is suppressed — even when the live tmux
probe says the pane is alive (proven by the test "even a still-alive orphan pane
… reads as stale, not live").

### Tests (added, all green)
- pure `isSupersededByReleaseReset`: differ→stale, match→current, unknown-either-
  side→not judged, whitespace.
- provider: pre-reset `session_live:true` not mistaken for live; live-orphan pane
  of a prior generation reads stale; current-generation lane keeps the live
  badge; superseded `completed_dirty` stays `limbo` (not promoted); backward-
  compatible no-op when no current generation is known.

### Follow-up (not done here — needs a cross-repo contract)
1. **Wire `getCurrentReleaseGeneration()`** to a real source (preferably the
   launcher's `current_generation` state file). Until then the guard is dormant.
2. **Launcher must stamp `release_generation`** on each lane from the Ghostty
   app/release generation at spawn (and re-stamp/retire lanes whose app is
   recreated on reset). This is the launcher half of the contract.
3. **Running-status stale apps.** This change guards the *terminal*-status
   conflict path. A `running`-status lane whose Ghostty app was superseded but
   whose pane is a live orphan is a related case to handle in the running-liveness
   path (out of scope for "smallest safe fix"; same predicate applies).
4. **Optional grouping move:** route superseded terminal lanes to **History**
   rather than leaving them in their plain terminal bucket, once the generation
   source is trustworthy.

---

## 7. Remaining config / mirroring risks (not in scope here)

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

---

## 8. Addendum (2026-06-16) — verification & provenance corrections

Authored under follow-up task `cc-generation-source-and-verification-cleanup-20260616`
in response to the review of this work. The review found **no feature blockers**;
these are honesty/precision corrections plus a note that the dormant guard is now
wired. Nothing below changes the predecessor's runtime behavior.

1. **Two-commit provenance (was implied to be one).** The work shipped in **two**
   commits, not one. §2's change list is the *cumulative* set:
   - `eb28320d fix(agent-status): surface terminal-but-alive lanes as live attention required`
     — the `classifyLifecycleConflict` third-arg + `session_live`/`team_requested`
     fields + grouping/badge + the first tranche of tests. **This** is the commit
     that touched `src/providers/agent-task-classification.ts` (the §2 attribution
     of the classifier change to that file is correct, but the change landed here,
     not in `56709213`).
   - `56709213 feat(agent-status): guard stale pre-reset Ghostty apps …` — the
     release-hygiene guard (`release_generation`, `isSupersededByReleaseReset`,
     the `getCurrentReleaseGeneration()` seam, `effectiveLauncherSessionLive`) +
     §6 + the remaining tests. Its stat touched **only** the provider, the test
     file, and this handoff — **not** `agent-task-classification.ts`.

2. **Test count.** §2 originally said "(new, 19 tests)". The file actually held
   **27 tests** after both commits (fixed inline above). The follow-up adds 12
   more (→ **39**); see the 2026-06-16 handoff.

3. **Verification-claim scope.** §3's broad `just test` / `just check` /
   `bun run build` numbers were produced in the author's **main checkout with deps
   installed**. They are **not** reproducible in a fresh isolated worktree lacking
   `bun install` + matching `@types/vscode` — which is why the review's isolated
   re-run could only confirm the **focused** test. §3 now labels each line with its
   environment; the focused-test line is the portable evidence.

4. **Release-hygiene one-liner — corrected scope.** The predecessor commit
   message said "No production behavior change until a current-generation source
   is wired," and §6 called the guard a "gated no-op today." Precise restatement:
   the guard was **inert only because no current-generation source existed**, and
   it has **always applied solely to the terminal-status lifecycle-conflict path**
   (a `running`-status lane whose Ghostty app was superseded is still unguarded —
   §6 follow-up #3). The 2026-06-16 follow-up wires the source (launcher
   `release-generation.json` baseline via `OSTE_RELEASE_GENERATION_FILE` /
   `commandCentral.releaseGeneration.file`), so the guard now **activates when
   that baseline is present**, while keeping the same terminal-path-only scope.

5. **Schema correction (the launcher's real field is `app_stamp`, not a string).**
   §2/§6 modeled the per-lane marker as a single string `release_generation`
   (alias `source_version`). The launcher's accepted
   `scripts/oste-terminal-generation.sh` actually stamps an **`app_stamp` object**
   (`launcher_version`, `git_sha`, `rc_version`, `template_generation`) and writes
   a `release-generation.json` baseline of the same shape. The follow-up makes CC
   compatible with both shapes (object preferred, string fallback) via
   `canonicalGenerationToken()`. Full schema + contract in the 2026-06-16 handoff.
