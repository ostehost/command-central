# Handoff: Command Central Symphony Dogfood — Workstreams Implementation Lane

Date: 2026-05-10
Owner: Implementation worker (`cc-symphony-dogfood-workstreams-impl-20260510-0955`)
Repo: `/Users/ostehost/projects/command-central`
Branch: `dogfood-symphony-20260510`
Base commit: `ec389d2` (`docs(research): add symphony dogfood delegation handoff`)
Status: implementation slice committed; ready for proof/review lane

## Scope (narrowed)

Per the lead agent's mid-flight correction, the implementation slice was reduced
to the smallest acceptable change. Two items only:

1. Operations Dashboard details now use Symphony spec runtime-snapshot vocabulary.
2. One focused test proves Symphony Workstream child grouping uses explicit
   identity (taskId / runId / session id / childSessionKey / workflow run id) —
   never broad-match by workstream or task title text.

Out of scope this lane (deferred to proof/review or later rounds):

- Codex Run Attempt detail rewording — already source-owned and didn't need a
  vocabulary tighten in this slice.
- Surfacing CodexRunView rows directly under TaskFlow groups (current rendering
  already resolves each `flow.tasks[i]` to launcher / discovered / openclaw /
  placeholder by explicit identity).
- Adding workflowRunId / flowId join hops on top of the existing taskId / runId /
  session match in `findLauncherTaskForFlowTask`. Existing matches already pass
  the explicit-identity guarantee for the dogfood case; widening this is a
  bigger surface and wasn't required.

## Files Changed

- `src/providers/agent-status-tree-provider.ts`
  - `getSymphonyDashboardDetailChildren` rewritten to emit Symphony spec
    snake_case runtime-snapshot fields:
    - `Boundary` (kept — descriptive, not a snapshot field)
    - `Orchestrator Runtime State` → `"Not provided by lifecycle owner"` (we
      never receive a real orchestrator snapshot today; honest, not synthesised)
    - `Run Attempts` (count of projected rows)
    - `Workstreams` (count of TaskFlow rows)
    - `running` (count of running sessions)
    - `retrying` (count of rows with `retryAttempt`/`retryDueAt`)
    - `codex_totals.input_tokens`
    - `codex_totals.output_tokens`
    - `codex_totals.total_tokens`
    - `codex_totals.seconds_running`
    - `rate_limits` (distinct `rateLimitSummary` joined by ` · `)
    - `Released` (kept conditional, only shown when count > 0)
  - When **no** source row contributes a value for a `codex_totals.*` or
    `rate_limits` field, the value is the literal `Not provided by lifecycle
    owner` rather than a synthesised `0` / empty string. This preserves the
    Status-Surface boundary: Command Central does not invent lifecycle truth.
  - Removed the synthetic `Turns` / `Tokens` / `Runtime` / `Rate-limit
    snapshots` aggregations that were not part of the spec snapshot vocabulary.

- `test/tree-view/openclaw-task-nodes.test.ts`
  - Existing test `Symphony root exposes Operations Dashboard and read-only
    kanban groups` now asserts the new spec vocabulary keys and the
    `Not provided by lifecycle owner` honest-default behaviour for unprovided
    `codex_totals.*` fields and the orchestrator snapshot.
  - **New focused test**: `Symphony Workstreams group children by explicit
    identity, not workstream/task title text` — sets up two TaskFlow children
    that share the workstream's title verbatim, with one explicit `taskId`
    launcher match and one launcher whose only commonality with the unmatched
    flow task is its `prompt_summary`/title text. Asserts the explicit-id
    launcher row is reused, the title-only launcher is **not**, and the
    unmatched flow task remains a `taskFlowChild` placeholder so the operator
    can see the missing identity.

## Tests Run

| Command | Result |
| --- | --- |
| `bun test test/tree-view/openclaw-task-nodes.test.ts` | **32 pass / 0 fail / 140 expect() calls** |
| `bunx tsc --noEmit --pretty false` | clean (no output) |
| `git diff --check` | clean (no whitespace errors) |
| `just check` (biome ci + tsc + knip) | passes |

`just ci` was not run because the slice does not modify shared Agent Status
behaviour beyond the Symphony root details and adds one focused test (no
warnings vs errors gate).

## Boundary Check

- ✅ Command Central remains a read-only Status Surface. No new commands, no
  retry/cancel buttons, no scheduler state, no tracker writes, no workspace
  hooks, no Linear polling, no drag/drop, no custom dashboard.
- ✅ Symphony stays inside Agent Status as a top-level root; no Activity Bar
  container or sibling view added.
- ✅ Operations Dashboard reports the missing orchestrator snapshot honestly
  (`Not provided by lifecycle owner`), never synthesising a `fresh` /
  `timeout` / `unavailable` value. When a real snapshot source is wired in,
  the value flips automatically without a UI change.
- ✅ `codex_totals.*` and `rate_limits` are honest-defaulted: they sum across
  source rows that actually provide the value and degrade to
  `Not provided by lifecycle owner` when no row provides one. They are never
  synthesised to `0`.
- ✅ Workstream child grouping continues to use explicit identities only
  (`taskId` / `runId` / normalised `session_id` / `childSessionKey`). The new
  test pins this against title-text broad-matching.
- ✅ Kanban groups (Running Sessions, Retry Queue, Released, Workstreams,
  Run Attempts) and their source-owned-evidence semantics are preserved.

## Remaining Owner-Layer Gaps

These belong to OpenClaw / TaskFlow / Launcher / Symphony proper and are
intentionally **not** filled by Command Central:

1. **Real Orchestrator Runtime State snapshot.** No source today publishes
   the spec-shaped `{status, ts, codex_totals, running, retrying, rate_limits,
   ...}` envelope into a path Command Central can read. Until that exists,
   the dashboard will keep reporting `Not provided by lifecycle owner` for
   the snapshot status. Owner-layer work: define the snapshot file path /
   IPC channel, version it, and have the orchestrator publish it.
2. **Released evidence.** `Released` is only shown when a source explicitly
   reports the status. Today only launcher rows can claim it via
   `source_authority`. If TaskFlow / OpenClaw want to release a workstream,
   they need a source-owned `released` status with evidence.
3. **Per-row `codex_totals.input_tokens` / `output_tokens` provenance.** Most
   launcher rows in the live registry only fill `codex_total_tokens`, leaving
   input/output split undefined. The new Operations Dashboard now exposes
   that gap honestly. Owner-layer work: have the agent runtime emit input/
   output split into the launcher row.
4. **Workstream membership beyond `flow.tasks`.** A delegated launcher run
   that knows its `flow_id` but is not yet listed in the TaskFlow's
   `tasks[]` will not appear under the Workstream group. Owner-layer work:
   either keep TaskFlow.tasks authoritative (preferred) or define a
   secondary explicit-identity hop (`launcherTask.flow_id ===
   flow.flowId`) and a corresponding source-owned ordering rule.
5. **`fresh` vs `timeout` distinction.** Once a snapshot source exists, the
   timeout vs fresh distinction needs a clock owner — Command Central must
   not own that clock. Owner-layer work: define the staleness threshold in
   the orchestrator and emit the resolved status, not a raw timestamp.

## Recommended Next Step For Proof/Review Lane

Run a real visible launcher delegation (Ghostty lane) that:

1. Creates a TaskFlow workstream with at least two `flow.tasks` having
   explicit `taskId`s.
2. Launches a launcher task whose `id` equals one of those `taskId`s.
3. Confirms the running VS Code Agent Status tree shows:
   - The `Symphony` root with the new `Operations Dashboard` vocabulary.
   - The workstream under `Workstreams` with the matched launcher row reused
     (not duplicated, not synthesised) and any unmatched task rendered as a
     placeholder.
   - `Orchestrator Runtime State: Not provided by lifecycle owner` (until
     the owner-layer snapshot lands).
4. Records evidence file paths (handoff, stream, prompt) and verifies they
   are surfaced under the matched `Run Attempt` detail rows.

The proof/review lane should not edit any of the files this lane owns.
