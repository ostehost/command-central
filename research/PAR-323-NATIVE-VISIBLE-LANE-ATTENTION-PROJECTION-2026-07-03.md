# PAR-323 — Native visible-lane attention projection (Command Central side)

Date: 2026-07-03
Node: Mike MacBook Pro (developer lane, task `native-receipt-projection-20260703-1820`)
Depends on / follows: PAR-322 (`5b16b047` — visible Claude permission/input-wait
detection), PAR-297 visible-lane launch/attach receipt line.

## Goal

Command Central should **project** OpenClaw/Symphony-native visible-lane
attention receipts when available, and must **not** be the source of truth for
lane lifecycle state. Two verdicts, deliberately distinct surfaces:

- explicit permission/input wait → renders **awaiting input**, when backed by
  native status/receipt data (no local pane read required).
- degraded visibility / stale AX / stale tmux stream → renders **visibility
  degraded / needs attention**, never *awaiting input* by itself.

## What existed before this slice

- The **only** path to an "(awaiting input)" badge was the local PAR-322 pane
  heuristic (`getTerminalTaskPaneAttention` → `classifyPaneAttention`), gated on
  `interactiveAwaiting` (stuck + positive liveness). There was no way to project
  a daemon-confirmed wait.
- Degraded visibility was already projected: `launcher_visibility_degraded ===
  true` → `isLivenessUnobservableRunningLane` → "(detached)" +
  `debug-disconnect` icon. That path never rendered as an input wait, so
  requirement 2 was already partly satisfied for the launcher-`visibility`
  field — but there was no native `visible_lane.attention` projection distinct
  from it.
- **The snake_case tokens `visible_lane_attention` / `awaiting_input` did not
  appear anywhere in `src` or `test`.** CC had no seam to consume them.

## Upstream gap (important)

As of this commit, the exact receipt strings **`visible_lane.awaiting_input`**
and **`visible_lane.attention`** do **not** exist anywhere in the symphony-daemon
repos checked out on this node:

```
rg -rln 'visible_lane.awaiting_input|visible_lane.attention|awaiting_input' \
  ~/projects/symphony-daemon* ~/projects/openclaw*   # → no matches
```

symphony-daemon currently emits the `visible_lane.launched` / `.attached`
receipt family (`src/v2/visibleLaneRegistry.ts`), not the attention vocabulary.
So this slice adds the **consumer** seam; it needs matching **producer** data
(the daemon must stamp `visible_lane_attention` onto the lane row / projection
envelope) before it lights up in the live tree. The projection is inert and
harmless until then (fail-closed to `null`).

## The projection seam CC now exposes (the contract for the daemon side)

CC reads a native attention verdict off the lane record, via one new
projected field pair on `AgentTask`:

```ts
// src/types/agent-task.ts
export type VisibleLaneAttention = "awaiting_input" | "attention";
visible_lane_attention?: VisibleLaneAttention | null;
visible_lane_attention_reason?: string | null;   // verbatim, audit + tooltip
```

Populated by the ingest normalizers (`src/providers/agent-task-normalize.ts`),
fail-closed to `null` on any unrecognized token, across **both** registry shapes:

1. **Launcher `{version, tasks}` row** — flat keys `visible_lane_attention`
   (string enum) + `visible_lane_attention_reason` (string).
2. **`work-system-lanes-projection` envelope** (`laneRefUpdateToTaskRecord`) —
   tolerates either a structured `visible_lane_attention: { kind, reason }`
   object **or** the flat `visible_lane_attention` + `visible_lane_attention_reason`
   pair on the envelope.

CC never writes these — projection only. A primary registry record with the same
task id still wins the merge over a projection row (unchanged).

## Rendering (src/providers/agent-status-tree-provider.ts `createTaskItem`)

`classifyVisibleLaneAttention(task)` (pure, in
`src/providers/agent-task-classification.ts`) maps the field to the two surfaces:

- `awaiting_input`:
  - `awaitingUserInput = nativeAwaitingInput || (<PAR-322 pane expr, byte-identical>)`.
    The native operand is authoritative and short-circuits the pane capture.
  - description → **"(awaiting input)"**, **hoisted above** "(detached)" so a
    native wait is not muted by degraded local visibility ("not *by itself*"
    means degraded visibility alone stays needs-attention, but a native
    `awaiting_input` receipt overrides it).
  - icon → orange `comment-discussion`; tooltip attributes to "OpenClaw/Symphony"
    and carries the verbatim reason. (Pane-heuristic path keeps its exact PAR-322
    "Claude is paused…" copy — both contain "Awaiting input".)
- `attention`:
  - description → **"(needs attention)"**; icon → orange `eye-closed`; tooltip
    "Needs attention: …on-screen visibility…degraded…(not a confirmed input
    wait)". **Never** feeds `awaitingUserInput`. Suppressed when a louder
    pane-confirmed wait is already shown.

Lifecycle state is untouched: the row keeps its `status` and its status-group
bucket (a `running` lane stays in Live — this is a badge, exactly like PAR-322,
not a group promotion).

## Files inspected / changed

Changed:
- `src/types/agent-task.ts` — `VisibleLaneAttention` type + two projected fields.
- `src/providers/agent-task-classification.ts` — pure `classifyVisibleLaneAttention`.
- `src/providers/agent-task-normalize.ts` — ingest both registry shapes, fail-closed.
- `src/providers/agent-status-tree-provider.ts` — `createTaskItem` description /
  tooltip / icon precedence (hoist awaiting-input, add needs-attention surface).

Inspected (unchanged, load-bearing):
- `src/utils/agent-status-sections.ts` — pure `classifyPaneAttention` /
  `PaneAttentionState` (PAR-322 taxonomy, preserved).
- `src/providers/agent-status-tree-provider.ts:isLivenessUnobservableRunningLane`,
  `isAgentStuck`, `hasPositiveLivenessEvidence`, `getTerminalTaskPaneAttention`.
- symphony-daemon: `src/v2/visibleLaneRegistry.ts`,
  `src/daemon/visibleClaudeLauncher.ts` (existing `visible_lane.launched/attached`
  vocabulary; no attention vocabulary yet).

## Tests

- `test/providers/agent-task-visible-lane-attention.test.ts` — pure projector +
  ingest round-trip (both registry shapes, fail-closed on bad token).
- `test/tree-view/agent-status-native-lane-attention.test.ts` — provider render
  semantics: native `awaiting_input` renders "(awaiting input)" from the receipt
  alone (no pane read, not stuck); native `attention` → "(needs attention)", not
  an input wait; degraded visibility alone stays "(detached)"; native
  `awaiting_input` outranks degraded visibility.
- `test/tree-view/agent-status-awaiting-input-wake.test.ts` (PAR-322) — unchanged,
  still green (regression guard).

Gates: `just check` clean (biome CI + tsc + knip); `just test` → 2649 pass,
1 skip, 0 fail.

## Next steps (upstream)

symphony-daemon should stamp `visible_lane_attention` (`awaiting_input` |
`attention`) + `visible_lane_attention_reason` onto the lane row / projection
envelope from its durable visible-lane attention receipts, matching the field
names / shapes above. Until then this projection is a no-op (fail-closed null)
and the PAR-322 local pane heuristic remains the only live awaiting-input signal.
