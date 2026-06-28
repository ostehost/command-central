# DESIGN v2 — `paused` lane lifecycle (native, receipt-free operator path)

- **Date:** 2026-06-28
- **Status:** DESIGN ONLY — not implemented. Supersedes `DESIGN-paused-lane-lifecycle-2026-06-28.md` (v1). Every change vs v1 is traceable to a correction in `CORRECTIONS-paused-lane-lifecycle-2026-06-28.md` (cited inline as `[C#]`).
- **Repos:** `command-central` (consumer) + `ghostty-launcher` (producer).
- **Trigger:** Two lanes (`manual-PAR-319-native-workroom`, `manual-PAR-229-sync-readiness`) show **Live · running** in Agent Status after being told to "pause" in chat, because a chat-pause emits no machine-readable lifecycle signal and the `claude` process stays alive.

---

## 0. What changed from v1 (one-paragraph delta)

v1 threaded `paused` through the pending-review **receipt → overlay** channel. That channel is a *completion/exit* artifact, and the real code resists carrying a non-terminal "alive-but-parked" state: the overlay applier force-stamps `completed_at` `[C6]`, the blessed writer can't express `exit_code:null` `[C7]`, and three launcher mechanisms (reaper, 6h quarantine, review watchdog) mutate or evict the receipt `[C10][C11]`. **v2's operator path writes `tasks.json status=paused` directly — the real `oste-kill.sh` pattern — and emits no receipt `[C0]`.** CC already trusts a non-`running` `tasks.json` status by direct passthrough (`toDisplayTask` only probes a receipt when `status === "running"`, `agent-status-tree-provider.ts:2279`), and every reaper scan gates on `status == "running"`, so a paused row is auto-excluded from reaping for free. This dissolves three of the four v1 blockers outright (C1 via the allow-lists, C10/C11 for free); the fourth — clearing a paused row on relaunch (C12) — is **not** automatic and is handled by an explicit **kill-to-clear** step (§7/§11). The remaining work is honest status-vocabulary plumbing (allow-lists, formatters, both section classifiers), a defined kill/relaunch/idempotency lifecycle, and an explicitly-optional, cooperating-agent-only, claude-only self-pause path.

> **Correction to an earlier v2 claim (re-verified by the implementation team):** an earlier draft said the no-receipt path makes relaunch "clear paused for free." That is **false** — `oste-spawn` auto-generates a new `task_id` by default (`oste-spawn.sh:108`), and §11 relaunches as a *new* issue-scoped lane, so the old paused row orphans unless explicitly killed. The lifecycle below reflects the corrected **kill-to-clear** model.

---

## 1. Problem & root cause (unchanged from v1, corrected framing)

Telling an agent to pause in chat produces **no machine-readable signal**. The agent complies, goes idle, and holds the `claude` CLI open; the registry stays `running`; no exit hook fires; the lanes are detached (no `session_key`/`callback_url`). The only liveness signal — *is the process alive?* — still answers **yes**, so Command Central honestly shows the lane **Live** (`agent-status-tree-provider.ts:2342-2352`: demote only when "positively confirmed dead"). **CC is not buggy.** What is missing is a *stop/pause signal independent of process exit*, plus a first-class **`paused`** state distinct from `stopped`/`killed` (dead) and `completed*` (finished).

Honesty corollary carried into the design: because `paused` may sit on a *dead* process (the CLI later exits while parked), the label — not the status — must stay honest about liveness `[C16]` (see §6).

---

## 2. Channel decision (the native core)

| Mechanism | Verdict | Why |
|---|---|---|
| **Direct `tasks.json status=paused` write** (operator path) | ✓ **Native primary** | Exact `oste-kill.sh` `update_task_status` pattern (`oste-kill.sh:90-117`); CC passthrough-trusts non-`running` statuses (`provider:2279`); reaper scans skip non-`running` rows (`reaper.sh:455,485,781,923`) → reaper-safe with no extra code `[C0][C10]`. |
| Pending-review **receipt → overlay** | ✗ Wrong channel for paused | Completion/exit artifact: overlay stamps `completed_at` `[C6]`; writer can't emit `exit_code:null` `[C7]`; quarantine/watchdog mutate it `[C11]`. Reused **only** by completion/kill, never by paused. |
| ACP cancel | ✗ Kills, doesn't park | `cancelTask` terminates (`acp-session-service.ts:108-110`); no pause state; these lanes are bare `claude`, not `acpx`. |
| Claude Code native pause hook | ✗ Does not exist | Zero hooks fire on "pause, don't exit." |
| Staleness/idle inference, transcript parsing | ✗ Anti-pattern | Fragile; explicitly rejected (§9). |

**Native verdict per entry point:** operator path = **NATIVE** (direct status write, backend-neutral). Agent self-pause path = **ACCEPTABLE, COOPERATING-AGENT-ONLY, CLAUDE-ONLY** convenience, scoped honestly (§5) — it does *not* solve the uncooperative case, which is why the operator path is primary `[C17][C19]`.

---

## 3. Status semantics

Add `"paused"` to `AgentTaskStatus` (`src/types/agent-task.ts:22-30`) **and to both runtime allow-lists** (`agent-status-tree-provider.ts:425-434` + `agent-task-normalize.ts:20-29`) — without the allow-lists, a `paused` row is coerced to `"stopped"` `[C1]`.

| Status | Meaning | Process | Bucket |
|---|---|---|---|
| `running` | actively working | alive | Live |
| **`paused`** | **intentionally parked, awaiting relaunch** | **may be alive or later dead** | **Needs Review (limbo)** |
| `stopped` / `killed` | terminated / dead | dead | Action |
| `completed*` | finished | dead | History/Review |

**Invariants.**
1. `paused` is **never auto-inferred** from staleness/idle.
2. `paused` **never auto-flips** to another *status*, and there is **no automatic `paused→running` relaunch transition**. Exits are **kill-to-clear** (operator abandons/supersedes → `killed`, the chosen mechanism) or an explicit **same-id retry respawn** (→ `running`). Relaunching the work as a *new* issue-scoped lane does **not** touch the paused row — the operator must explicitly kill it (§7/§11).
3. The *label* (not the status) reflects current liveness, so a dead parked lane is never mislabeled as in-place-resumable `[C16]`.
4. `paused` is the first **non-terminal** receipt-independent status. (Correcting v1: it is *not* "the only status that overrides the liveness gate" — completed/failed/stopped receipts already do via Tier 1b; paused's novelty is being non-terminal `[C22]`.)

---

## 4. Cross-repo touch points (accurate, verified at HEAD)

### command-central
| File:anchor | Change | Correction |
|---|---|---|
| `src/types/agent-task.ts:22-30` | add `"paused"` to `AgentTaskStatus` | — |
| `src/providers/agent-status-tree-provider.ts:425-434` **and** `src/providers/agent-task-normalize.ts:20-29` | add `"paused"` to **both** `VALID_TASK_STATUSES` sets (dedupe to one shared Set if cheap) | `[C1]` BLOCKER |
| `src/providers/agent-status-tree-provider.ts:4597-4709` (`getNodeStatusGroup`) | add `paused → "limbo"` before the `:4708` `attention` default; keep it **out** of the conflict block (`:4632-4659`) | `[C3]` |
| `src/utils/agent-task-classification.ts:424-432` (`CONFLICT_ELIGIBLE_STATUSES`) | **do not** add `paused` (would route paused-but-alive to Action) | `[C3]` |
| `src/providers/agent-status-formatters.ts:8,47,120` | add `case "paused"` to `getStatusThemeIcon`, `getStatusDisplayLabel`, `formatTaskElapsedDescription` (defaults at `:42/:55/:135` mis-render as `circle-outline`/raw/"Failed") | `[C2]` MAJOR |
| `src/utils/agent-status-sections.ts:90` | no change to the `limbo:"review"` map (v1-wired path already correct) | — |
| `src/utils/agent-status-sections.ts:208-209` (`sectionFromSignals`) | add `if (signals.status === "paused") return "review";` **above** the `livenessAlive` short-circuit (M3 forward-compat) | `[C4]` MAJOR |
| `src/providers/agent-status-tree-provider.ts:8238-8285` (`getSummaryIcon`) | add a paused/limbo branch so a paused-only scope shows needs-review, not the green check-all | `[C5]` |
| `package.json` | register `commandCentral.pauseAgent` (command + menu, sibling to `killAgent`) | — |
| `src/activation/register-agent-registry-commands.ts:189` | implement `pauseAgent` handler → spawns `oste-pause.sh`; **never** SIGTERM | — |
| Paused label rendering | render `pause_reason` if present on the row (default "awaiting relaunch"); split copy by liveness `[C16]` | §6 |

**Explicitly NOT touched** (vs v1, which required them): `pending-review-probe.ts` (`ReceiptOverlayStatus`, `receiptToOverlay`, `parseReceiptFile`) and `applyRuntimeStatusOverlay` — the operator path never produces a receipt or an overlay `[C0][C6][C7][C8]`.

### ghostty-launcher
| File:anchor | Change | Correction |
|---|---|---|
| `scripts/oste-pause.sh` (NEW) | thin peer of `oste-kill.sh`: source `tasks-lock.sh` + `prompt-detection.sh`; `lock_tasks` (trap `unlock_tasks`); verify pane at-prompt via `_terminal_at_prompt` and **refuse/warn if working** `[C13]`; compare-and-swap (refuse over a terminal status) `[C14]`; atomic `jq '.tasks[$id].status="paused"` (+ optional `paused_at`/`pause_reason` row metadata); **never kill** | `[C0][C13][C14]` |
| `scripts/oste-spawn.sh` (`_session_is_completed`, `:640-642`) | **no change required** under kill-to-clear (operator kills first → `killed` is already reuse-eligible). Optional hardening only: add `paused` if direct same-id relaunch-from-paused is ever wanted | `[C12]` |
| `scripts/oste-spawn.sh:864-879` (`clear_task_runtime_artifacts`) | no receipt to clear in the operator path; if Entry A self-pause writes any marker, delete it here on same-id respawn | `[C12][C18]` |
| `scripts/oste-kill.sh:90-117` | **kill-to-clear** — kill on a paused lane already works (`update_task_status` any→`killed`); no dangling artifact since no receipt. This is the relaunch-clearing mechanism | `[C12][C15]` |
| `scripts/lib/oste-stop-hook.sh` (Entry A, optional) | claude-only self-pause: insert a `TASK PAUSED` final-message predicate (symmetric to `_final_message_contract_ready` `:205-240`) **after** the guards (`~:388`), **before** the `.oste-report.yaml` path (`:433`) and artifact finalize (`:506`); it writes `tasks.json status=paused` (off `running`) and **no** `oste-complete.sh` call | `[C17][C18][C19][C20][C21]` |
| `just sync-launcher` | sync bundled launcher resources into `command-central/resources/bin/` before any CC release | §7 |

---

## 5. Two entry points

### A. Operator-initiated — `commandCentral.pauseAgent` + `oste-pause.sh` (PRIMARY)
Sibling to `killAgent` (`register-agent-registry-commands.ts:189`). The command spawns `oste-pause.sh <task_id>`, which — under `lock_tasks`, after confirming the pane is idle — atomically sets `tasks.json status=paused` and **never kills the process**, then `reload()`s the tree. Works for **any** backend (claude/codex/gemini) and **without** agent cooperation — this is what clears par319/par229 immediately. Mis-fire safety: refuses (or warns) if the pane shows active work `[C13]`; idempotent (a second pause is a no-op compare-and-swap) `[C14]`.

### B. Agent-initiated self-pause — Stop-hook `TASK PAUSED` predicate (OPTIONAL FAST-FOLLOW)
**Scope, stated honestly:** claude-only (codex/gemini materialize no per-turn hook — `oste-spawn.sh:1539`) `[C19]`, and only for a **cooperating** agent `[C17]`. It does **not** catch an uncooperative or unaware pause — that is the operator path's job. Mechanism: the agent ends its final turn with a `TASK PAUSED` sentinel line (chat, not a file — honoring "do not edit files" `[C21]`); the Stop hook detects it via a predicate symmetric to the existing `_final_message_contract_ready` (`oste-stop-hook.sh:205-240`), inserted before the completion paths, and writes `tasks.json status=paused`. Writing the *status* (not a receipt) disarms the per-turn finalize predicates (all gated on `status=="running"`) on later turns, eliminating v1's flap/re-pause loop `[C18]`. **Defer to v2-fast-follow; v1 ships Entry A only if the predicate + cleanup are fully specified** (open decision #2).

---

## 6. Honesty: dead-but-paused labeling

The no-auto-flip invariant means a parked lane that *later dies* keeps `status=paused`. To avoid claiming impossible in-place resumption `[C16]`, the **renderer** (not the status machine) splits the label using the existing liveness probe:
- process alive → **"Paused · parked"**
- process confirmed dead (`isTaskSessionConfirmedDead`, `provider:2352`) → **"Paused · ended — relaunch as new lane"**

Status stays `paused` in both cases (invariant preserved); only the human-facing copy changes. No auto-transition is introduced.

---

## 7. Lifecycle / transition table

| From | Event | Mechanism | `tasks.json` | Receipt | Process | Resulting bucket |
|---|---|---|---|---|---|---|
| running | operator pause | `oste-pause.sh` (locked, at-prompt-checked) | `paused` | none | untouched (alive) | Needs Review · "parked" |
| running | agent self-pause (claude, cooperating) | Stop-hook predicate | `paused` | none | untouched (alive) | Needs Review · "parked" |
| running | kill | `oste-kill.sh` | `killed` | none | dead | Action |
| running | complete | `oste-complete.sh` | `completed*` | written | dead | History/Review |
| **paused** | **abandon + re-dispatch elsewhere** (the realistic path) | operator `oste-kill.sh` old lane → then dispatch a NEW issue-scoped lane | old row → `killed` | none | dead (old) | Action (old) + Live (new lane) |
| **paused** | **same-id retry respawn** (explicit `--task-id`) | `oste-spawn` reuse + `clear_task_runtime_artifacts` | `running` | none | new process | Live |
| **paused** | **kill** (no relaunch) | `oste-kill.sh` (`update_task_status` any→killed) | `killed` | none | dead | Action |
| **paused** | **process dies, no operator action** | none (no auto-flip); render-time label split `[C16]` | `paused` | none | dead | Needs Review · "ended" |
| **paused** | **pause again** | `oste-pause.sh` compare-and-swap | `paused` (no-op) | none | untouched | Needs Review |

**There is no automatic `paused→running` "relaunch" transition `[C12]`.** Because `oste-spawn` mints a new `task_id` by default (`oste-spawn.sh:108`) and §11 re-dispatches as a *new* lane, the old paused row is never overwritten — it orphans unless explicitly killed. **Kill-to-clear** is the chosen mechanism: the operator `oste-kill.sh`s the old paused lane as the final step of re-dispatching (legitimate teardown of the now-defunct parked process — distinct from the "pause never kills" rule). The clear is an explicit, documented step, never assumed; skipping it leaves a zombie `paused` row (see test #7b).

---

## 8. Test matrix (rebuilt)

| # | Scenario | Expected |
|---|---|---|
| 1 | operator pause on a **live** lane | leaves Live → Needs Review (critical regression) |
| 2 | `tasks.json status:"paused"` through `normalizeTask` | **survives as `paused`**, not coerced to `stopped` `[C1]` |
| 3 | render a paused lane | label/icon/elapsed = "Paused …", **not "Failed"** `[C2]` |
| 4 | `getNodeStatusGroup("paused")` | returns `limbo`; `paused ∉ CONFLICT_ELIGIBLE_STATUSES` `[C3]` |
| 5 | `sectionFromSignals(status:paused, livenessAlive:true)` | returns `review`, not `live` (M3) `[C4]` |
| 6 | reaper run against a dead-process paused row | **stays paused** (not flipped) `[C10]` |
| 7 | **same-id retry respawn** of a paused lane (`--task-id <same>`) | `status→running`, renders Live; no stale paused `[C12]` |
| 7b | **abandon + re-dispatch as a NEW lane** (new `task_id`) | old paused row is explicitly killed (kill-to-clear) — assert it is **not** silently orphaned in Needs Review `[C12]` |
| 8 | kill-from-paused | `killed` → Action, no dangling state `[C15]` |
| 9 | `oste-pause.sh` on an **actively-working** lane (streaming/committing) | **refuses/warns**; lane not falsely paused `[C13]` |
| 10 | backend neutrality — operator path | works for claude/codex/gemini (≥2-backend fixtures); Entry A asserted claude-only `[C19]` |
| 11 | double-pause | second pause is a no-op; no flap `[C14]` |
| 12 | paused-only project rollup | `getSummaryIcon` shows needs-review, not green check-all `[C5]` |
| 13 | dead-but-paused label | renders "ended — relaunch as new lane" `[C16]` |
| 14 | slow-but-working lane (no pause command) | **never** auto-marked paused (no false positive) |

---

## 9. Guardrails (do NOT)

- ✗ Infer `paused` from staleness/idle.
- ✗ Parse transcripts for "PAUSED" text. (Entry A uses a deliberate final-message sentinel, not heuristic text scraping.)
- ✗ Write a pending-review **receipt** for the operator pause — `tasks.json` is the channel `[C0]`.
- ✗ Let `paused` auto-flip its **status** (relaunch/kill only); the *label* may reflect liveness `[C16]`.
- ✗ Add `paused` to `CONFLICT_ELIGIBLE_STATUSES` `[C3]`.
- ✗ Write `paused` without `lock_tasks` + compare-and-swap `[C14]`.
- ✗ Use ACP cancel (kills, doesn't park).
- ✗ Claim Entry A is backend-neutral or catches uncooperative pauses `[C17][C19]`.

---

## 10. Rollout

1. **v2.0 = operator path only** (Entry B). Land the §4 command-central plumbing + `oste-pause.sh` across both repos behind green gates (`just ready`, `just check`, the §8 matrix). This needs no receipt machinery and no agent cooperation.
2. **Order the cross-repo schema change** so the installed VSIX understands `paused` before the launcher can emit it (gate on the installed build, not the committed tree) `[C9]`.
3. **`just sync-launcher`**, then cut a fresh preview (`just cut-preview` / `just dist --prerelease`) and integration-test end-to-end: `oste-pause.sh` → `tasks.json=paused` → CC limbo/Needs Review, plus a **live** pause of a real lane confirming it demotes without dying. **Do not push/tag/publish/`--no-verify` without explicit approval** (CLAUDE.md cross-repo release rules).
4. **Clear par319/par229 via the fix path** (§11).
5. **v2.1 (optional)** — claude-only agent self-pause (Entry B above), only once the Stop-hook predicate + marker cleanup are fully specified and tested.

---

## 11. Clearing `par319` / `par229` (once v2.0 lands)

Two phases. **Pausing never kills** (owner's rule); the kill happens only at re-dispatch/abandon time, where tearing down the now-defunct parked process is the correct cleanup.

**Phase 1 — get them out of Live (process stays alive):**
```bash
# tree: right-click each lane → "Pause lane", or:
oste-pause.sh manual-PAR-319-native-workroom
oste-pause.sh manual-PAR-229-sync-readiness
```
Each row flips to `tasks.json status=paused` → leaves Live → **Needs Review · "Paused · parked"**, processes still alive.

**Phase 2 — re-dispatch properly, then kill-to-clear the old lanes:**
Relaunch the work through the **proper issue-scoped dispatch** (a *new* lane with a *new* `task_id` — not a manual lane; the original PAR-317/318 bypass the manager flagged). Because that new lane has a new id, it does **not** clear the old paused rows `[C12]` — so kill them explicitly as the final step:
```bash
oste-kill.sh manual-PAR-319-native-workroom   # paused → killed → Action
oste-kill.sh manual-PAR-229-sync-readiness
```
This tears down the defunct parked processes and removes the rows from Needs Review. **Skipping Phase 2's kill leaves zombie `paused` rows.**

---

## 12. Open owner decisions

1. **`pause_reason` carrier.** Optional `pause_reason`/`paused_at` as additive fields on the `tasks.json` row (read by the label renderer), or label from `status` alone with a static "awaiting relaunch"? (v2 assumes the former, additive + optional.)
2. **Entry A scope for v2.0.** Ship operator-only (recommended) and fast-follow the claude-only self-pause, or bundle both? (Bundling adds the Stop-hook predicate + marker-cleanup surface; operator-only clears the two lanes today.)
3. **Dead-but-paused auto-transition.** Keep the *label-only* honesty split (§6, recommended — preserves the invariant), or allow exactly one gated `paused→stopped` auto-transition on `isTaskSessionConfirmedDead`? (v2 chooses label-only.)
4. **RESOLVED — relaunch clearing = kill-to-clear.** The operator explicitly kills the old paused lane when re-dispatching (§7/§11). No automatic `paused→running` relaunch transition; **no `_session_is_completed` change required** (kill first → `killed` is already reuse-eligible). v2's original "relaunch clears for free" was wrong (`oste-spawn` auto-generates a new `task_id`, `oste-spawn.sh:108`) — see `[C12]`. (Open sub-question only if a true *in-place resume* workflow is ever wanted: kill-to-clear buckets as `killed`→Action, which reads "terminated" rather than "superseded"; at that point add an explicit dismiss/archive→History — not for v1.)

---

## Appendix — provenance

Built from `CORRECTIONS-paused-lane-lifecycle-2026-06-28.md` (59 confirmed findings, 0 refuted, 6-lens adversarial review). Every `[C#]` tag above maps to a correction there. Load-bearing anchors (`provider:2279/2352/2387`, `VALID_TASK_STATUSES`, `pending-review.sh:380`, `oste-kill.sh:90-117`, `reaper.sh` `running` gates, `oste-stop-hook.sh:205-240/433/506`) were hand-verified at HEAD.
