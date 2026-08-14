# Symphony / Codex Runs Dogfood — Team Lane Findings

**Task ID:** `cc-symphony-dogfood-team-20260509-1229`
**Date:** 2026-05-09
**Repo:** `command-central`
**Lane mode:** Agent Teams dogfood (read-only investigation, single-artifact deliverable).
**Companion lane:** `cc-node-host-context-fix-20260509-1229` (focused fix; do not race).

---

## 1. Hub-mirror vs node-local presentation under Symphony / Codex Runs

### The classification pipeline

All hub-mirror / node-local routing decisions for a task flow through three functions in
`src/providers/agent-status-tree-provider.ts`:

**`hasNodeExecutionMetadata(task)`** — lines 584–593  
Determines whether a task carries any explicit node/remote execution metadata:
- `exec_node` or `exec_host` is non-empty (launcher-declared host label)
- `exec_mode` is `"spoke"`, `"node"`, or `"remote"` (explicit mode field)
- `exec_cwd` starts with `/Users/ostehost/` — a hardcoded path heuristic (fragile; see
  principled model below)

Note: `exec_mode="hub"` is **not** in the listed values at lines 585–592. A task
running in hub mode (exec_mode="hub") relies solely on exec_host/exec_node for detection,
which is correct but subtle — the omission of "hub" from the exec_mode match list is a
latent legibility risk.

**`isPathUnderLocalHome(value)`** — lines 615–626  
Checks whether a path falls under the current host's home directory. Critically, since
commit `f37f354a`, the implementation uses `__localHomeOverrideForTests ?? os.homedir()`,
giving tests the seam they need to simulate hub context without modifying production logic.

**`isRemoteNodeTaskForCurrentHost(task)`** — lines 628–634 (exported)  
The authoritative gate:
```
if (!hasNodeExecutionMetadata(task))           → false  (no remote metadata)
else if exec_cwd OR project_dir under home     → false  (task is local here)
else                                           → true   (task is hub-mirror/node-remote)
```

### What the gate drives

| Gate result | UI behavior | Source |
|---|---|---|
| `true` (remote) | `shortTag: "node · visible"` in description | tree-provider.ts:639 |
| `true` (remote) | QuickPick copy-command via `showRemoteNodeTaskSurfaceOptions` | extension.ts:1351–1414 |
| `true` (remote) | Live probe suppressed (tmux, liveness, commit evidence) | tree-provider.ts:1523, 1632, 1691, 1852 |
| `false` (local) | Interactive focus/resume, terminal attach | extension.ts:1524–1537 |

`classifyTaskSurface` (tree-provider.ts:624–688) returns `kind: "node-launcher-bundle"` /
`shortTag: "node · visible"` only when `isRemoteNodeTaskForCurrentHost` returns `true` AND
`hasLauncherBundle` is true (tree-provider.ts:635–640). The description assembly at lines
7125–7132 pushes `shortTag` only when it is non-null and the task is running:
```ts
if (task.status === "running" && surfaceSummary.shortTag) {
  descriptionParts.push(surfaceSummary.shortTag);
}
```

The `CodexRunObserverService` does **not** re-run `isRemoteNodeTaskForCurrentHost`; it
projects launcher-declared fields directly (`execMode`, `execNodeId`, `execNodeName`,
`host`) via `projectLauncherTask()` at `codex-run-observer-service.ts:232–245`. Remote/local
UI decisions belong to the tree provider and extension.ts, not the observer.

### Principled model: path is not provenance

The current path-locality heuristic works correctly on each individual machine but is not
portable across machines, not derivable from the task alone, and not stable as home
directories diverge. The correct model:

1. **Trust `exec_mode` first.** `exec_mode = "spoke"` is an explicit, launcher-declared
   statement that the task is running on a spoke node. It is unambiguous regardless of
   which host CC is running on. This field should be the primary gate, not the secondary
   heuristic.

2. **Use `exec_host` / `exec_node` as the display identity and routing key.** These fields
   name the machine and should appear in the tree item detail row and tooltip (`"Mike's
   MacBook Pro"` in the tooltip, `"node · visible"` in the description). The tooltip
   structure at lines 694–696 already references these fields — the problem is the gate
   doesn't reach them.

3. **Keep the path-under-home check as a local-confirmation heuristic only**, and only for
   tasks that lack explicit `exec_mode` / `exec_host`. The hardcoded `/Users/ostehost/`
   path at tree-provider.ts:591 should be replaced with a general `os.homedir()` comparison
   or removed in favor of explicit fields. The current form is intentionally developer-
   scoped (unverified whether this is permanent or transitional).

4. **Tests must be fixture-driven and host-context-pinned.** Any test asserting remote
   behavior must invoke `__setLocalHomeOverrideForTests("/Users/hub-test-home")` in a
   `beforeEach`. Any test asserting local behavior either uses the override pinned to the
   real home or relies on the default `os.homedir()`. Never mix these without the seam.

5. **Observer remains a pure projection.** `CodexRunObserverService.project(inputs)` is a
   pure function receiving caller-supplied data. It must never acquire live process state
   or make routing decisions. Remote/local routing stays in the tree provider.

6. **CC's authority boundary for team lanes.** If routing a Codex Run action requires
   knowing which machine the agent is on and sending a command to that machine, that is a
   scheduler/dispatcher action — not a visibility action. The `showRemoteNodeTaskSurfaceOptions`
   copy-command pattern (extension.ts:1351) is the correct boundary: CC surfaces the command,
   the operator runs it on the correct machine. This boundary must not move.

---

## 2. Are the two node-side failures test-context, product behavior, or both?

### Position: primarily a test-context problem

**The product behavior is correct.** On Mike's MacBook Pro, a task with
`exec_cwd: "/Users/ostehost/projects/command-central"` IS under `os.homedir()`, so
`isRemoteNodeTaskForCurrentHost` correctly returns `false`. CC focusably routes it. On the
hub (home = `/Users/ostemini` or similar), the same path is NOT under home, so
`isRemoteNodeTaskForCurrentHost` correctly returns `true`. CC copy-command routes it. Both
behaviors are right for their respective hosts. The logic should not change.

**The tests are wrong** because they assert remote behavior (expecting `"node · visible"`)
while running on a machine where the fixture paths look local. The seam to fix this —
`__setLocalHomeOverrideForTests` — was added in commit `f37f354a` and is already imported
in the rendering test file (tester evidence, line 11 of test file). It is simply never
called within the `"surface clarity"` describe block.

### The two confirmed failures (rendering test file)

| # | File | Line | Assertion | Received |
|---|---|---|---|---|
| 1 | `test/tree-view/agent-status-tree-provider-rendering.test.ts` | 692 | `item.description` contains `"node · visible"` | `"My App"` |
| 2 | `test/tree-view/agent-status-tree-provider-rendering.test.ts` | 713 | `item.description` contains `"node · visible"` | `"My App"` |

Both tasks have:
- `exec_cwd` / `project_dir` under `/Users/ostehost/` — local on MacBook, but the test
  intends to simulate a hub observer
- `hasLauncherBundle = true` (Ghostty bundle paths present in fixture)
- `status: "running"`

Because no home override is set, `isPathUnderLocalHome` resolves against the real
`os.homedir()`, finds a match, and `isRemoteNodeTaskForCurrentHost` returns `false`.
`classifyTaskSurface` then lands on `kind: "launcher-bundle"` / `shortTag: null`
(tree-provider.ts:648–653), and the description assembly pushes nothing — hence `"My App"`.

Secondary assertions at lines 694–696 (tooltip containing `"Mike's MacBook Pro"`,
`"focus must execute on that node"`, `"visible=yes"`) are not reached; the test fails on
line 692 first.

### Three additional failures (outside the fix lane's declared scope)

The researcher additionally identified three tests failing with the **same root cause** that
are NOT in the file the fix lane targeted:

| File | Lines | Test description |
|---|---|---|
| `test/extension-commands.test.ts` | 168 | "node-hosted task is detected before hub-local focus strategies" |
| `test/extension-commands.test.ts` | 186 | "mirrored node task is detected even when launcher persisted exec_mode=hub" |
| `test/health.test.ts` | 458 | "does not probe tmux for mirrored node tasks on the hub" |

These are marked **(unverified)** as failing at publication time of this artifact because
they are researcher-identified but not directly reproduced by the tester's run (the tester's
run covered only the rendering and openclaw-task-nodes test files). The researcher's analysis
(notes A3) identifies the same fix pattern: `__setLocalHomeOverrideForTests("/Users/hub-test-home")`
in `beforeEach` + `null` teardown in `afterEach`.

The fix lane brief said "two node-side failures" but the full surface is five tests across
three files. This is called out for Oste in section 4.

### Recommended seam boundary

The fix is test-only: call the already-available override seam. No product code change is
needed or recommended. Specifically:

- **Do not add `"hub"` to the `exec_mode` match list in `hasNodeExecutionMetadata`** merely
  to make these tests pass — the fix would be symptom-chasing and would change product
  behavior for all hub tasks on all machines.
- **Do not remove the path-under-home check** from `isRemoteNodeTaskForCurrentHost` — it is
  the correct local-confirmation heuristic for tasks without explicit exec_mode/exec_host.
- **The seam (`__setLocalHomeOverrideForTests`) is the correct abstraction.** Tests that
  model hub context should use it. Tests that model node-local context should not.

The focused fix lane chose the right scope: fix the rendering test file by adding
`beforeEach(() => __setLocalHomeOverrideForTests("/Users/hub-test-home"))`. The fix for
the remaining three tests is mechanically identical and should be threaded in a follow-on
task (see section 4).

---

## 3. Process improvements for launched team lanes

### Evidence the orchestrator must check before declaring a lane complete

The exec receipts and fix-lane pending-review receipt (researcher notes B1) surface seven
mandatory checks. Numbered here with whether the current lane process satisfies each:

1. **Pending-review receipt exists and is non-empty**  
   Path: `/tmp/oste-pending-review/<task_id>.json`. The fix lane wrote this receipt correctly
   with `completed_at`, `last_commit`, `files_changed`. ✓ for this lane; add to harness.

2. **`status` in receipt is NOT `contract_failure` — even on exit 0**  
   The fix lane's receipt shows `"status": "contract_failure"`. The agent declared it could
   not fulfill the contract and stood down. The orchestrator currently does not treat
   `contract_failure` as incomplete when `exit_code: 0`. **This is a harness gap.** A lane
   that exits 0 with `contract_failure` must be re-queued or escalated, not silently marked
   complete. The fix lane's `agent_summary`: "Standing down. Task #4 is back to pending.
   I'll wait for the team-lead's explicit go signal." — the agent did the right thing; the
   orchestrator did not.

3. **Declared artifact paths exist on disk and are non-empty**  
   Both exec receipts declare `"artifact_paths"` lists. The orchestrator should run
   `test -s <path>` for each declared artifact before marking a lane complete. A lane that
   declares `research/REVIEW-*.md` but exits before writing it has not fulfilled its contract.

4. **A conventional commit was made (no `--no-verify`)**  
   Fix lane: commit `f37f354a` ("test(agent-status): deterministic hub-vs-node host context
   for surface tests"). Conventional format confirmed. No `--no-verify` confirmed. The
   orchestrator should verify commit SHA is present in the receipt.

5. **Tests named in the brief must pass**  
   The fix lane brief named: `bun test test/tree-view/agent-status-tree-provider-rendering.test.ts
   test/tree-view/openclaw-task-nodes.test.ts`. Both now pass per the fix lane's work.
   However, three additional failures (extension-commands.test.ts, health.test.ts) were not
   named in the brief and were not fixed. The orchestrator must check whether the brief's
   test list is exhaustive or indicative — currently there is no machine-readable contract
   distinguishing the two.

6. **No overlap with parallel lanes (by task_id / flow_id, not session_id)**  
   Both current lanes share `session_id: "agent-command-central"` in exec receipts. The
   observer spec explicitly warns that launcher session IDs such as `"agent-command-central"`
   are not unique run identities by themselves (HANDOFF-codex-run-observer-mvp). The
   orchestrator must use `task_id` + `flow_id` as the lane-separation key, not `session_id`.

7. **`reviewed: false` in receipt is an advisory, not a blocker**  
   A lane's pending-review receipt having `reviewed: false` does not block the orchestrator's
   completion check. But it signals that human review has not yet occurred. The orchestrator
   completing a lane ≠ Oste approving the lane's output.

### Mandatory lane artifacts

| Artifact | Path pattern | Written by | Verified in current lanes? |
|---|---|---|---|
| Exec receipt | `/tmp/oste-exec-receipt-<task_id>` | `oste-spawn.sh` before agent starts | ✓ both lanes |
| Pending review receipt | `/tmp/oste-pending-review/<task_id>.json` | `oste-complete.sh` on agent exit | ✓ fix lane; dogfood TBD |
| Completion marker | `/tmp/oste-complete-<task_id>` | `oste-complete.sh` on success | unverified |
| Research/handoff artifact | `research/<ARTIFACT>.md` | Agent during work | fix lane: gap; dogfood: this file |
| `reviewed` flag flip | In pending review receipt | Human reviewer (`oste-review.sh`) | pending |

### How CC could surface team / lead / subagent state without becoming the scheduler

The exec receipts already carry all fields needed for automatic projection:
```json
{
  "flow_id": "cc-symphony-dogfood-team-20260509-1229",
  "task_id": "cc-node-host-context-fix-20260509-1229",
  "source_authority": "launcher",
  "owner_kind": "launcher",
  "workflow_run": { ... },
  "owner_actions": [ ... ]
}
```

`isSourceOwnedLauncherRun` (codex-run-observer-service.ts:546) already accepts rows with
`source_authority: "launcher"`, `owner_kind: "launcher"`, and `workflow_run` as standalone
Codex Runs. If the launcher writes these fields into `tasks.json`, CC projects them today
with zero product change.

The correct model for team workstream visibility:

1. **The team's `flow_id` maps to a TaskFlow workstream.** The orchestrator writes a
   TaskFlow record for `cc-symphony-dogfood-team-20260509-1229` with child task IDs for
   each lane. CC's `joinTaskFlow` / `projectTaskFlowChild` at codex-run-observer-service.ts
   lines 287–301 already handles parent/child projection.

2. **Each lane is an `AgentTask` with `flow_id` set.** Launcher writes the lane's task into
   `tasks.json` with `flow_id`, `task_id`, `source_authority: "launcher"`, `owner_kind`.

3. **CC does not understand "team-lead" vs "researcher" vs "tester" roles.** Those are
   launcher-level role tags that can appear in `owner_kind` or task labels. CC renders the
   label; it does not interpret the role.

4. **CC's read-only boundary is absolute.** `CodexRunObserverService.project()` remains a
   pure function. CC never writes to `tasks.json`, TaskFlow records, or OpenClaw state. CC
   routes source-owned actions via owner envelopes; it does not execute them. Team
   membership, lane dispatch, re-queuing, retry: all belong to the launcher, not CC.

### What stays in OpenClaw / TaskFlow / Launcher (the authority boundary)

- Lifecycle ownership: create, claim, dispatch, retry, cancel, complete
- Session identity: `session_id` assignment and uniqueness
- Role assignment: which agent is team-lead, which is worker
- Re-queue on `contract_failure`: the orchestrator must detect and re-dispatch
- Hub/node routing decisions that require sending commands to remote machines
- Retry/reconcile: the PLAN Stop Conditions (lines 309–316) are explicit: CC must not
  claim or dispatch work, retry lifecycle, or write OpenClaw/TaskFlow/launcher task state.

### Risks of CC acquiring scheduling behavior

Five risks, sourced from researcher notes B4 and PLAN Stop Conditions:

1. **Split lifecycle authority.** If CC owns team dispatch state while the Launcher owns
   lane state, status disagreements have no clear resolver. The observer's `sourceStatus` +
   `status` disagreement display becomes worthless.

2. **Session collision propagation.** Both exec receipts share `session_id: "agent-command-central"`.
   If CC tried to schedule lanes by session_id, it could not distinguish them. The observer
   spec already warns this is not a unique join key. Re-queuing or dispatching the wrong
   lane is the concrete failure mode.

3. **Hub/node routing confusion.** Teams on spoke nodes have their actual processes on the
   node. CC on the hub cannot dispatch to the node without a shell-out — which violates the
   authority boundary and the Five Commandments.

4. **Test non-determinism.** Any CC-side scheduling state would make tree-provider tests
   depend on live process state, destroying the `CodexRunObserverService.project(inputs)`
   pure-function contract that makes the suite deterministic.

5. **Scope creep cascade.** PLAN Phase 5 goal: "make Symphony/TaskFlow the normal way Oste
   and Mike inspect orchestrated work." CC acquiring scheduling adds an unspecified Phase N
   before Phase 5 stabilizes, delaying the dogfood loop that validates the read model.

---

## 4. Recommendation for Oste after reviewing the focused fix lane

The fix lane (`cc-node-host-context-fix-20260509-1229`) correctly identified and fixed the
root cause in the rendering test file (commit `f37f354a`). It did not complete its full
contract (receipt shows `contract_failure`; three additional tests remain failing). Here is
the ordered next-step list:

### (a) Merge the fix lane after reviewer pass

The rendering test fix in `f37f354a` is correct and safe. `isRemoteNodeTaskForCurrentHost`
logic is unchanged; only test context is fixed via the existing seam. Review and merge when
the reviewer (task #4) passes it.

Cross-lane risk: this dogfood lane is read-only and does not race with the fix lane on any
file. Merge can proceed independently.

### (b) Extend the host-context override to the three remaining failing tests

The following tests are failing with the same root cause as the two confirmed failures
(unverified at artifact publication time — researcher-identified, not tester-confirmed):

- `test/extension-commands.test.ts:168` — "node-hosted task is detected before hub-local
  focus strategies"
- `test/extension-commands.test.ts:186` — "mirrored node task is detected even when
  launcher persisted exec_mode=hub"
- `test/health.test.ts:458` — "does not probe tmux for mirrored node tasks on the hub"

Fix pattern is identical to the rendering fix: import `__setLocalHomeOverrideForTests`
(already available since `f37f354a`) and wrap each hub-context test in `beforeEach(() =>
__setLocalHomeOverrideForTests("/Users/hub-test-home"))` with matching `afterEach(() =>
__setLocalHomeOverrideForTests(null))`. No product code change needed.

This should be a separate task (not re-opened on the fix lane), since the fix lane brief
did not list these files and the lane's `contract_failure` state means re-dispatching it
would need a clean brief.

### (c) Thread session_id distinctness as a launcher contract bug — not a CC issue

The shared `session_id: "agent-command-central"` across both exec receipts is a launcher
harness issue, not a CC product issue. CC's observer already handles this correctly by
joining on `task_id` + `flow_id`, not `session_id` alone. The fix belongs in the launcher
repo (or `oste-spawn.sh`): each lane must receive a session_id unique to that lane invocation
(e.g., `agent-command-central-<task_id>` or a UUID). File a contract bug against the
launcher, not against CC.

### (d) Start Phase 1 Projection Truth Hardening from the integration plan

The dogfood run validates that CC's current read model (observer + tree provider) is
structurally correct for team workstreams. The exec receipt fields already match what
`isSourceOwnedLauncherRun` expects. The next step per PLAN-symphony-progressive-integration
is Phase 1: harden the projection truth — specifically:

- Replace the hardcoded `/Users/ostehost/` heuristic in `hasNodeExecutionMetadata`
  (tree-provider.ts:591) with a general `os.homedir()`-relative check. The heuristic works
  today but will silently mis-classify tasks when run under a different local home prefix.
- Add `exec_mode = "spoke"` as a sufficient condition for remote classification, independent
  of the path check, so that launcher-declared spoke tasks are never ambiguous.
- Verify that `CodexRunView.execMode` / `.host` / `.execNodeName` (projected at
  codex-run-observer-service.ts:232–245) are surfaced in the Codex Runs detail row. They
  are projected but their UI rendering path should be confirmed in a smoke test or fixture.

### Cross-lane risks to watch

- The fix lane's `contract_failure` status means the companion lane's reviewer (task #4)
  may not have a complete research artifact to review if the fix lane did not write its
  own research file. Verify `research/REVIEW-cc-node-host-context-fix-20260509-1229.md`
  exists and is non-empty before scheduling the reviewer.
- The `contract_failure`-on-exit-0 harness gap (section 3) means any future lane that
  stands down early will silently appear complete to the orchestrator. This should be
  patched in `oste-complete.sh` before launching additional team lanes.

---

## Reviewer notes

_Section populated by task #4 reviewer after reviewing this draft._

- [ ] Section 1 principled model is accurate against current source
- [ ] Section 2 position and file:line references are correct
- [ ] Section 3 process improvement list is actionable
- [ ] Section 4 recommendations are scoped correctly (launcher vs CC vs test-only)
- [ ] No fabricated file paths or test names present
- [ ] Last line is exactly `TEAM DOGFOOD COMPLETE`

TEAM DOGFOOD COMPLETE
