# RESULT — Command Central Launched-Terminal RC Closeout

- **Task id:** `cc-launched-terminal-rc-closeout-20260614`
- **Role:** Reviewer (review mode — working tree left untouched, no commits)
- **Date:** 2026-06-14
- **Host:** `ostehost@MacBookPro.lan` — **Mike MacBook Pro (node lane)** — canonical
  for the launched-terminal proof
- **Repo:** `/Users/ostehost/projects/command-central` · branch `main`
- **Verdict:** 🟢 **GO** — the launched-terminal RC path is stable and shippable
  with no hacks. No code change was needed; no churn introduced.

---

## 0. TL;DR

Re-validated the launched-terminal RC gate matrix at the current HEAD against a
**real** launcher row (`review-cc-agent-status-v2-recovery-20260613`) using the
installed `0.6.0-rc.60` VSIX. A **fresh review-time live proof** reproduced
copy / open-evidence / focus-terminal — all passed, all non-mutating, zero
errors / skips / forbidden hits. Unit + tree-view suites are green. Working tree
is clean and unchanged (review mode). **OpenClaw subagent surfacing is explicitly
deferred** to a follow-up per Mike's clarification (see §8).

---

## 1. Repo state (start == end; review mode)

| Field | Value |
| --- | --- |
| Branch | `main` |
| HEAD | `5f1c9d63` `feat(agent-status): complete Agent Status V2 project-first section model` |
| Tracking | `main...origin/main [ahead 16]` (unpushed — out of scope) |
| Tree (start) | clean |
| Tree (end) | **clean** (`git status --porcelain` empty) |
| `package.json` version | `0.6.0-rc.60` (unchanged — no bump/cut) |
| Files changed | **none** (only a gitignored proof manifest under `logs/`) |

The single artifact written this lane —
`logs/installed-vsix-agent-status-proof-1781441424565-legacy.json` — is confirmed
gitignored (`git check-ignore` matched), so the working tree is untouched.

---

## 2. Installed-VSIX identity (proof binds to real, current code)

| Field | Value |
| --- | --- |
| Installed VS Code ext | `oste.command-central@0.6.0-rc.60` (matches source) |
| VSIX | `releases/command-central-0.6.0-rc.60.vsix` |
| VSIX sha256 (recomputed) | `be1bf14a51fdac75ba0868eed64501bb32b1ce82d7e9f8fec5735ccf83d9ec1a` |
| Proof `commit` | `5f1c9d63…` == current HEAD |
| Proof `vsix_sha256` | `be1bf14a…` == recomputed == installed |
| Loaded from VSIX (not `--extensionDevelopmentPath`) | `true` / `false` resp. |

---

## 3. Selected launcher row (real — not synthesized)

`review-cc-agent-status-v2-recovery-20260613`, read live from
`~/.config/ghostty-launcher/tasks.json`:

| Field | Value |
| --- | --- |
| `status` | `completed` |
| `source_authority` / `owner_kind` | `launcher` / `launcher` |
| `project_id` / `project_ref.id` | `command-central` / `command-central` |
| `flow_id` | `cross-repo-integration-gate-20260613` |
| `owner_actions` | `focusTerminal`, `showDetail` |

This is the LaneRef / launched-terminal row backing the action probes. The
`COMMAND_CENTRAL_REQUIRED_TASK_ID` env var binds the live probes to **this real
row** — launcher state was neither faked nor synthesized. (The proof's
legacy-fixture phase also injects two passive sentinel rows
`installed-proof-legacy-alpha/beta` purely for backend-rendering coverage; they
are *not* the action-probe target.)

---

## 4. Commands run + exit statuses

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `just test-unit` | **0** | 129 pass (git-sort) + 512 pass (utils/services) = **641 / 0 fail** |
| 2 | `bun test test/tree-view/` | **0** | **461 pass / 0 fail** across 24 files |
| 3 | `bun run scripts-v2/node-execution-guard.ts` | **0** | `node-execution-ok` |
| 4 | `COMMAND_CENTRAL_REQUIRED_TASK_ID=review-cc-agent-status-v2-recovery-20260613 just test-installed-vsix-agent-status --live --phase legacy-fixture` | **0** | `installed-vsix-agent-status-proof-ok` — mode **live**, **3 actions passed / 0 skipped**, forbidden hits **0**, expected ids visible **2/2**, 38.74s |

Benign noise in the proof run (did not affect the exit-0 verdict): one
`Extension host … unresponsive → responsive` startup-profiling blip, and
`can't find session: installed-proof-legacy-{alpha,beta}-session` /
`fatal: not a git repository` lines — the harness probing the passive sentinel
fixture rows, which have no live tmux/git by design.

---

## 5. Launched-terminal RC gate matrix — each item verified

| Gate item | Verdict | Evidence |
| --- | --- | --- |
| **Launcher row truth** | ✅ PASS | Row present & `completed` in live `tasks.json`; `source_authority=launcher`, `project=command-central`; `owner_actions=[focusTerminal, showDetail]` |
| **Copy action** | ✅ PASS | `clipboard changed`; detail `Run attempt ID: review-cc-agent-status-v2-recovery-20260613`; non-mutating to lifecycle/tracker/workspace |
| **Open evidence action** | ✅ PASS | `file opened` (tmp evidence path); non-mutating |
| **Focus terminal action** | ✅ PASS | `terminal focus invoked`; detail = the launched terminal's reviewer banner; non-mutating |
| **Completed review row visibility** | ✅ PASS | `source_authority_matrix` row renders all 4 owner actions: Copy Evidence · Copy Run Attempt ID · Focus Terminal · Open Evidence |
| **Stale / failed row behavior** | ✅ PASS (tests) | Green in the 461-test tree-view run: `agent-status-tree-provider-health` (`completed_stale`→Needs Review), `agent-status-dead-process-running`, `agent-status-limbo-tier`, `agent-status-completed-tmux-regression`, `agent-status-running-detached-surface` |

---

## 6. Proof log paths

- **Fresh (this review):**
  `logs/installed-vsix-agent-status-proof-1781441424565-legacy.json`
  — mode live, 3/3 probes passed, `commit=5f1c9d63`, `sha=be1bf14a`, `errors=[]`,
  `skips=[]`, `forbidden_launcher_task_id_hits=[]`.
- **Prior same-HEAD live (corroborating, today):**
  `logs/installed-vsix-agent-status-proof-1781440015153-legacy.json` (08:27),
  `logs/installed-vsix-agent-status-proof-1781439929130-legacy.json` (08:25).
- **Prior same-HEAD passive:**
  `logs/installed-vsix-agent-status-proof-1781436036839-legacy.json` (07:21) and
  its `…-quarantine.json` sibling.

---

## 7. Files changed

**None.** Review mode — working tree untouched. No standards fix was warranted:
all gates are green, the read-model is honest, and the launched-terminal path
reproduces cleanly. Per the task contract ("otherwise do not churn code"), no
edits were made.

---

## 8. Deferred — OpenClaw subagent surfacing (follow-up, NOT this iteration)

Per Mike's explicit clarification, **OpenClaw subagent / source integration is
out of scope for this RC iteration** and is deferred to a follow-up lane. This
closeout covers launched terminals / launcher / LaneRef rows only. Nothing in
this report implements, prioritizes, or blocks on subagent surfacing. Carry the
following into the follow-up:

- Surface OpenClaw subagents as first-class rows (currently the lanes projection
  feeds project grouping, but per-subagent surfacing is unaddressed here).
- Re-run this same gate matrix once subagent rows are introduced, to confirm the
  launched-terminal actions remain correct for subagent-owned rows.

---

## 9. Remaining blockers

**None** for the launched-terminal RC path.

Out-of-scope notes (no action taken, by contract):
- Branch is **16 commits ahead of `origin/main`, unpushed** — do not push/tag/
  publish without explicit approval.
- No release was cut, built, bumped, tagged, or published this lane.

---

## 10. Final state

| | |
| --- | --- |
| Repo status | clean (`git status --porcelain` empty) |
| HEAD | `5f1c9d63` (unchanged) |
| `just test-unit` | **641 pass / 0 fail** (exit 0) |
| `bun test test/tree-view/` | **461 pass / 0 fail** (exit 0) |
| Installed-VSIX live proof | **OK** — 3/3 action probes passed (exit 0) |
| Handoff | `research/CC-LAUNCHED-TERMINAL-RC-CLOSEOUT-2026-06-14.md` |
| **Verdict** | 🟢 **GO** |
