# CORRECTIONS — `paused` lane lifecycle design (v1 review ledger)

- **Date:** 2026-06-28
- **Reviews:** `DESIGN-paused-lane-lifecycle-2026-06-28.md` (v1)
- **Method:** 6-lens adversarial review across both repos (claim-audit ×2, native-vs-hack, state-machine, alternative-design, completeness). 59 findings confirmed against real code, 0 refuted. The load-bearing claims below were additionally hand-verified at HEAD.
- **Repos:** `command-central` (`/Users/ostehost/projects/command-central`) + `ghostty-launcher` (`/Users/ostehost/projects/ghostty-launcher`)
- **Bottom line:** v1's *spine* is correct (one new vocabulary value through the existing tree pipeline; correct rejection of parallel-pipeline / transcript-parse / staleness-inference anti-patterns). But v1 is **not** the "pure reuse, one vocabulary value, drop-in, no hacks" solution it claims. The receipt/overlay channel is a *completion/exit* artifact that the real code actively resists carrying a non-terminal "alive-but-parked" state; the `never auto-flips` invariant is falsified by three live launcher mechanisms; the exits (relaunch/kill) are unimplemented; and Entry A (agent-written sentinel) re-introduces the exact agent-cooperation dependency the root cause blames. This ledger lists every confirmed defect; `DESIGN-paused-lane-lifecycle-v2-2026-06-28.md` is the design rebuilt around it.

---

## How to read this

Each correction: **[severity]** title · **Defect** (what v1 says vs reality) · **Evidence** (verified `file:line`) · **Correction** (what v2 does). Severity = impact on an implementer following v1 literally. Blockers would ship a broken feature; majors mislead the core design claim or break an invariant; minors are inaccurate anchors/claims; nits are cosmetic.

The single most consequential conclusion, which reorganizes the whole design, is **C0** — read it first.

---

## C0 — [architecture] The operator path needs NO receipt; v1's receipt mandate is the source of most defects

**Defect.** v1 mandates that `oste-pause.sh` (operator path, §3.5-B) write a pending-review **receipt** into `/tmp/oste-pending-review/<id>.json`, justified as "symmetric to `oste-kill.sh`, which writes `stopped` into the same receipt dir." Almost every blocker and major below is a downstream consequence of trying to push a non-terminal status through that completion-receipt channel.

**Evidence (the symmetry premise is false on three counts).**
- `oste-kill.sh` writes **no receipt at all** — it sources `tasks-lock/terminal/reaper/prompt-detection/work-system-bridge/env-validation`, *not* `pending-review.sh`; its only state write is `update_task_status` → `tasks.json` (`oste-kill.sh:90-117`).
- Its primary paths write `killed`, not `stopped` (`oste-kill.sh:217,244,266,373`); `stopped` appears only on already-dead/graceful branches (`:331,354,364`). `killed` and `stopped` are **distinct** statuses (`agent-task.ts:24-25`).
- CC surfaces a non-`running` `tasks.json` status by **direct passthrough** — `toDisplayTask` only probes a receipt when `task.status === "running"` (`agent-status-tree-provider.ts:2279`); for any other status it returns the row as-is. So a `tasks.json status=paused` row is trusted directly and **never reads a receipt**. The receipt would be a dead write.

**Correction.** The operator path writes `tasks.json status=paused` directly (the real `oste-kill.sh` `update_task_status` pattern, under `lock_tasks`) and **emits no receipt**. This single change dissolves C6, C7, C8, C9 and the receipt-mutation blockers C10/C11 below. (C12 — relaunch clearing — is *not* dissolved by this; it needs the explicit kill-to-clear step in its own entry.) Receipts only re-enter the picture for the optional Entry A self-report path (and even there, v2 prefers a `tasks.json` write — see C13).

---

## A. Status-vocabulary plumbing (must-do regardless of channel)

### C1 — [BLOCKER] `tasks.json status=paused` is silently coerced to `"stopped"`
**Defect.** §4 only adds `paused` to the *compile-time* `AgentTaskStatus` union. It never updates the two *runtime* allow-lists, so normalization rewrites an unrecognized `paused` to `"stopped"` on the next pass — the operator path would land the lane in Action, not Needs Review.
**Evidence.** `VALID_TASK_STATUSES` (no `paused`) exists in two byte-identical copies: `agent-status-tree-provider.ts:425-434` (live) and `agent-task-normalize.ts:20-29` (twin — note: under `src/providers/`, *not* `src/utils/` as one finding mis-pathed). Coercion: both `normalizeTask` sites do `VALID_TASK_STATUSES.has(...) ? statusRaw : "stopped"` (`provider:656`, normalize twin).
**Correction.** Add `"paused"` to **both** sets (ideally dedupe to one shared Set). Add a regression test: a `tasks.json` row with `status:"paused"` survives `normalizeTask` and is **not** coerced.

### C2 — [MAJOR] Status formatters fall through `default` → a paused lane renders **"Failed"**
**Defect.** §4 lists only "renderer label/icon" with a wrong anchor. Three per-status switches in `agent-status-formatters.ts` each have a `default` that mis-renders `paused`.
**Evidence (`src/providers/agent-status-formatters.ts`).** `getStatusThemeIcon` (`:8`, default `:42` → generic `circle-outline`); `getStatusDisplayLabel` (`:47`, default `:55` → echoes raw status); `formatTaskElapsedDescription`/`getStatusElapsedReference` (`:120`, default `:135` → **"Failed Xm ago"**). None is exhaustive, so the compiler won't catch the omission.
**Correction.** Add an explicit `case "paused"` to all three.

### C3 — [MINOR] `getNodeStatusGroup` defaults unknown statuses to `attention` (Action), not `limbo`
**Defect.** Without an explicit case, `paused` falls through to Action Required, not Needs Review.
**Evidence.** `getNodeStatusGroup` (`agent-status-tree-provider.ts:4597-4709`) ends in `return "attention"` (`:4708`); `paused` matches none of the earlier arms. The limbo→review section map is correct (`agent-status-sections.ts:90`).
**Correction.** Add `paused → "limbo"` **before** the `:4708` default and **outside** the lifecycle-conflict block (`:4632-4659`). Do **not** add `paused` to `CONFLICT_ELIGIBLE_STATUSES` (`agent-task-classification.ts:424-432`) — that would resolve a paused-but-alive lane to live-process-conflict → Action.

### C4 — [MAJOR] `sectionFromSignals` (M3 render engine) routes paused-but-alive back to **Live**
**Defect.** §4 says `agent-status-sections.ts` needs "no change." True for the *currently wired* path (`sectionFromStatusGroup ← getNodeStatusGroup→limbo`), but the second classifier in the same file short-circuits on liveness first, defeating the whole design once M3 is wired.
**Evidence.** `agent-status-sections.ts:208-209`: `if (signals.status === "running") return "live"; if (signals.livenessAlive) return "live";` — a `status:"paused", livenessAlive:true` lane returns `"live"`.
**Correction.** Add `if (signals.status === "paused") return "review";` **above** the `livenessAlive` check (`:209`). Treat both classifiers as one contract for any new status.

### C5 — [MINOR] Per-project rollup icon (`getSummaryIcon`) ignores paused
**Defect.** A paused-only project scope renders the green "all clear" check.
**Evidence.** `getSummaryIcon` (`agent-status-tree-provider.ts:8238-8285`, used `:7691`) is a hand-rolled status precedence with no paused/limbo arm (green check-all at `:8282-8285`). Rollup *counts* are already covered by the `paused→limbo` mapping.
**Correction.** Add a paused/limbo branch to `getSummaryIcon`.

---

## B. The receipt/overlay channel resists a non-terminal status (why C0 drops it)

### C6 — [MAJOR] `applyRuntimeStatusOverlay` force-stamps `completed_at = now()`
**Defect.** §2/§3.1/§4 lean on "`applyRuntimeStatusOverlay` already accepts arbitrary statuses" as proof that `paused` is a zero-change drop-in, and §3.3 requires the overlay to **not** set `completed_at`. The body makes that impossible.
**Evidence.** `agent-status-tree-provider.ts:2387-2389`: `completed_at: overlay.completedAt ?? task.completed_at ?? new Date().toISOString()`. A paused overlay omits `completedAt`; a still-running lane has `task.completed_at == null`; so it stamps **now** — labeling the parked lane "completed at now," violating §3.2/§3.3.
**Correction (if any receipt/overlay path is ever used).** Gate the `?? new Date()` fallback on terminal statuses only, and add this helper to the touch-point list. The operator path (C0) avoids the overlay entirely by writing `tasks.json` directly.

### C7 — [MAJOR] The canonical receipt writer cannot emit the paused shape
**Defect.** §3.2 wants `exit_code: null`, `completed_at: null`, `review_state: null`. The blessed writer can express none of these.
**Evidence (`scripts/lib/pending-review.sh`).** `exit_code: ($exit_code | tonumber)` (`:380`) — `""`/`null` aborts jq (exit 5) and, with no error guard, **truncates the receipt to 0 bytes**; `completed_at` is unconditional (`:381`); `review_state:"pending"`, `reviewed:false`, `reported_to_user:false` are hardcoded (`:389-391`); no `paused_at`/`pause_reason` fields.
**Correction.** Operator path emits no receipt (C0). The doc must stop claiming literal "reuse the blessed writer" for paused — that reuse is not achievable without a writer-contract change.

### C8 — [MAJOR] Receipt example is camelCase; the consumer parses snake_case, and `parseReceiptFile` is never extended
**Defect.** §3.2's example would not round-trip, and adding fields to the `PendingReviewReceipt` interface alone does not populate them.
**Evidence.** On-disk keys are snake_case (`pending-review.sh:376-391`); `parseReceiptFile` reads `parsed["exit_code"]`, `parsed["completed_at"]`, `parsed["review_state"]` etc. (`pending-review-probe.ts:177-185`). `pausedAt`/`pauseReason` are never read.
**Correction.** N/A for the operator path (no receipt). If Entry A ever uses a receipt, rewrite §3.2 in snake_case and add `parseReceiptFile` reads.

### C9 — [MINOR] Forward-compat: a pre-`paused` installed VSIX silently drops paused
**Defect.** Cross-repo producer/consumer schema change where the consumer is a separately-installed VSIX; "green gates" test the committed tree, not the installed build.
**Evidence.** `ReceiptOverlayStatus` is a closed union `"completed"|"failed"|"stopped"` (`pending-review-probe.ts:234`); `receiptToOverlay` returns `null` for unknown statuses — an old VSIX keeps the lane in Live. For the **operator (tasks.json) path**, an old VSIX coerces `status:"paused"` → `"stopped"` (C1) → Action. Either way, the launcher must not emit `paused` to a CC that predates support.
**Correction.** Ship/enable CC paused-support before (or atomically with) launcher pause emission; gate the rollout on the installed VSIX, not the tree (§6).

---

## C. Lifecycle / state-machine invariant breaks

### C10 — [BLOCKER] The reaper auto-flips `paused → stopped/failed` when the parked process later dies
**Defect.** Invariant (§3.1/§8, test #2): paused never auto-flips. False for any receipt-only path that leaves `tasks.json status=running`.
**Evidence.** Every reaper scan gates on `status == "running"`: `scripts/lib/reaper.sh:455,485` (`!= "running"` → skip), `:781` (`select(.status=="running")`), `:923` (`detect_orphaned_terminals` status filter). A receipt-only Entry A (process still `running`) is therefore reaped and settled to `stopped`/`failed`.
**Correction.** Both entry points write **`tasks.json status=paused`** (not `running`), so all reaper scans auto-exclude the lane — the same protection `oste-kill.sh` already gets. (C0 gives the operator path this for free.)

### C11 — [BLOCKER] The 6h quarantine + review watchdog act on a paused receipt
**Defect.** Two other consumers of the shared receipt dir mutate/evict it.
**Evidence.** `pending_review_quarantine` skip-set is `{reviewed, blocked, reviewing}` only (`pending-review.sh:852-854`) → a `review_state:pending` paused receipt is quarantined out of Needs Review once aged. The review watchdog dispatches a reviewer for anything outside `{reviewed, awaiting_fixup, blocked}` (`oste-review-watchdog-runner.sh:136-152`).
**Correction.** No receipt in the operator path → neither fires. **If** Entry A ever writes a receipt, it must use a durable `review_state` (e.g. `no_review_expected`) and be added to both skip-sets plus the cleanup retention (`pending-review.sh:905-936`).

### C12 — [BLOCKER] Nothing clears paused on relaunch — breaks §7 (the doc's own remediation)
**Defect.** The "exits via relaunch" invariant has no implementation. A receipt-based paused re-overlays onto the relaunched live lane for its entire run.
**Evidence.** `clear_task_runtime_artifacts` (`oste-spawn.sh:864-879`) removes `/tmp/oste-complete-*`, `oste-receipt-*`, `oste-pid-*`, `oste-stop-failure-*` — but **not** `/tmp/oste-pending-review/<id>.json`; and `toDisplayTask` re-reads that receipt for any `running` task (`:2279`).

> **Re-verified 2026-06-28 (implementation team) — v2's first answer to this was WRONG.** v2 originally claimed the no-receipt operator path makes relaunch "clear paused for free." It does not, for the realistic path: `oste-spawn` **auto-generates a new `task_id` by default** (`oste-spawn.sh:108`), and §11 deliberately relaunches through the *proper issue-scoped dispatch* = a **new lane with a new id**. The original `paused` row is therefore never overwritten — it **orphans** in Needs Review. `clear_task_runtime_artifacts` runs only on a **same-id retry** (`oste-spawn.sh:868`) and even then removes `/tmp/oste-*` runtime files, **not** the `tasks.json` row.

**Correction (REVISED → kill-to-clear).** There is **no automatic `paused→running` relaunch transition.** A `paused` row's only exits are:
1. **kill-to-clear (the chosen mechanism).** When re-dispatching, the operator explicitly `oste-kill.sh`s the old paused lane (any→`killed`, no new code) — `killed` leaves Needs Review and lands in Action, consistent with every killed lane, and tears down the now-defunct parked process. This is legitimate cleanup at *abandon* time, distinct from the "pause must never kill" rule.
2. **explicit same-id retry respawn** (`oste-spawn … --task-id <same>`) — overwrites `paused`→`running`; an edge case, not the default.

The clear **MUST be a documented operator step**, never assumed — otherwise every paused-then-re-dispatched lane leaves a zombie `paused` row. Adding `paused` to `_session_is_completed` is **not required** under kill-to-clear (you kill first; `killed` is already reuse-eligible) — keep it only as optional hardening if direct same-id relaunch-from-paused is ever wanted. Add a regression test: pause → re-dispatch as a new lane → assert the old row was explicitly cleared, not orphaned.

### C13 — [MAJOR] `oste-pause.sh` records ground truth for a state it does not enforce → sticky divergence
**Defect.** Unlike `oste-kill.sh` (which *creates* the death it records), `oste-pause.sh` writes paused without changing reality, so a mis-fire parks a live, actively-working agent in Needs Review with no self-correction.
**Evidence.** `oste-kill.sh` proves death before writing (`:243` kill-window → `:244` status; graceful path waits `_terminal_at_prompt` `:351` → `:354`). v1's `oste-pause.sh` has no equivalent guard.
**Correction.** Before writing `paused`, `oste-pause.sh` sources `prompt-detection.sh` and verifies the pane is at-prompt/idle (`_terminal_at_prompt`, as `oste-kill.sh:31-32,237,351` already do); refuse/warn if the pane shows active work. Add the mis-fire test (§5).

### C14 — [MINOR] Concurrency unspecified — pause/complete and pause/kill races
**Defect.** §3.5-B never takes the tasks lock; a concurrent `oste-complete.sh`/reaper can interleave.
**Evidence.** Every sibling writer locks: `oste-kill.sh:95` (`lock_tasks`), `reaper.sh:482`, `oste-complete.sh:1466-1551`.
**Correction.** `oste-pause.sh` acquires `lock_tasks` (trap `unlock_tasks` RETURN), re-reads status under the lock, and refuses to write `paused` over a terminal status (the `reaper.sh:485-487` compare-and-swap pattern).

### C15 — [MAJOR] kill-from-paused / relaunch-from-paused transitions are unmapped
**Defect.** §5 covers kill on *running* (test #3) but not the transitions *from* paused.
**Evidence.** `oste-kill.sh` mutates only `tasks.json` (no receipt clear), so a receipt-based paused would dangle after kill.
**Correction.** v2 ships a full transition table `{running,paused} × {pause,kill,relaunch,complete,die}`. With the no-receipt operator path, kill-from-paused is just `status→killed` (no dangling artifact).

### C16 — [MAJOR] "Paused · awaiting relaunch" on a **dead** process contradicts the §1 honesty doctrine
**Defect.** §1 grounds the design in truthful status ("a live-but-idle process is honestly running"; demote only when "positively confirmed dead"). Test #2 deliberately keeps a *dead* lane labeled "awaiting relaunch," implying impossible in-place resumption.
**Evidence.** Honesty doctrine at `agent-status-tree-provider.ts:2342-2352`.
**Correction.** Preserve the no-auto-flip invariant but make the **label** honest: a render-time liveness check splits the copy — "Paused · parked (process alive)" vs "Paused · ended (relaunch as new lane)" — without changing `status`. (v2 §honesty.)

---

## D. Entry A (agent-initiated pause) is a hack as specified

### C17 — [MAJOR] Entry A re-introduces the exact agent-cooperation dependency §1 blames
**Defect.** The root cause (§1) is that a cooperating agent goes idle and emits **no machine signal**. Entry A asks that same agent to write a sentinel file — the same conversational-instruction channel, repackaged. v1 oversells it as "self-registers … using the exact mechanism completion already uses."
**Evidence.** §2's own table concedes the Stop hook "cannot distinguish 'done' from 'awaiting input'" (`design:32`); the discriminating signal in Entry A is agent-authored, not native. Completion's blessed marker is `/tmp/oste-complete-<id>` written by the launcher's finalizers, not by an idle agent.
**Correction.** Demote Entry A to an **optional, cooperating-agent-only** convenience and say so plainly. The robust primary is the operator path (Entry B), which needs zero agent cooperation and clears par319/par229 today.

### C18 — [MAJOR] The sentinel is a bespoke side-channel with no lifecycle and a per-turn flap race
**Defect.** §9 debates sentinel *location* only, never freshness/ownership/deletion. The Stop hook fires every turn (`oste-stop-hook.sh:12`) with its only idempotency guard keyed on `/tmp/oste-complete-<id>` (`:403`) — which a pause path does not create — so a persistent sentinel re-writes paused and re-pauses a relaunched lane every turn.
**Evidence.** `oste-stop-hook.sh:12,403`.
**Correction.** v2's Entry A writes `tasks.json status=paused` (off `running`), which disarms the finalize predicates (all gated on `status=="running"`) on later turns — killing the flap. Define marker deletion on pause-write and on relaunch.

### C19 — [MAJOR] Entry A is structurally claude-only — test #9 (backend neutrality) is unmet for it
**Defect.** §5 test #9 asserts paused works for claude/codex/gemini, but the Stop-hook mechanism exists only for claude lanes.
**Evidence.** `oste-spawn.sh:1539` gates `install-claude-hooks.sh` to `agent_backend == "claude"`; `oste-stop-hook.sh:3` is a "Claude Code Stop hook handler." codex/gemini lanes materialize no per-turn hook.
**Correction.** Scope Entry A as claude-only in the doc. codex/gemini reach paused **only** via the operator path, which is backend-neutral (no backend gate, exactly like `oste-kill.sh`). Rewrite test #9 to assert *operator-path* neutrality.

### C20 — [MINOR] §2 dismisses the Stop hook, then §3.5-A builds on it — ignoring the declared-marker contract it already parses
**Defect.** v1 invents a new `.oste-pause.yaml` sentinel while the Stop hook already parses an agent-declared **status** vocabulary.
**Evidence.** `oste-stop-hook.sh` parses `.oste-report.yaml` `status:` via `_report_field` + a `case` on `success/failure` (`:435-490`), and recognizes a `TASK COMPLETE` final-line marker (`:233`) and a `_final_message_contract_ready` predicate (`:205-240`).
**Correction.** If Entry A ships, extend the **existing** declared-status vocabulary (or a `TASK PAUSED` final-message predicate symmetric to `_final_message_contract_ready`). The final-message route also resolves the "do not edit files" contradiction (C21) since the agent signals via chat, not a file write. Insertion point: after the guards (`~:388`), **before** the `.oste-report.yaml` completion path (`:433`) and artifact-contract finalize (`:506`).

### C21 — [MINOR] Entry A asks a "do not edit files" agent to edit a file
**Defect.** §1 quotes the verbatim pause instruction "…**do not edit files**… do not exit…"; §3.5-A then requires the agent to write `.oste-pause.yaml`. A compliant agent writes nothing → Entry A silently no-ops.
**Evidence.** `design:16` vs `design:86-87`.
**Correction.** Prefer the final-message (`TASK PAUSED`) signal over a file write (see C20).

---

## E. Inaccurate claims & anchors (correct in prose; low implementation risk)

### C22 — [MINOR] "paused is the **only** receipt status permitted to override the liveness gate" is false
**Evidence.** Tier 1b runs `receiptToOverlay` for any `running` task **before** the liveness gate; `completed`/`failed`/`stopped` receipts already override liveness today (`agent-status-tree-provider.ts:2279-2284` → `pending-review-probe.ts:250-291`).
**Correction.** Reword: the *override-before-liveness* behavior is shared by every receipt status; paused's genuine novelty is being the first **non-terminal** value asserting "intentionally still-alive."

### C23 — [MINOR] Icon touch-point `~:472` points at the wrong map
**Evidence.** `provider:471-482` is `STATUS_GROUP_ICONS` (a 4-key *group* map), not a per-status map. The real per-status icon switch is `getStatusThemeIcon` (`agent-status-formatters.ts:8`).
**Correction.** Repoint to `agent-status-formatters.ts` (covered by C2).

### C24 — [MINOR] §2 mis-attributes the receipt write and mis-paths the SessionEnd hook
**Evidence.** Hooks don't write `/tmp/oste-pending-review/<id>.json` directly — they invoke `oste-complete.sh` → `pending_review_write` (`oste-session-end-hook.sh:75`; `oste-stop-hook.sh:167-178`). The session-end hook is `scripts/lib/oste-session-end-hook.sh` (2517 bytes); `scripts/oste-session-end-hook.sh` does **not** exist (v1 §2 gives bare filenames implying `scripts/`).
**Correction.** Cite `oste-complete.sh` as the single receipt writer and the correct `lib/` paths.

### C25 — [NIT] "Tier 1a" should be "Tier 1b"; §3.1 omits `killed` and treats `stopped == killed`
**Evidence.** Code comment at `provider:2273` names it "Tier 1b." Real `AgentTaskStatus` has both `stopped` (`:24`) and `killed` (`:25`); §3.1 folds them.
**Correction.** Rename throughout; add a `killed` row (or footnote) so the table mirrors the real 8-value enum.

---

## F. Alternative-design notes carried into v2

- **Most-native operator mechanism = direct `tasks.json` write** (the real `oste-kill.sh` pattern), not receipt/overlay indirection — adopted as v2's primary (C0).
- **`paused` is a transitional, consumer-side bridge** for legacy bare-`claude` lanes that bypass Symphony/Linear (the original PAR-317/318 root cause). ACP gives *cancel* (kills), not *park*, so it cannot substitute; but v2 states explicitly that the durable fix is routing such lanes through a real control channel, and `paused` is the interim. (Refined from the alternative-design lens; ACP-routing is **not** a v1 prerequisite.)
- **Badge-vs-status:** a still-Live badge already exists and was correctly judged insufficient for the owner's Needs-Review requirement; `paused` as a first-class status is justified. v2 keeps the status but adds the honest dead-process label split (C16).

---

## Severity tally (confirmed, de-duplicated)

| Severity | Count (raw) | Distinct themes |
|---|---|---|
| Blocker | 4 | C1, C10, C11, C12 |
| Major | 26 | C2, C4, C6, C7, C8, C13, C15, C16, C17, C18, C19 |
| Minor | 25 | C3, C5, C9, C14, C20, C21, C22, C23, C24 |
| Nit | 4 | C25 |

All four blockers are **resolved** by v2: C1 by the runtime-allow-list fix; C10 and C11 for free by the no-receipt `tasks.json` operator path (reaper/quarantine/watchdog only act on receipts or `running` rows); C12 by an explicit **kill-to-clear** procedure (§7/§11) — *not* "for free": v2's original auto-clear claim was wrong because `oste-spawn` mints a new `task_id` by default (`oste-spawn.sh:108`). The remaining majors become a bounded, accurate touch-point list in v2 §4.
