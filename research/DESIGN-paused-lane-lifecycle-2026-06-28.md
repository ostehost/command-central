# DESIGN — `paused` lane lifecycle (stop-signal control-plane gap)

- **Date:** 2026-06-28
- **Status:** DESIGN ONLY — not implemented. Dispatch through the proper issue-scoped path (Linear/Symphony), not a manual lane.
- **Repos:** `command-central` (consumer) + `ghostty-launcher` (producer)
- **Trigger:** Two lanes (`manual-PAR-319-native-workroom`, `manual-PAR-229-sync-readiness`) showed as **Live · running** in Agent Status despite being told to "stop/pause" in chat.

---

## 1. Problem statement (root cause)

"Stopping" an agent by **telling it to pause in chat** produces **no machine-readable lifecycle signal anywhere**.

Observed sequence for both lanes:

1. Operator/manager told each agent *"Pause immediately… do not edit files… do not exit… await relaunch."*
2. The agents complied **correctly** — they went idle and **held the `claude` CLI process open** (`par319` PID 88204, `par229` PID 53275 confirmed alive at investigation time).
3. That "stop" was a **conversational instruction**. It never reached the task registry, a receipt, or Command Central. The only machine-readable liveness signal — *is the process alive?* — still answers **yes**.
4. Registry stays `status: running`. No `oste-complete.sh` fires (it triggers on **exit**, not idle). Both lanes are **detached** (no `session_key` / `callback_url`), so there is no callback channel either.

**Command Central is behaving exactly as designed and is NOT buggy.** `agent-status-tree-provider.ts:2352` deliberately refuses to demote a `running` lane unless its session is *positively confirmed dead* (`research/RESULT-cc-current-running-surface-fix-20260613.md` — "Detached ≠ dead… never land a live-but-detached lane in Failed & Stopped"). A live-but-idle process is **honestly** "running."

**What is missing from the system:** a *stop/pause lifecycle signal that does not depend on process exit*, plus a first-class **`paused`** state distinct from `stopped` (killed/dead) and `completed`.

---

## 2. Research conclusions (why the obvious "elegant" channels don't apply)

| Candidate | Verdict | Evidence |
|---|---|---|
| **ACP cancel** (`openclaw tasks cancel`) | ✗ Wrong tool | ACP models only `queued`/`running`→cancel — **no pause state**; `cancelTask` (`acp-session-service.ts:108`) *terminates*, doesn't park. Decisively, **these lanes are bare `claude` CLI, not `acpx`** (live process line: `claude … --settings …/lane-settings/manual-PAR-229-sync-readiness.settings.json`), so ACP cancel can't even reach them. |
| **Claude Code `Stop` hook** | ✗ Can't detect pause | Fires every response turn; cannot distinguish "done" from "awaiting input." |
| **Claude Code `SessionEnd` hook** | ✓ for *exit* only | Reliable on real CLI exit (`stop_reason`: `logout`/`prompt_input_exit`/…). Does NOT fire while the process stays alive — so it cannot catch "paused-but-alive." |
| **Native Claude Code "paused" state** | ✗ Does not exist | When told "pause, don't exit," **zero hooks fire**. Confirmed via docs. |
| **OS-liveness-only inference / transcript parsing** | ✗ Anti-pattern | Fragile; transcript format is internal & version-volatile. |
| **Hook → receipt → overlay chain (existing)** | ✓ **Blessed pattern here** | Completion is already event-driven via per-lane Claude Code hooks (`SessionEnd → oste-session-end-hook.sh`, `Stop → oste-stop-hook.sh`) writing `/tmp/oste-pending-review/<id>.json`, consumed at **Tier 1a (`agent-status-tree-provider.ts:2279`) BEFORE the liveness gate (2352)** — i.e. a receipt is the one channel that *already* overrides "process is alive." |

**Anti-pattern verdict:** Reusing the existing receipt/overlay contract is **not** a hack — it is the idiomatic lifecycle channel in this codebase. The thing that *would* be a hack is a **parallel** receipt dir + probe + status pipeline. The fix is **one new vocabulary value (`paused`)** threaded through the pipeline that already exists (`applyRuntimeStatusOverlay` at `:2375` already accepts arbitrary statuses).

---

## 3. Design

### 3.1 Status semantics

Add `"paused"` to `AgentTaskStatus` (`command-central/src/types/agent-task.ts:22-30`).

| Status | Meaning | Process | Bucket |
|---|---|---|---|
| `running` | actively working | alive | Live |
| **`paused`** | **intentionally parked, awaiting relaunch** | **may be alive** | **Needs Review (limbo)** |
| `stopped` | killed / terminated / dead | dead | Action |
| `completed*` | finished | dead | History/Review |

`paused` is the **only** receipt status permitted to override the liveness gate while the process is alive. It is **never** auto-inferred from staleness/idle, and **never** auto-flips to `stopped`/`completed` — it is an explicit operator/sentinel state that exits only via **relaunch** or **kill**.

### 3.2 Receipt schema (extend existing — do NOT fork a new dir)

Reuse `/tmp/oste-pending-review/<task_id>.json` (`pending-review-probe.ts`, `DEFAULT_PENDING_REVIEW_DIR`). Add `paused` to `ReceiptOverlayStatus` and these **additive optional** fields to `PendingReviewReceipt`:

```jsonc
{
  "taskId": "manual-PAR-319-native-workroom",
  "status": "paused",            // NEW value in the existing status field
  "exitCode": null,              // paused ≠ exited
  "completedAt": null,           // paused ≠ complete
  "pausedAt": "2026-06-28T14:30:00Z",   // NEW (optional)
  "pauseReason": "Manager correction: manual lane bypassed Symphony/Linear workroom lifecycle; awaiting relaunch.", // NEW (optional)
  "lastCommit": "f762f61d",
  "endCommit": null,
  "reviewState": null,
  "reviewed": false
}
```

### 3.3 Overlay mapping

`receiptToOverlay()` (`pending-review-probe.ts`): add a case `status === "paused"` → overlay `{ status: "paused", reason: receipt.pauseReason ?? "Lane paused — awaiting relaunch." }`. The overlay must **not** set `completed_at` or `exit_code` (it is neither complete nor exited).

### 3.4 Bucketing (per owner decision: Needs Review / limbo)

Map `paused` status → group `limbo` → section `review`. The group→section table already does `limbo: "review"` (`agent-status-sections.ts:90`). Update the status→group resolver (`getNodeStatusGroup`, `agent-status-tree-provider.ts` ~4597-4709) so `paused` returns `limbo`. Render label e.g. **"Paused · awaiting relaunch."** Rationale: a parked lane needs an operator decision (relaunch or kill) — that is review-limbo, not "broke" (action) and not "gone" (history).

### 3.5 Two entry points (both reuse the receipt path)

**A. Launcher Stop-hook pause sentinel (agent-initiated).**
`oste-stop-hook.sh` already fires every turn and "can finalize the task when a deterministic launcher artifact contract is satisfied." Add a **pause sentinel** contract: when an agent is told to pause it writes a recognizable marker (proposed: `.oste-pause.yaml` in project root, or `~/.config/ghostty-launcher/pending/<task_id>.paused`). On the next Stop-hook turn, the hook detects the sentinel and writes a `paused` receipt. This makes **chat-pauses self-register** with no polling and no transcript parsing — using the exact mechanism completion already uses.

**B. Command Central "Pause lane" command (operator-initiated).**
New `commandCentral.pauseAgent` command, sibling to `commandCentral.killAgent` (`register-agent-registry-commands.ts:188`). It writes the `paused` receipt for the selected lane via a thin launcher helper `oste-pause.sh` (symmetric to `oste-kill.sh`, which writes `stopped`) — **writes receipt + `tasks.json` status=paused, never kills the process** — then `reload()`s the tree. Works even when the agent is not cooperating.

> `oste-pause.sh` is **not** a parallel subsystem: it is the `paused` counterpart to the existing `oste-kill.sh` (`stopped`), writing into the **same** receipt dir + `tasks.json`. Same mechanism, one new terminal vocabulary value.

---

## 4. Cross-repo touch points

**command-central**
- `src/types/agent-task.ts:22` — add `"paused"` to `AgentTaskStatus`.
- `src/utils/pending-review-probe.ts` — `ReceiptOverlayStatus` += `"paused"`; `PendingReviewReceipt` += `pausedAt?`, `pauseReason?`; `receiptToOverlay()` paused case.
- `src/providers/agent-status-tree-provider.ts` — `getNodeStatusGroup` (~4597) maps `paused`→`limbo`; verify Tier 1a (`:2279`) applies the paused overlay before the liveness gate (`:2352`); renderer label/icon for paused.
- `src/utils/agent-status-sections.ts` — no change (uses `limbo:"review"`); add tests.
- `package.json` — register `commandCentral.pauseAgent` (command + menu, sibling to `killAgent` at the existing menu entries).
- `src/activation/register-agent-registry-commands.ts` — implement `pauseAgent` handler (calls `oste-pause.sh`, no SIGTERM).
- Formatters/icons for the `paused` status (status theme icon map ~`:472`).

**ghostty-launcher**
- `scripts/oste-pause.sh` — NEW thin helper: write paused receipt + `tasks.json` status=paused; never kill.
- `scripts/lib/oste-stop-hook.sh` — recognize the pause sentinel; write paused receipt.
- Per-lane hook contract (`install-claude-hooks.sh` / `lane-settings/<task_id>.settings.json`) — ensure the pause sentinel is part of the materialized contract.
- Sync bundled launcher resources into `command-central/resources/bin/` via `just sync-launcher` before the CC release.

---

## 5. Test matrix

| # | Scenario | Expected |
|---|---|---|
| 1 | **paused receipt + process still ALIVE** | lane leaves **Live**, lands in **Needs Review** (the critical regression test — receipt must beat liveness gate `:2352`) |
| 2 | paused receipt, process later dies | stays **paused** (no auto-flip to stopped) until relaunch/kill |
| 3 | `killAgent`/`oste-kill.sh` on a running lane | still → **stopped** → Action (unchanged) |
| 4 | `receiptToOverlay(status:"paused")` | returns paused overlay; no `completed_at`/`exit_code` set |
| 5 | Stop-hook with pause sentinel present | writes paused receipt |
| 6 | Stop-hook on a normal working turn (no sentinel) | does **not** write paused receipt |
| 7 | `commandCentral.pauseAgent` | writes receipt, refreshes tree, **process untouched** |
| 8 | Section mapping | `paused`→`limbo`→`review` |
| 9 | Backend neutrality | paused works for `claude`/`codex`/`gemini` lanes (per skill neutrality rule — fixtures with ≥2 backends) |
| 10 | No false positives | a slow-but-working lane (idle stream, no sentinel) is **never** auto-marked paused |

---

## 6. Rollout

1. **v1 (this design).** Land the `paused` status + receipt/overlay + bucket + `commandCentral.pauseAgent` command + `oste-pause.sh` + Stop-hook sentinel across both repos, behind green gates (`just ready`, `just check`, full test matrix above).
2. **Clear the two stuck lanes via the fix path** (see §7).
3. **Fresh Command Central release for integration testing.** After v1 is green, `just sync-launcher` then cut a fresh preview (`just cut-preview` / `just dist --prerelease`) so the components integration-test together end-to-end: launcher hook/sentinel → receipt → CC overlay → Needs Review bucket. Validate with the installed-VSIX proof suite + a **live** pause of a real lane confirming it demotes without dying. **Do not push/tag/publish/`--no-verify` without explicit approval** (CLAUDE.md cross-repo release rules).

---

## 7. Clearing `par319` / `par229` (run once v1 lands — owner chose "clear via the fix path")

Do **not** kill the processes (owner declined). Once the pause path exists:

```bash
# Option A — from the tree: right-click each lane → "Pause lane"
# Option B — launcher helper:
oste-pause.sh manual-PAR-319-native-workroom
oste-pause.sh manual-PAR-229-sync-readiness
```

Result: both get a `paused` receipt → leave **Live** → land in **Needs Review · awaiting relaunch**, processes still parked. Then relaunch them through the **proper issue-scoped dispatch path** (not a manual lane — that bypass is the original PAR-317/318 root cause the manager flagged).

---

## 8. Guardrails (do NOT)

- ✗ Infer `paused` from staleness/idle alone (a slow lane ≠ paused).
- ✗ Parse transcripts to detect "PAUSED" text.
- ✗ Fork a parallel receipt dir / probe / status pipeline — reuse pending-review.
- ✗ Let `paused` auto-flip to `stopped`/`completed`; exits are relaunch or kill only.
- ✗ Use ACP cancel for these lanes (not ACP; cancel kills, doesn't park).
- ✗ Hard-code a backend; keep agent/model neutral.

---

## 9. Open owner decisions

1. **Sentinel format/location** for Stop-hook auto-detect: `.oste-pause.yaml` (in-repo, visible) vs `~/.config/ghostty-launcher/pending/<task_id>.paused` (out-of-tree).
2. **Receipt format reconciliation:** launcher completion markers are `key=value`; CC reads JSON (`pending-review-probe.ts`). Confirm the pause path emits the **JSON** receipt CC consumes.
3. **Scope of v1:** ship both entry points together, or land the CC `pauseAgent` command first (clears the two lanes immediately) and fast-follow the Stop-hook sentinel.
4. **ACP lanes** (`--agent acp`): in scope for paused, or cancel-only? (They can be cancelled but not parked.)
