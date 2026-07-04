# RESULT — PAR-158 / CC-006: Dogfood Command Central cross-project orchestration with real OpenClaw issues

- **Task ID:** `symphony-PAR-158-ffff986c`
- **Linear:** [PAR-158](https://linear.app/partnerai/issue/PAR-158/cc-006-dogfood-command-central-cross-project-orchestration-with-real) / CC-006 (P2), parent PAR-149 / CC-000
- **Date:** 2026-07-02
- **Machine:** `MacBookPro` — `/Users/ostehost/projects/command-central` @ branch `main`
- **Kind:** dogfood-closeout — CC-006's fourth acceptance criterion **is** "a short
  dogfood report records what was fixed and what remained blocked." This is that
  report. It consolidates the already-committed PAR-189/191/193/195 dogfood evidence
  against the four acceptance criteria; it does not run a *new* live loop and mutates
  no tracker state.
- **Verdict:** **partial → evidenced.** AC1/AC3/AC4 are met by committed artifacts;
  AC2 is met in spirit and further **hardened** by a dogfood-surfaced fix (PAR-195),
  with residual tracker-state follow-ups called out below.
- **Scope / hard-stop:** docs-only. No source, tests, config, `tasks.json`, launcher,
  or Symphony/OpenClaw state touched. No push / tag / publish / release / version bump.
  No Linear mutation — state changes are recorded as follow-ups for the human/orchestrator.

---

## Why this doc closes the gap

Both the work ledger (`WORK-LEDGER.md`, PAR-158 entry) and the CC-000 closeout
(`research/RESULT-par-149-cc000-closeout-2026-06-23.md`, "Follow-ups") name the same
single remaining gap:

> Remaining work: write the CC-006 closeout that consolidates the existing markers
> against the four acceptance criteria, or formally mark PAR-158 superseded by the
> PAR-189..195 runs.

No prior doc cited CC-006/PAR-158 as the umbrella for those runs. This file supplies
that missing consolidation and the AC4 report artifact.

## Acceptance criteria → evidence

The four criteria come from the CC-006 intake record
(`research/linear-command-central-orchestration-plan-2026-05-27.json`, mirrored in
`research/cc-linear-intake-receipt-2026-06-23.json`).

### AC1 — At least one issue is run from Linear/project intake through visible launcher execution and reviewed completion → **MET**

- **Selection = Linear/project intake.** In every run the Symphony source-run daemon
  selected the issue via `tracker.required_labels: [ready-for-agent]` scoped to the
  Command Central project slug — not ad-hoc pickup.
- **Visible launcher execution.** Each selected issue was routed to a visible Claude
  Code implementation lane with the launcher's canonical `symphony-<ticket>-<hash>`
  id shape:
  - **PAR-189** — eight independent lanes reached this repo
    (`symphony-PAR-189-a44186ea`, `-677888b0`, `-1a79282f`, `-f336fff5`, `-3051fd73`,
    `-374b3c3e`, `-febb96c4`, `-6d4c7303`), several in Agent Teams DELEGATE mode
    (team lead + Implementer + Tester). Evidence:
    `research/PAR-189-DOGFOOD-MARKER-2026-06-17.md`.
  - **PAR-193** — `symphony-PAR-193-2f96209e`, Agent Teams DELEGATE mode. Evidence:
    `research/PAR-193-DOGFOOD-MARKER-2026-06-17.md`.
- **Reviewed completion with real code (strongest instance).** **PAR-195** ran the
  full loop and shipped a *behavioral* change, not just a marker:
  - Commits in this repo's history: `515e1321` (`feat(agent-status): suppress
    ambiguous attention badge for completed detached Symphony lanes`) and `3ea8bb31`
    (`test(agent-status): cover completed detached Symphony lane attention
    suppression (PAR-195)`), plus verification markers `d2c16143` / `fed745da`.
  - 18-test focused suite; `just check` clean (biome + tsc). Evidence:
    `research/PAR-195-COMPLETED-DETACHED-SYMPHONY-LANE-2026-06-17.md`.

### AC2 — Command Central shows workstream, attempt state, health state, and evidence links accurately during the run → **MET (and hardened by the run itself)**

- The Symphony lanes surfaced in the Agent Status tree as live/terminal rows keyed by
  their `symphony-<ticket>-<hash>` ids — the workstream + attempt-state projection was
  exercised end-to-end by the runs above.
- The dogfood window did more than *observe* the projection — it **caught an accuracy
  defect in it and fixed it**: completed detached Symphony lanes were rendering the
  ambiguous yellow `⚠ detached` / "manual observation required" attention signal even
  though their completion was already auto-reported by the launcher finalizer. PAR-195
  reclassified them as orchestrated / no-action-needed (muted), so the attention-state
  rendering is now accurate. A dogfood run improving the very visibility surface AC2
  measures is direct, committed proof the surface was under real scrutiny.
- Corroborating same-window projection-accuracy hardening (all committed under
  `research/`): `AGENT-STATUS-LIVE-TERMINAL-STATE-FIX-2026-06-15.md`,
  `CC-STALE-REVIEW-LANE-LIVE-ROW-2026-06-16.md`,
  `CC-REVIEW-STATE-PROJECTION-HARDENING-2026-06-16.md`,
  `AGENT-STATUS-TEAM-LANE-VISIBILITY-2026-06-15.md`.

### AC3 — Failures or stale states become follow-up issues in the same project, not ad-hoc chat memory → **MET**

- **Canonical proof: PAR-195.** A defect *observed during dogfooding* (completed
  detached Symphony lane reading as ambiguous attention) became its own tracked Linear
  issue in the same PartnerAI / Command Central project, was implemented + tested +
  reviewed, and closed with the commits above and a `research/` receipt — not chat
  memory.
- **Failure captured as evidence: PAR-191.** The daemon-spawned Codex worker failed
  immediately (configured model `gpt-5-codex` unsupported on the local ChatGPT
  account). Rather than being lost, the failure and the fallback-lane recovery were
  recorded as durable dogfood provenance in
  `research/PAR-191-DOGFOOD-MARKER-2026-06-16.md`.

### AC4 — A short dogfood report records what was fixed and what remained blocked → **MET by this file**

- **What was fixed / delivered by the dogfood loop:**
  - PAR-195 — accurate completed-detached Symphony lane rendering (code + 18 tests).
  - PAR-189 / PAR-193 — full-circle Symphony → Command Central path proven across
    eight + one visible lanes, several exercising the Agent Teams DELEGATE multi-agent
    path.
  - The projection-accuracy hardening cluster listed under AC2.
- **What remained blocked / open (see next section).**

## What remained blocked / open

- **Tracker state (owed to human/orchestrator, not this docs lane):** PAR-158 is still
  Backlog in Linear; flipping it to Done — or formally marking it superseded by the
  PAR-189..195 runs — is a tracker mutation outside this repo's hard-stop scope.
- **Named-blocker states:** CC-006's cited prerequisites are not uniformly Done —
  CC-001/PAR-38 and CC-003/PAR-154 are Done, but CC-005/PAR-157 (conductor daemon
  design) is still open (`research/DESIGN-cc-005-conductor-daemon-slice-2026-06-24.md`).
  The dogfood loop ran successfully without a fully-closed CC-005, so CC-005 gated the
  *designed* conductor, not the *demonstrated* orchestration.
- **Toolchain:** the PAR-191 Codex-model incompatibility (`gpt-5-codex` unsupported on
  the local account) remains an environment constraint for Codex-worker lanes; the
  Claude Code visible lanes were unaffected.
- **Scope honesty:** this closeout consolidates *existing committed* evidence. It is
  not a fresh live run, and it deliberately performs no tracker or config mutation.

## Provenance (all pre-existing, committed)

| Artifact | Role |
| --- | --- |
| `research/PAR-189-DOGFOOD-MARKER-2026-06-17.md` | AC1 — 8 visible lanes, full-circle path |
| `research/PAR-191-DOGFOOD-MARKER-2026-06-16.md` | AC3 — captured Codex worker failure + fallback recovery |
| `research/PAR-193-DOGFOOD-MARKER-2026-06-17.md` | AC1 — DELEGATE-mode visible lane |
| `research/PAR-195-COMPLETED-DETACHED-SYMPHONY-LANE-2026-06-17.md` | AC1/AC2/AC3 — reviewed code fix + follow-up issue |
| `research/linear-command-central-orchestration-plan-2026-05-27.json` | CC-006 intake record (the 4 criteria) |
| `research/cc-linear-intake-receipt-2026-06-23.json` | live apply receipt (PAR-158 comment) |
| `research/RESULT-par-149-cc000-closeout-2026-06-23.md` | parent CC-000 closeout naming this follow-up |
| git `515e1321`, `3ea8bb31`, `d2c16143`, `fed745da` | PAR-195 committed code/tests/markers |

## Follow-ups (out of scope here)

- Flip **PAR-158** Backlog → Done in Linear (or mark superseded by PAR-189..195),
  linking this closeout as the AC4 report.
- Optionally close the sibling per-child gaps noted in the CC-000 closeout
  (CC-002/004/005).

---

## Evidence-currency update — 2026-07-03 (PAR-158 re-run)

Re-verified as the visible Symphony implementation lane for PAR-158
(`symphony-PAR-158-bcc04861`), attached to the issue-scoped OpenClaw workroom
`discord:channel:1522107172337487914`. The 2026-07-02 body above was accurate on
its date; this dated addendum records the evidence that has landed **since** rather
than rewriting it. The tree advanced from the PAR-189..195 snapshot to HEAD
`b19ba454` (`main`, `ostehost`). The CC-006 verdict is unchanged — AC1/AC3/AC4 met,
AC2 met-and-hardened — and is now backed by additional committed instances.

### This run is itself a fresh AC1 instance

AC1 asks for "at least one issue run from Linear/project intake through visible
launcher execution and reviewed completion." This PAR-158 re-run is one more: the
Symphony daemon selected PAR-158 from the PartnerAI / Command Central project,
routed it to a visible Claude Code lane with the canonical launcher id
`symphony-PAR-158-bcc04861`, and its closeout is workroom-routed for review — not
ad-hoc pickup. It runs on the hub (`ostehost`), the counterpart to the node-side
runs cited above.

### Corroborating AC2 hardening that post-dates the closeout (2026-07-02 → 2026-07-03)

The AC2 verdict — "met (and hardened by the run itself)" — rests on the visible-lane
attention/health projection surface staying under real scrutiny and getting more
accurate. Two changes landed after 2026-07-02 that harden that exact surface,
extending the corroborating hardening cluster the body already lists under AC2:

- **PAR-322 — `5b16b047` `feat(providers): detect visible Claude permission/input
  waits`.** A live interactive lane blocked on a permission/input prompt previously
  looked identical to an idle REPL; the pane is now read on the already-stuck path
  and a genuine wait renders "(awaiting input)" with an actionable tooltip and a
  louder icon, so the attention/health state is accurate instead of coarse. Full
  suite green (2632 pass / 0 fail).
- **PAR-323 — `b19ba454` `feat(providers): project native visible-lane attention
  receipts`.** Adds the seam to *project* an OpenClaw/Symphony daemon-confirmed
  `awaiting_input` / `attention` verdict — the cross-project orchestration health
  signal central to CC-006 — while keeping Command Central a projector, not the
  source of truth (fail-closed to null on any unrecognized token). Suite green
  (2649 pass / 0 fail). Contract recorded in
  `research/PAR-323-NATIVE-VISIBLE-LANE-ATTENTION-PROJECTION-2026-07-03.md`.

Both keep the surface AC2 measures accurate rather than coarse; PAR-323 specifically
wires the projection seam for the OpenClaw/Symphony health that this issue is about.

### The named OpenClaw-DOWN example now has its own receipt (AC3 / AC4)

CC-006's problem statement names "the OpenClaw DOWN indicator" as the archetypal
real issue. On 2026-07-03 **CC-002 / PAR-152** ("Define OpenClaw health truth
contract") was run as its own visible Symphony lane (`symphony-PAR-152-a6ee5f41`,
`ostehost`) and filed `research/RESULT-cc-002-openclaw-health-truth-contract-2026-07-03.md`
(committed `00eb6bfc`), re-verifying the auth-failed six-state OpenClaw health-truth
model against the current tree with fresh green verification (health suite 24/0,
test-unit 788/0, `just check` clean). That is a captured health-surface concern
becoming a tracked issue with a durable committed receipt — AC3 — not chat memory,
and a second short report of the kind AC4 asks for.

### Updated follow-up ledger

- ~~Optionally close the sibling per-child gap for **CC-002**~~ — **done** as of
  2026-07-03: `RESULT-cc-002-openclaw-health-truth-contract-2026-07-03.md`
  (`00eb6bfc`).
- **CC-004 / CC-005** per-child gaps — still open/optional. CC-005 / PAR-157
  (conductor daemon design) remains Backlog
  (`research/DESIGN-cc-005-conductor-daemon-slice-2026-06-24.md`); as the body notes,
  it gates the *designed* conductor, not the *demonstrated* orchestration this issue
  exercises.
- The parent CC-000 refresh (`5c997fe8`, 2026-07-03) already recorded this closeout
  as discharging the "write the CC-006 closeout" follow-up; cross-linked here for
  currency.
- Flip **PAR-158** → Done in Linear (or mark superseded), linking this file as the
  AC4 report — still open; a tracker mutation owned by the human/orchestrator and out
  of scope for this code lane. (The 2026-07-02 body reads "Backlog"; the current
  intake record shows the issue as `Todo` — either way the flip is owed to the
  orchestrator. No live Linear pull or mutation was performed by this update.)

### Hard-stop compliance (this update)

Docs-only; a single existing file was appended (no new files). No source / test /
config / `tasks.json` / launcher / Symphony / OpenClaw state touched. No Linear
mutation. No push / tag / publish / version bump.
