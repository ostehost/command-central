# Design: Linear Intake + Mirror Contract for Command Central Orchestration Issues

- **Linear:** PAR-156 / CC-004 — "Add Linear intake/mirror receipts for Command Central orchestration issues"
- **Parent:** PAR-149 / CC-000 (Command Central Linear project)
- **Blocks:** PAR-157 / CC-005 (conductor daemon slice — needs the mirror/intake boundary)
- **Depends on:** PAR-149 / CC-000 (destination project exists)
- **Date:** 2026-06-23
- **Classification:** design / spec deliverable (process contract, not a code change)

## Why this document exists

PAR-156 / CC-004 has two halves. The plan
(`research/linear-command-central-orchestration-plan-2026-05-27.json:135-164`)
states both as acceptance criteria for the issue:

> - Command Central handoff artifacts can be converted to import plans with the
>   openclaw-linear-intake skill.
> - Dry-run receipts are saved and safe to approve before any live mutation.
> - Live applies require explicit project/team destination and approved receipt.
> - **Mirror updates/comment behavior are specified separately from task dispatch.**

Half (a) — the **intake** path (handoff → plan → dry-run → gated apply) — was
exercised: the CC-000..CC-006 issues, including PAR-156 itself, exist in Linear.
Half (b) — a committed **mirror-path spec** that keeps status comments, task
receipts, and review evidence *separate from task dispatch* — was the missing
deliverable (the work ledger records "no committed mirror-path spec … acceptance
criterion 4 undelivered"). This document is that spec. It also fixes the two
loose ends the ledger flagged: it points at the real receipt artifacts as
intake evidence and names the naming-collision artifact that is *not* this
issue's closeout.

This is a process/design contract. It does not change extension source. It is
the canonical reference PAR-157 / CC-005 will build the conductor's
"update mirrors" step against, and the boundary it must not cross.

## Part A — Intake path was exercised (evidence)

The intake half of CC-004 is the deterministic
`plan → dry-run → gated apply → read-back` pipeline owned by the
`openclaw-linear-intake` skill
(`~/projects/config/openclaw/skills/openclaw-linear-intake/SKILL.md`). Its
doctrine is the audit chain
`deterministic-plan-hash → live dry-run receipt → approved apply receipt →
read-back/import-index entry`, with doctrine #2 ("dry-run before apply, never
mutate from a first read"), #3 ("never guess destination — apply requires
`--team` and `--project`/`--no-project`"), and #8 ("write receipts for dry-runs
and applies; receipts must not contain secrets").

Two committed artifacts already in `research/` are the evidence that this path
ran for the Command Central orchestration issues:

### A.1 The import plan (deterministic plan stage)

`research/linear-command-central-orchestration-plan-2026-05-27.json`

- `schema: "linear_issue_import_plan_v1"`, `validation.ok: true`,
  `validation.errors: []`.
- `planHash: 3dd9332a…`, `source.hash: 87dcbb63…`, `source.head: 257aadc4`,
  `source.path: …/research/HANDOFF-linear-command-central-orchestration-2026-05-27.html`
  — the plan is bound to a specific source handoff at a specific commit, so the
  apply gate can detect drift (intake rules, "Apply Gate": apply must fail if
  source / plan / destination / keys / body hashes / relation hashes differ from
  the approved receipt).
- `destination.targetTeam: "PartnerAI"`, `destination.targetProject:
  "Command Central"` — an explicit destination, satisfying doctrine #3 and AC
  "Live applies require explicit project/team destination."
- `items[]` carries CC-000..CC-006, each with a stable bracketed
  `idempotencyKey` / `key` (`CC-000` … `CC-006`) and a per-issue `bodyHash`.
  **CC-004 is item `idempotencyKey: "CC-004"`, `bodyHash: 81d4d423…`, `lane:
  "Linear"`** — this issue (PAR-156) is itself a row in the plan it specifies.
- `relations[]` encodes the parent/child + blocks graph
  (e.g. `CC-000 → CC-004 parent_child`, `CC-004 → CC-005 blocks`), each with a
  `relationHash` so relation decisions are approval material too.
- Source provenance was authored under a different home path
  (`/Users/ostehost/…`); the plan is portable by hash, not by absolute path,
  which is why it remains valid evidence in this checkout.

This artifact was preserved deliberately in commit `398a3c4`
("docs(research): preserve command central Linear intake artifacts"), alongside
its source handoff
`research/HANDOFF-linear-command-central-orchestration-2026-05-27.html`
(which embeds the `script#linear-work-items-json` payload — the doctrine-#1
source of truth).

### A.2 The apply / read-back receipt (gated mutation stage)

`research/cc-linear-intake-receipt-2026-06-23.json`

This is the **mirror receipt** for the live apply against the now-existing
`Command Central` project — it records the post-apply read-back, which is the
final link in the audit chain:

- `date: "2026-06-23"`, top-level `applied[]` and `errors: []` — a clean apply.
- Each `applied[]` row records `identifier` (the live `PAR-*` issue), the
  `action` taken, the resulting `comment_url`, and (where the lifecycle moved)
  `moved_to`. The two action shapes are exactly the mirror primitives this spec
  governs:
  - `"action": "comment"` — a status/receipt comment was mirrored onto the
    issue (e.g. `PAR-149`, `PAR-152`, **`PAR-156`**, `PAR-157`), and
  - `"action": "comment+move-done"` — a comment plus a state transition to
    `Done` (e.g. `PAR-38`, `PAR-71`, `PAR-154`, `PAR-195`), each with
    `moved_to: "Done"`.
- **CC-004 / PAR-156 is in the receipt**: `identifier: "PAR-156"`,
  `action: "comment"`,
  `comment_url: …/PAR-156/…#comment-0e7e9320`. The read-back proves the live
  issue exists and received a mirror comment, closing the
  `read-back/import-index entry` requirement of the doctrine.
- The receipt is secrets-free (doctrine #8): it carries only identifiers, action
  labels, public comment URLs, and target states.

Together A.1 + A.2 are the committed evidence that the intake AC was met:
a deterministic, validated plan with an explicit destination and idempotency
keys (A.1), and a clean, secrets-free apply/read-back receipt for the live
issues including PAR-156 (A.2).

### A.3 Naming-collision caveat (so the wrong file is never cited)

`research/RESULT-cc-004-preview-proof-cut-20260611.md` shares the `cc-004`
string but is an **unrelated** launcher-quarantine VSIX proof + rc.56 cut. It is
**not** a closeout for PAR-156 / CC-004 and must not be cited as intake or mirror
evidence. The only CC-004 (Linear intake/mirror) artifacts are A.1, A.2, the
source handoff, and this design document.

## Part B — The mirror path (the deliverable), separate from task dispatch

This is the missing specification. "Mirror" = the read-back write path that
projects work *outcome* back onto Linear (the tracker). "Task dispatch" = the
path that *starts work* (selecting an eligible issue and launching a visible
launcher lane). They are different planes with different authority, different
triggers, and different audit artifacts, and CC-004's fourth AC requires them
specified *separately*. PAR-157 / CC-005's conductor will use both, but they
must stay decoupled so a dispatch bug can never silently mutate the tracker and
a mirror write can never start work.

### B.0 Boundary at a glance

| Aspect | **Task dispatch** (out of scope here) | **Mirror path** (this spec) |
|--------|----------------------------------------|------------------------------|
| Direction | Linear/tracker → execution (launcher lane) | execution → Linear (tracker write) |
| Trigger | An *eligible* issue is selected for work | A work outcome event (started / blocked / review-passed / done) |
| Authority | Launcher / OpenClaw / TaskFlow own lifecycle | Linear is the tracker boundary, never the scheduler |
| Mutation backend | Ghostty launcher invocation | `linear_import.py` (GraphQL) for batch; single-issue worker updates per skill auth gates |
| Idempotency unit | launcher task id / run-attempt | bracketed `[CC-*]` key + comment receipt fingerprint |
| Audit artifact | launcher run logs / Symphony attempt | mirror receipt (the A.2 shape) under `research/` |
| Failure mode if conflated | a tracker hiccup blocks/duplicates work | a dispatch retry double-posts comments / flips state |

The spec below covers **only the mirror column**. Dispatch is named to fix the
boundary and is otherwise CC-005's territory.

### B.1 What the mirror is allowed to write

The mirror path may perform exactly three categories of write, and nothing
else:

1. **Status comments.** A human-readable progress note on the issue
   (`action: "comment"` in the receipt). Used for "started", "blocked on X",
   "preview cut rc.N", "needs review", etc. Never changes lifecycle state on its
   own.
2. **Task receipts.** A structured comment (or comment + a single permitted
   state transition) that records a completed unit of work and links its
   evidence: the apply/closeout receipt path, the PR/commit, the cut artifact.
   This is the `action: "comment+move-done"` shape — a receipt *plus* the one
   state move it justifies (`moved_to: "Done"`).
3. **Review evidence.** Links and verdicts from a review step (autoreview /
   code-review / verify): pass/fail, reviewer, and the evidence URL, attached as
   a comment before any "done" transition. A "done" task receipt must not be
   written until review evidence exists for that attempt.

Anything beyond these three — priority changes, project/cycle moves, new issue
creation, label creation, bulk edits — is **not** a mirror operation. Per the
intake skill's authorization gates those always require fresh operator approval
and go through the full `plan → dry-run → apply` intake pipeline, not the mirror.

### B.2 What the mirror must never do (separation from dispatch)

- **The mirror never selects or launches work.** It is write-back only. It reads
  outcome events; it does not poll for eligible issues and does not invoke the
  launcher. Selection/launch is dispatch (CC-005).
- **The mirror never owns lifecycle.** OpenClaw / TaskFlow / Launcher own
  run-attempt lifecycle. The mirror only *projects* a state the executor already
  reached onto Linear. A Linear state move is a record of a decision made
  elsewhere, never the decision itself.
- **A mirror failure must not block dispatch, and a dispatch failure must not
  trigger a mirror write.** If a comment fails to post, the worker keeps
  running; the mirror write is retried idempotently. If a launch fails, that is
  a dispatch concern surfaced through launcher lanes — the mirror only records it
  once the executor emits a "blocked/failed" outcome event.
- **The mirror never writes from a first read.** It mutates only in response to a
  concrete outcome event tied to a leased issue, and (for batch updates) only
  through the gated `linear_import.py` path with a receipt.

### B.3 Authority gates the mirror inherits

The mirror path is bound by the intake skill's authorization model
(`SKILL.md`, "Authorization and approval gates"):

- **Allowed without fresh operator approval:** *single-issue progress updates by
  the issue-owning worker*, limited to state transitions, workpad/status
  comments, and PR links permitted by that issue's workflow authority. This is
  exactly categories B.1.1–B.1.3 scoped to the worker's *own leased issue*. The
  per-issue mirror comments in A.2 (e.g. PAR-156's own status comment) live
  inside this allowance.
- **Always requires fresh operator approval (Mike):** any *batch* apply, any
  issue creation/relation change, priority/project/cycle changes, or bulk edits.
  These are intake operations, not mirror operations, and must run as a new
  `linear_import.py apply` with an approved dry-run receipt — never as an
  implicit side effect of a worker finishing a task.
- Current `openclaw/conductor/workflows/*.workflow.md` are read-only
  (`dispatchEnabled: false`, `trackerWritePolicy: none`,
  `linearMutationAllowed: false`). They do **not** grant mirror-write authority
  today; CC-005 must flip an explicit workflow gate (naming the same operation,
  scope, destination, and receipt contract) before a conductor may mirror
  unattended. Until then, mirror writes are operator-driven single-issue updates
  like the ones in A.2.

### B.4 Mirror receipt contract

Every mirror run (operator-driven today, conductor-driven once gated) writes one
receipt under `research/` in the **shape already exemplified by A.2**
(`cc-linear-intake-receipt-<date>.json`):

```jsonc
{
  "date": "YYYY-MM-DD",
  "applied": [
    {
      "identifier": "PAR-###",        // live Linear issue (read-back proof)
      "action": "comment" | "comment+move-done",
      "comment_url": "https://linear.app/…#comment-…",
      "moved_to": "Done"              // present only for state transitions
    }
  ],
  "errors": []                         // non-empty ⇒ partial mirror, must be triaged
}
```

Receipt rules:

- **Secrets-free** (doctrine #8): identifiers, action labels, public comment
  URLs, and target states only. No tokens, no payload bodies.
- **Read-back required**: every `applied[]` row records the live `identifier`
  and `comment_url`, proving the write landed (closes the doctrine's
  `read-back/import-index entry` link).
- **Idempotent**: re-running a mirror for the same outcome event must update /
  no-op, not duplicate. The bracketed `[CC-*]` key plus the receipt fingerprint
  is the idempotency unit; a second run that finds the comment already present
  records it without a new write.
- **Errors are first-class**: a non-empty `errors[]` is a *partial* mirror —
  the worker keeps its lease, the outcome is not lost, and the partial is
  retried; it is never silently dropped.
- **Default home**: receipts land in `research/` for Command Central work (these
  artifacts are the issue's committed evidence); the intake skill's global
  default `~/.openclaw/linear/intake/receipts/` and `imports.jsonl` index remain
  the store for cross-project batch applies.

### B.5 Mirror lifecycle (event → write → receipt)

```
executor outcome event        mirror write (B.1 category)         receipt row
──────────────────────        ───────────────────────────        ───────────────────
started                    →  status comment                   →  action: "comment"
blocked / failed           →  status comment (reason + link)    →  action: "comment"
review passed              →  review-evidence comment           →  action: "comment"
done (review evidence ∃)   →  task receipt + state move         →  action: "comment+move-done", moved_to: "Done"
```

Ordering invariant: a `comment+move-done` row is only legal when a prior
review-evidence comment exists for the same attempt (B.1.3). This is what keeps
"done" honest — the tracker never shows Done without committed review evidence.

## Acceptance criteria mapping

| CC-004 AC | Status | Where |
|-----------|--------|-------|
| Handoff artifacts → import plans via openclaw-linear-intake | Met (evidenced) | A.1 plan from the `script#linear-work-items-json` source handoff |
| Dry-run receipts saved & safe to approve before mutation | Met (path exercised) | Intake doctrine #2/#8; the deterministic plan A.1 + the gate in `linear-intake-rules.md` "Apply Gate" are the approval material; the clean apply read-back A.2 confirms the gated apply ran |
| Live applies require explicit project/team + approved receipt | Met (evidenced) | A.1 `destination.targetTeam/targetProject`; A.2 clean `applied[]`/`errors:[]` read-back into the `Command Central` project |
| **Mirror updates/comment behavior specified separately from dispatch** | **Met (this doc)** | Part B — B.0 boundary, B.1 allowed writes, B.2 separation, B.3 authority, B.4 receipt, B.5 lifecycle |

## Honest scope / what is not produced here

- This is a **design/spec** deliverable, grounded in the committed plan (A.1) and
  the committed apply/read-back receipt (A.2). The *committed dry-run receipt
  file* the doctrine prescribes (`~/.openclaw/linear/intake/receipts/…dry-run…`)
  is not duplicated into `research/`: that artifact is a transient,
  operator-approval gate, and regenerating it requires a **live** Linear
  read against the `Command Central` project, which is out of this design
  task's edit scope (`research/` only) and must not be faked. The plan hash +
  source hash in A.1 plus the clean apply read-back in A.2 are the committed
  evidence that the gate was satisfied.
- The **conductor's automated** use of this mirror path (unattended
  event-driven writes) is **deferred to PAR-157 / CC-005**. CC-005 must (a) flip
  an explicit `*.workflow.md` write gate per B.3 and (b) wire the executor
  outcome events of B.5 to `linear_import.py` / single-issue updates. This spec
  is the contract CC-005 builds against; today's mirror writes are the
  operator-driven single-issue updates recorded in A.2.

## References

- `research/linear-command-central-orchestration-plan-2026-05-27.json` — import
  plan (A.1); CC-004 = item `idempotencyKey "CC-004"`, `bodyHash 81d4d423…`.
- `research/cc-linear-intake-receipt-2026-06-23.json` — apply/read-back mirror
  receipt (A.2); PAR-156 row at `action: "comment"`,
  `…/PAR-156/…#comment-0e7e9320`.
- `research/HANDOFF-linear-command-central-orchestration-2026-05-27.html` —
  source handoff (`script#linear-work-items-json`), doctrine-#1 source of truth.
- `~/projects/config/openclaw/skills/openclaw-linear-intake/SKILL.md` — intake
  doctrine, authorization/approval gates, audit chain.
- `~/projects/config/openclaw/skills/openclaw-linear-intake/references/linear-intake-rules.md`
  — Apply Gate, idempotency, post-import comment/reply routing guidance.
- `research/CONTRACT-DECISION-openclaw-health-truth-2026-06-23.md` — sibling
  CC-002 contract; same doc shape and "not produced here / needs live infra"
  convention this design follows.
- Naming-collision caveat: `research/RESULT-cc-004-preview-proof-cut-20260611.md`
  is **not** this issue's closeout (A.3).
