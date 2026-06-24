# Design: Conductor Daemon Slice (Symphony vocabulary on OpenClaw authority)

- **Linear:** PAR-157 / CC-005 — "Design conductor daemon slice using Symphony vocabulary on OpenClaw authority"
- **Parent:** PAR-149 / CC-000 (Command Central Linear project)
- **Depends on (done):** PAR-154 / CC-003 (visibility projection shape)
- **Depends on (active):** PAR-156 / CC-004 (tracker intake/mirror boundaries)
- **Blocks:** PAR-158 / CC-006
- **Date:** 2026-06-24
- **Classification:** design / spec deliverable (architecture contract, not a code change)

## Why this document exists

CC-005 is the first design that asks Command Central to *drive* work, not only
*watch* it. Every prior CC design deliberately scoped CC out of the scheduler
role:

- `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md:9` — "Command
  Central should not port Symphony as a scheduler."
- `research/PLAN-symphony-vscode-native-integration-2026-05-09.md:9` — "a VS
  Code-native status surface and operator control router, **not** as the
  Symphony scheduler/runner," with a Non-Goals list that explicitly rejects
  "Polling Linear directly", "Owning retry/backoff timers", and "Restart
  recovery for scheduler state" (`:45-50`).

PAR-157's acceptance criteria require the opposite shape — a loop that *polls*
eligible work, *selects* it, *launches* lanes, *reviews* completions, *retries*
when safe, and *updates* mirrors, with crash-safe receipts and repo-owned
config. This document is that design. **It explicitly reconciles and partially
supersedes the "CC is observability-only" boundary** (see "Reconciling the
prior boundary"). It does so without making Command Central a second lifecycle
ledger: OpenClaw, TaskFlow, and Ghostty Launcher remain the lifecycle owners.
The conductor is a *thin selection + dispatch + mirror coordinator* that sits
*above* those owners and *uses* the surfaces CC already projects, never a
replacement for them.

This is a process/architecture contract. It changes no extension source. It is
the canonical reference PAR-158 / CC-006 (and any future conductor
implementation lane) builds against, and the boundary that implementation must
not cross.

## Reconciling the prior boundary (what is superseded, what is preserved)

The prior boundary is **narrowed, not deleted.** The precise reconciliation:

| Prior rule (PLAN / visibility SPEC) | CC-005 disposition |
|-------------------------------------|--------------------|
| "CC is a status surface, NOT the scheduler/runner" | **Superseded for one new, separately-deployed component only.** The conductor daemon is a distinct process (`conductor` lane), not the VS Code extension. The *extension* stays observability-only; the *daemon* schedules. They share vocabulary and projection artifacts, not a process. |
| "CC MUST NOT claim, dispatch, retry, reconcile, or mutate lifecycle state directly" (`PLAN:19`) | **Preserved with one carve-out.** The conductor may *select* an eligible issue and *request* a launch — but it never executes the agent itself, never mutates `runs.sqlite`/`tasks.json`, and never owns terminal state. It calls the launcher (which writes the OpenClaw ledger per the CC-OPENCLAW-NATIVE-LOOP target). Lifecycle authority stays with OpenClaw/TaskFlow/Launcher. |
| Non-Goal: "Polling Linear directly" (`PLAN:45`) | **Superseded for the daemon, scoped.** The conductor polls the tracker for *eligible* issues through the **read-only** intake reader, not through a new bespoke Linear client in the extension. The extension still never polls Linear. |
| Non-Goal: "Owning retry/backoff timers" (`PLAN:48`) | **Partially superseded.** The conductor owns a *dispatch-level* retry policy (re-attempt a failed *lane launch* when safe). It does **not** own *run-attempt* retry — once a lane is live, OpenClaw/TaskFlow own its retry/stall/reconcile, exactly as before. |
| Non-Goal: "Restart recovery for scheduler state" (`PLAN:50`) | **Superseded — this is the core new obligation.** The conductor MUST be crash-safe: its lease + receipt store survives restart so it never double-launches or loses an in-flight attempt (§5). |
| Non-Goal (visibility SPEC): "Write tracker state" (`SPEC:36`) | **Preserved by delegation.** The conductor never writes Linear inline. All tracker writes route through the CC-004 **mirror path** (`DESIGN-cc-004-linear-intake-mirror-contract-2026-06-23.md`), behind the workflow write-gate (§6). |

Net effect: the **VS Code extension remains exactly what every prior doc says it
is.** CC-005 introduces a *new sibling process* in the Command Central project
that is allowed to schedule, governed by the boundaries below. The two are
coupled only through (a) shared Symphony vocabulary and (b) the CC projection
artifacts the daemon emits for the extension to render (§7, AC-4).

## Vocabulary lock (Symphony terms on OpenClaw authority)

The conductor speaks Symphony, but every noun maps to an owner record already
projected by CC (`PLAN:13-17`, `SPEC-codex-symphony-visibility-layer`):

| Symphony term | Conductor meaning | Lifecycle owner (authority) |
|---------------|-------------------|-----------------------------|
| **Issue** | An eligible tracker work item the loop may select | Linear (tracker boundary, never scheduler) |
| **Run Attempt** | One launched lane for one selected issue, projected as `CodexRunView` | OpenClaw `runs.sqlite` / Launcher |
| **Workstream** | A TaskFlow group of related run attempts | TaskFlow |
| **Live Session** | The launcher/OpenClaw session backing a run attempt | Ghostty Launcher / OpenClaw |
| **Retry Entry** | A conductor-level re-dispatch decision (lane launch), surfaced as `SymphonyRetryEntryView` | Conductor owns *dispatch* retry; OpenClaw owns *run-attempt* retry |
| **Reconciliation** | Detecting lease/world drift (lane dead but issue still leased) and releasing the lease | Conductor releases its own lease only; never mutates owner state |
| **Status Surface** | The VS Code Symphony tree/status-bar that renders all of the above | Command Central extension (observability) |

Run-attempt phase vocabulary is unchanged from the visibility SPEC and stays
the authoritative lifecycle language: `PreparingWorkspace`, `BuildingPrompt`,
`LaunchingAgentProcess`, `InitializingSession`, `StreamingTurn`, `Finishing`,
`Succeeded`, `Failed`, `TimedOut`, `Stalled`, `CanceledByReconciliation`. The
conductor never invents new phase names; it reads them from owner records via
`CodexRunObserverService`.

## Architecture at a glance

```
            ┌──────────────────────── repo-owned config (§4) ──────────────────────┐
            │  tracker · eligible-states · workspace-root · concurrency · retry ·   │
            │  hooks · prompt-template      (WORKFLOW.md "Conductor" section +      │
            │                                conductor.config.* / *.workflow.md gate)│
            └───────────────────────────────────────────────────────────────────────┘
                                            │ reads
                                            ▼
  (1) POLL ───────────► (2) SELECT ───────► (3) LAUNCH ──────► (4) REVIEW ──────► (5/6) RETRY/UPDATE
  read-only tracker      eligible &          Ghostty launcher    autoreview/        dispatch-retry
  reader (CC-004 intake  not-leased &        lane ONLY           code-review/        when safe (conductor)
  read side) + CC        under concurrency   (visible terminal,  verify on the       +
  projection             cap → acquire       writes OpenClaw     completed lane      MIRROR write (CC-004
  (SymphonyRuntime-      crash-safe lease    ledger)                                 mirror path) behind
  SnapshotView)                                                                      write-gate
        ▲                     │                    │                  │                    │
        └──── crash-safe receipt store (§5): lease + per-step receipt under research/ ─────┘
                                            │ emits projection artifacts (§7)
                                            ▼
                        Command Central extension Status Surface (read-only)
```

Authority invariant (holds at every step): **the conductor decides *whether* and
*when* to start/retry/mirror; the owners decide *what the work state is*.** The
conductor never writes `runs.sqlite`, `tasks.json`, OpenClaw task state, or
Linear inline; it calls owner-owned entry points (launcher invocation, CC-004
mirror path) and reads owner-owned truth back.

## §4 — Repo-owned conductor config (AC-1)

> AC-1: *A repo-owned WORKFLOW.md or equivalent config defines tracker, eligible
> states, workspace root, concurrency, retry, hooks, and prompt template.*

Today `WORKFLOW.md` is build/test recipes only; a grep for
`conductor|tracker|eligible|concurrency|retry|prompt template|workspace root`
returns zero hits (ledger evidence). This spec defines the canonical config and
where it lives. Two-layer config, by authority:

1. **`WORKFLOW.md` → new "Conductor" section** (operator-readable defaults, the
   human contract). Holds the seven required keys with safe defaults.
2. **`conductor.config.jsonc`** (machine-readable, repo root or `conductor/`)
   — the same keys the daemon actually loads; `WORKFLOW.md` documents it.
3. **Mutation authority stays in `openclaw/conductor/workflows/*.workflow.md`**
   (the CC-004 §B.3 gate files, owned by `~/projects/config/openclaw/`). Config
   below sets *behavior*; the workflow gate sets *whether tracker writes / live
   dispatch are permitted at all*. Until the gate is flipped
   (`dispatchEnabled: true`, `trackerWritePolicy`/`linearMutationAllowed`), the
   conductor runs in **dry-run/observe mode** only.

Config schema (the seven AC-1 keys plus the safety keys the loop needs):

```jsonc
{
  // 1. tracker — which tracker, which scope; read side is the CC-004 intake reader
  "tracker": {
    "kind": "linear",                 // matches Symphony tracker.kind: linear
    "team": "PartnerAI",              // explicit; never inferred (CC-004 doctrine #3)
    "project": "Command Central"      // explicit destination, same as intake plan A.1
  },

  // 2. eligibleStates — which tracker states make an issue selectable
  "eligibleStates": ["Todo", "Backlog"],   // never "In Progress"/"Done"/"Blocked"
  "eligibleLabels": ["conductor-ok"],       // opt-in allowlist; empty = none auto-eligible
  "excludeLabels": ["needs-human", "do-not-automate"],

  // 3. workspaceRoot — where lanes run; the conductor does NOT create per-issue
  //    workspaces (PLAN rejected that); it passes root to the launcher, which owns it
  "workspaceRoot": "/Users/ostehost/projects",
  "execNode": "Mike MacBook Pro",     // node execution-placement (PLAN guardrail)

  // 4. concurrency — max simultaneous live lanes the conductor will hold leases for
  "concurrency": { "maxActiveLanes": 2, "perProjectMax": 1 },

  // 5. retry — DISPATCH-level only (re-launch a failed lane). NOT run-attempt retry.
  "retry": {
    "maxDispatchAttempts": 2,         // per issue, per conductor session
    "backoffMs": 60000,
    "retryableOutcomes": ["launch_failed", "timed_out"],   // never "review_failed"
    "neverRetry": ["contract_failure", "blocked"]          // surface, don't re-launch
  },

  // 6. hooks — owner-owned commands the conductor may REQUEST, never inline-exec
  //    on tracker/source state; these are launcher/OpenClaw entry points
  "hooks": {
    "preLaunch": null,                // optional: validation the launcher runs, not CC
    "review": ["autoreview", "code-review", "verify"],  // §3 review step (read-only)
    "postReview": null
  },

  // 7. promptTemplate — the lane prompt the launcher renders; repo-owned, versioned
  "promptTemplate": {
    "path": "conductor/prompts/cc-lane.md",
    "vars": ["issueIdentifier", "issueTitle", "issueUrl", "workspaceRoot", "acceptanceCriteria"]
  },

  // safety keys the loop requires (§5/§6)
  "pollIntervalMs": 300000,           // 5m; never tighter than tracker rate budget
  "leaseTtlMs": 3600000,              // 1h; lease auto-expires so a crash can't strand an issue
  "receiptsDir": "research/",         // crash-safe receipt home (CC default, §5)
  "mode": "observe"                   // "observe" | "dispatch"; flips ONLY with the workflow gate
}
```

Config rules:
- **No key is inferred.** Missing `tracker.team`/`project` ⇒ refuse to dispatch
  (CC-004 doctrine #3). Missing `promptTemplate.path` ⇒ refuse to launch.
- **`mode: "observe"` is the default and the only mode allowed until the
  `*.workflow.md` gate is flipped** (CC-004 §B.3 — current gates are
  `dispatchEnabled: false`, `trackerWritePolicy: none`,
  `linearMutationAllowed: false`). Observe mode runs poll→select→*plan* and
  writes a would-dispatch receipt, but never launches and never mirrors.
- Config changes are operator commits; the daemon reloads on file change but a
  *gate* change (observe→dispatch) is an explicit, separately-approved edit to
  the OpenClaw workflow file, not a CC config edit.

## §5 — The conductor loop, step by step, with crash-safe receipts (AC-2)

> AC-2: *The conductor loop is specified as poll/select/launch/review/retry/update
> with crash-safe receipts.*

The loop is a single-flight state machine. Each issue moves through states; each
transition writes a **receipt** before its side effect, so a crash between any
two steps is recoverable by reading the store, never by re-deriving from the
world.

### Crash-safety model (the spine of the loop)

Two durable artifacts under `receiptsDir` (`research/`, CC-004 §B.4 default):

1. **Lease store** — `research/conductor-leases.json`. One row per leased issue:
   `{ identifier, runId, leaseAcquiredAt, leaseTtlMs, step, lastReceiptId }`.
   A lease is the *single* anti-double-launch guard. Acquiring a lease is the
   first durable write of SELECT; it is written **before** any launch. On
   restart the daemon reads this file first and resumes each issue *from its
   recorded `step`*, never from scratch.
2. **Step receipts** — `research/conductor-receipt-<date>-<runId>.json`, one
   append-only file per run attempt, in the CC-004 receipt shape extended with a
   conductor envelope:

```jsonc
{
  "schema": "cc_conductor_receipt_v1",
  "runId": "cc-PAR-157-20260624-1410",   // stable, used as lease + lane id
  "identifier": "PAR-157",
  "issueUrl": "https://linear.app/…/PAR-157/…",
  "step": "launch",                       // poll|select|launch|review|retry|update|released
  "at": "2026-06-24T14:10:22Z",
  "mode": "dispatch",
  "evidence": { "promptFile": "…", "streamFile": "…", "handoffFile": "…",
                "pendingReviewPath": "…", "startCommit": "…", "branch": "…" },
  "outcome": "ok" | "launch_failed" | "review_passed" | "review_failed"
             | "timed_out" | "contract_failure" | "blocked",
  "mirror": { "applied": [], "errors": [] },   // CC-004 mirror receipt embedded, §6
  "errors": []
}
```

Receipt rules (inherit CC-004 §B.4 verbatim): **secrets-free**; **read-back
required** (every step that touches an owner records the owner identifier it
read back); **idempotent** (re-running a step for the same `runId`+`step`
no-ops if its receipt already exists — this is what makes restart safe); **errors
first-class** (non-empty `errors[]` ⇒ partial, lease retained, never dropped).

### The six steps

**(1) POLL** — read-only. Reads eligible issues from the **CC-004 intake reader**
(`tracker.kind: linear`, team/project from config) — *the same read-only Linear
path the intake skill uses, never a new extension Linear client*. Also reads
current world state from CC's existing projection: `OpenClawTaskService`,
`TaskFlowService`, `CodexRunObserverService` (so it knows what is already
running). Writes nothing. Cadence = `pollIntervalMs`, never tighter than the
tracker rate budget. **Receipt:** `step: "poll"` with the eligible-candidate
count only (no per-issue write).

**(2) SELECT** — the only place the conductor *decides to start work*. An issue
is selectable iff: state ∈ `eligibleStates`; labels satisfy
`eligibleLabels`/`excludeLabels`; it is **not already leased** (lease store);
it is **not already represented** as a live `CodexRunView` (projection
dedup); and live-lane count `< concurrency.maxActiveLanes` (and per-project cap).
Selection is deterministic (priority, then rank, then identifier — the ledger's
own ordering). On select: **acquire the crash-safe lease first** (durable write),
then write `step: "select"` receipt. If the daemon crashes after lease + before
launch, restart sees `step: "select"` and resumes at LAUNCH (idempotent).

**(3) LAUNCH** — **never bypasses a visible launcher lane (AC-3).** The conductor
calls the Ghostty Launcher entry point (`oste-spawn.sh` family) with the
rendered `promptTemplate`, `workspaceRoot`, `execNode`, and `runId`. The launcher
opens a **visible terminal**, runs the agent, and writes the OpenClaw ledger row
(per the CC-OPENCLAW-NATIVE-LOOP target where launcher spawns
`openclaw tasks register`). The conductor does **not** execute the agent itself,
does **not** write `runs.sqlite`/`tasks.json`, and does **not** background-run a
headless agent. There is **no code path that starts implementation work except
through the launcher** — that is the AC-3 invariant, enforced structurally:
LAUNCH's only side effect is the launcher invocation; the conductor has no
agent-exec capability of its own. **Receipt:** `step: "launch"` with the
launcher-returned lane/run identity read back into `runId` evidence.

**(4) REVIEW** — read-only over owner output. When the lane reaches a terminal
phase (`Succeeded`/`Failed`/`TimedOut`/`Stalled`) AND advertises a
`pending_review_path` receipt, the conductor runs the configured `hooks.review`
chain (`autoreview` / `code-review` / `verify`) **against the completed lane's
output** — these are read-only review tools; they do not mutate lane lifecycle.
Review produces a verdict + evidence URL. A `review_failed` verdict is **not**
dispatch-retryable (config `retryableOutcomes` excludes it): a failed review is
a human/fixup decision surfaced as an attention state, never an automatic
re-launch. **Receipt:** `step: "review"`, `outcome: review_passed|review_failed`,
with the evidence link (this is the CC-004 §B.1.3 review-evidence the mirror
needs before any "done").

**(5) RETRY** — dispatch-level only, bounded. Fires only for
`retryableOutcomes` (`launch_failed`, `timed_out`) and only while
`dispatchAttempts < retry.maxDispatchAttempts`, after `backoffMs`.
`neverRetry` outcomes (`contract_failure`, `blocked`) and `review_failed` are
surfaced, never re-launched. A retry is a **new LAUNCH under the same lease**
(same `runId` family, incremented attempt) — the lease prevents a parallel
duplicate. Run-attempt-level retry (the agent retrying its own turn, OpenClaw
reconciling a stall) is **owner territory and untouched**. Surfaced as
`SymphonyRetryEntryView`. **Receipt:** `step: "retry"` with the attempt number
and the outcome that triggered it.

**(6) UPDATE (mirror)** — the only tracker write, fully delegated to the CC-004
**mirror path**, behind the workflow write-gate. The conductor emits an executor
*outcome event* (`started`/`blocked`/`review passed`/`done`) and the mirror path
(CC-004 §B.5) performs the permitted write: a status comment, or — only when a
prior review-evidence comment exists (§B.1.3 ordering invariant) — a
`comment+move-done`. The conductor **never** writes Linear inline and **never**
moves an issue to Done without committed review evidence. The mirror receipt
(CC-004 §B.4 shape) is embedded under `mirror` in the conductor receipt.
**Crash safety:** a mirror failure leaves `errors[]` non-empty, the lease is
retained, and the update is retried idempotently — a dispatch retry can never
double-post a comment (CC-004 §B.2 separation). On a clean `done` update the
lease is **released** (`step: "released"`), freeing concurrency for the next
SELECT.

### Restart recovery (the superseded Non-Goal, now an obligation)

On start the daemon: (a) loads config + the `*.workflow.md` gate to fix `mode`;
(b) reads `conductor-leases.json`; (c) for each leased issue, reads the latest
`conductor-receipt-…-<runId>.json` `step` and **resumes from the next step**,
re-running the recorded step idempotently (its receipt makes the re-run a no-op
if it already completed). Expired leases (`now - leaseAcquiredAt > leaseTtlMs`)
are **released, not resumed** — a stranded lease never blocks an issue forever.
This is what makes "Restart recovery for scheduler state" (PLAN Non-Goal `:50`)
a satisfied property instead of a rejected one.

## §6 — Visible-lanes invariant and the write-gate (AC-3)

> AC-3: *No code path bypasses visible launcher lanes for implementation work.*

Two structural guarantees:

1. **The conductor has no agent-exec primitive.** Its only "start work" action is
   LAUNCH, whose only effect is invoking the Ghostty Launcher (visible
   terminal). There is no headless/background agent run, no direct `codex`/
   `claude` invocation, no `openclaw tasks register` written by the conductor.
   Implementation work is *always* a visible launcher lane. (The visibility
   SPEC already forbids CC from launching agents; this design keeps that for the
   extension and routes the daemon's one launch capability through the same
   visible launcher.)
2. **Dispatch and mirror are gated off by default.** `mode: "observe"` plus the
   CC-004 §B.3 `*.workflow.md` gate (`dispatchEnabled: false`,
   `trackerWritePolicy: none`, `linearMutationAllowed: false`) mean that out of
   the box the conductor *plans* but cannot launch or mirror. Flipping to
   `dispatch` requires an explicit, separately-approved edit to the workflow
   gate naming the same operation/scope/destination/receipt contract — never an
   implicit CC config side effect.

A would-be bypass (e.g. a future "fast path" that runs an agent inline to save a
terminal) is a contract violation by construction: it would have to add an
exec primitive the conductor is forbidden to own.

## §7 — Command Central projection artifacts that monitor the loop (AC-4)

> AC-4: *The design names the Command Central projection artifacts needed to
> monitor the loop.*

The conductor is *monitored*, not *driven*, by the VS Code extension. The
extension renders the loop using the **already-existing** Symphony projection
surface (`src/providers/agent-status-tree-provider.ts`,
`src/types/codex-run-types.ts`) — nothing new in the extension is required by
this design; the daemon's job is to emit records the existing surface already
knows how to read. Named artifacts:

| Loop concern | CC projection artifact (existing) | Where |
|--------------|-----------------------------------|-------|
| Each launched lane | **`CodexRunView`** (run attempt read model) | `src/types/codex-run-types.ts`; built by `CodexRunObserverService` (`src/services/codex-run-observer-service.ts`) |
| The conductor's own snapshot (active/retry/released counts) | **`SymphonyRuntimeSnapshotView`** + `SymphonyRuntimeSnapshotCounts` + `SymphonyCodexTotalsView` | `src/types/codex-run-types.ts:53-141` |
| Live lanes | **`SymphonyRunningEntryView`** under `SymphonyRunGroupNode` kind `"running"` | provider `:508-522` |
| Dispatch retries | **`SymphonyRetryEntryView`** under `SymphonyRunGroupNode` kind `"retryQueued"` | provider `:102` (type), `:508` (kind) |
| Released/done lanes | `SymphonyRunGroupNode` kind `"released"` | provider `:508` |
| The Symphony container itself | **`SymphonyRootNode` / `SymphonyDashboardNode`** ("Symphony Status Surface") | provider `:482-522, :7405` |
| Run attempts not in a workstream | **`Run Attempts`** container | provider `:6827, :9509` |
| Grouped run attempts | **`Workstreams`** (TaskFlow) container, from `TaskFlowService` | provider `:6834` |
| Completed-but-unreviewed lanes (review step backlog) | **Needs Review (limbo)** status group | provider `:999, :1013`; `AgentStatusGroup = "limbo"` (`:633`) |
| Action-required lanes (review_failed / contract_failure / blocked) | **Action Required** = `AgentStatusGroup "attention"` | provider `:633, :1013`; routed by `getNodeStatusGroup` (`:5321`) |
| Stale review projections (lane gone, receipt stale) | **`isStaleReviewProjection`** routing (PAR-226 prior art) | provider `:2331, :5402` — keeps the conductor's released lanes from re-counting as live |
| Conductor health (poll alive? gate state? mode?) | **OpenClaw infrastructure health status bar** (six-state contract) | `src/services/infrastructure-health-status-bar.ts` (CC-002 contract); add a conductor *dimension* (`mode`, last poll age) as a tooltip line, no new state |
| The durable loop state itself | **conductor receipts** (`research/conductor-receipt-*.json`) + **lease store** (`research/conductor-leases.json`) | §5; the extension can surface receipt freshness as an evidence row, read-only |

The extension reads these the same way it reads every other owner record:
read-only, provenance-preserved (`fieldSources`), never mutating. The conductor
writes receipts + invokes owners; CC renders. The status-bar conductor-health
*dimension* is the one small, optional extension follow-on (its own ticket) —
this design only *names* it; it does not require it for the daemon to function.

## Failure-mode separation (dispatch vs. mirror vs. lifecycle)

Carried from CC-004 §B.2, made concrete for the loop:

- **A mirror failure must not block dispatch.** UPDATE writing a comment that
  fails (`errors[]` non-empty) keeps the lane running and the lease held; the
  comment is retried idempotently. The agent never stops because Linear hiccupped.
- **A dispatch failure must not trigger a mirror write.** A `launch_failed` goes
  to RETRY (§5), not to a tracker comment, until the executor emits a real
  outcome event. A tracker hiccup can never double-launch (the lease guards it).
- **A review failure never auto-retries.** `review_failed` is surfaced as an
  Action Required attention state; the human/fixup decision is explicit.
- **A lease never strands an issue.** `leaseTtlMs` expiry releases it; restart
  recovery resumes or releases, never re-launches blindly.

## Acceptance criteria mapping

| CC-005 AC | Status | Where |
|-----------|--------|-------|
| Repo-owned config: tracker, eligible states, workspace root, concurrency, retry, hooks, prompt template | **Met (this doc)** | §4 — `WORKFLOW.md` Conductor section + `conductor.config.jsonc` schema with all seven keys, gated by the `*.workflow.md` write-gate |
| Loop specified as poll/select/launch/review/retry/update with crash-safe receipts | **Met (this doc)** | §5 — six-step state machine + lease store + per-step `cc_conductor_receipt_v1` receipts + restart recovery |
| No code path bypasses visible launcher lanes for implementation work | **Met (this doc)** | §6 — conductor owns no agent-exec primitive; LAUNCH's only effect is a visible Ghostty Launcher invocation; dispatch off by default |
| Design names the CC projection artifacts to monitor the loop | **Met (this doc)** | §7 — `CodexRunView`, `SymphonyRuntimeSnapshotView`, `SymphonyRunningEntryView`, `SymphonyRetryEntryView`, `SymphonyRunGroupNode`, Run Attempts / Workstreams containers, Needs Review (limbo) / Action Required groups, `isStaleReviewProjection`, health status bar, receipt/lease store |

## Honest scope / what is not produced here

- This is a **design/spec** deliverable. It writes no extension or daemon code,
  consistent with the edit scope (`research/` only) and the sibling CC-002/CC-004
  convention ("not produced here / needs live infra").
- **The conductor daemon process is not implemented.** CC-006 / PAR-158 (which
  this blocks) and any implementation lane build the daemon against this
  contract. The `conductor.config.jsonc`, `conductor/prompts/cc-lane.md`, the
  `WORKFLOW.md` Conductor section, and the daemon binary are deliverables of that
  lane, not this design.
- **The `*.workflow.md` write-gate flip is not performed here.** It lives in
  `~/projects/config/openclaw/conductor/workflows/*.workflow.md` (outside this
  repo's edit scope) and remains `dispatchEnabled: false` /
  `trackerWritePolicy: none` / `linearMutationAllowed: false` (CC-004 §B.3).
  Until an operator-approved gate flip, the conductor is observe-mode only. This
  design names the gate as the precondition; it does not change it.
- **No live tracker poll or live launch is exercised.** Doing so requires the
  gate flip, a live Linear read against the `Command Central` project, and a
  MacBook-node launcher run — all outside this design task's scope and not faked
  (same honest limit recorded for CC-001/CC-002/CC-004).
- **The optional status-bar conductor-health dimension** (§7) is named as a small
  extension follow-on with its own ticket; it is not required for the daemon and
  is not designed in detail here.

## References

- `research/PLAN-symphony-vscode-native-integration-2026-05-09.md` — the
  "CC is observability surface, NOT scheduler" boundary this design reconciles
  and partially supersedes (`:9, :19, :45-50`).
- `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md` — CC-003 read
  model (`CodexRunView`, projection rules, phase vocabulary) the loop renders
  against.
- `research/DESIGN-cc-004-linear-intake-mirror-contract-2026-06-23.md` — the
  mirror path the UPDATE step delegates to (§B.1 allowed writes, §B.2 separation,
  §B.3 write-gate, §B.4 receipt, §B.5 lifecycle); CC-005 is named there as the
  consumer that must flip the gate.
- `research/PLAN-symphony-preview-rc21-conductor-2026-05-09.md` — the raw pieces
  (TaskFlowService, CodexRunObserverService, launcher prompt/stream/handoff/
  pending-review artifacts) the loop and projection reuse.
- `research/SPEC-taskflow-tree-nodes-v2.md` — the Workstream grouping substrate
  (`openclaw tasks flow list --json`) the loop's run attempts attach under.
- `research/CC-OPENCLAW-NATIVE-LOOP-ARCHITECTURE-2026-04-20.md` — the
  launcher → OpenClaw ledger write path the LAUNCH step relies on (launcher
  spawns the ledger row; conductor never writes `runs.sqlite`/`tasks.json`).
- `research/CONTRACT-DECISION-openclaw-health-truth-2026-06-23.md` — CC-002
  six-state health contract; the conductor-health dimension (§7) extends its
  tooltip, not its state set; same doc shape and "needs live infra" convention.
- `src/providers/agent-status-tree-provider.ts`,
  `src/types/codex-run-types.ts`, `src/services/codex-run-observer-service.ts`,
  `src/services/infrastructure-health-status-bar.ts` — the existing projection
  surface (§7) the daemon emits into; **read for context only, not modified by
  this design.**
