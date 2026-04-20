# Command Central — Focus Action Truthful-Lane Fix (2026-04-20)

task_id: `cc-focus-truthful-lane-20260420-1521`
branch: `main`

## Symptom

Clicking the focus/launcher action on a **running tmux-backed launcher task**
was raising a garbled, stale "Command Central visible terminal" surface in
Ghostty — a sibling task's window, an orphaned pane, or an empty bundle tab
from a fresh `open -a` — instead of the truthful live lane.

The preceding truth-model patches (`2164443`, `37e0417`, `cf6dbef`) fixed
**attribution** (the right tree row gets the right status) but left the
**focus/open action** routing through bundle-focused strategies without
verifying the live lane was actually there.

## Root cause

`focusAgentTerminal` ran a four-strategy cascade
(`src/extension.ts:1290..1488`):

| Strategy | Action | Liveness check? |
| --- | --- | --- |
| 0 — session-store cache | `focusGhosttyBundleAndTmuxWindow` | none |
| 1 — launcher bundle | `focusGhosttyBundleAndTmuxWindow` | none |
| 2 — direct bundle path | `focusGhosttyWindow` | none |
| 3 — tmux attach | `openGhosttyTmuxAttach` | `isTaskTmuxSessionAlive` ✅ |

For a **running** tmux-backed task, the only source of truth for the live
lane is the tmux session itself; the launcher's visible Ghostty window is
just one possible client onto it. `focusGhosttyBundleAndTmuxWindow` does
`open -a <bundle>` (always "succeeds" — relaunching the app if needed) then
`tmux select-window` (failures swallowed). So when the tmux session had
died out from under us, Strategies 0/1/2 still returned a "success" and
showed a dead or wrong surface.

Strategy 3 already had the right invariant. The gap was that Strategies
0/1/2 were allowed to run ahead of it for the one case where the surface
couldn't be trusted.

## Fix

Introduced a single launcher-truth gate (`src/extension.ts`):

```ts
export function shouldTrustBundleSurface(
  task: AgentTask,
  tmuxSessionAlive: boolean | null,
): boolean {
  if (task.status !== "running") return true;   // no live lane to protect
  if (task.terminal_backend !== "tmux") return true;
  if (!task.session_id || !isValidSessionId(task.session_id)) return true;
  if (tmuxSessionAlive === null) return true;   // no evidence → don't block
  return tmuxSessionAlive;
}
```

At the top of `focusAgentTerminal`, we probe `isTaskTmuxSessionAlive` once
for running tmux-backed tasks (non-running tasks skip the probe — no live
lane to protect) and gate Strategies 0, 1, and 2 on
`bundleSurfaceTrusted`. Strategy 3 reuses the probed answer via
`probedTmuxSessionAlive ?? await isTaskTmuxSessionAlive(task)` so we don't
double up on `tmux has-session` shells.

When `bundleSurfaceTrusted === false`, all three bundle-focused strategies
are skipped and execution falls through to the pre-existing **dead-session
quickpick** that offers:

- Resume in Interactive Mode (if applicable)
- **View Session Transcript** — the JSONL stream file (safer "agent output" fallback)
- Open Project Launcher
- View Diff

This matches the task's stated preference order — truthful live lane
(Strategy 3) first, then safer fallbacks (transcript / diff), never the
stale visible bundle tab.

### Files

- `src/extension.ts` — added `shouldTrustBundleSurface`, probed liveness
  up front, gated Strategies 0/1/2 behind `bundleSurfaceTrusted`,
  reused the probe in Strategy 3.
- `test/commands/extension-commands.test.ts` — 13 new tests covering
  `shouldTrustBundleSurface` (8) and the gate's effect on each strategy (5).

## Behavior matrix

| Task state | tmux session | Before fix | After fix |
| --- | --- | --- | --- |
| running, tmux-backed, launcher bundle | alive | Bundle focused ✅ | Bundle focused ✅ (unchanged) |
| running, tmux-backed, launcher bundle | **dead** | **Stale bundle raised** ❌ | Dead-session quickpick ✅ |
| running, tmux-mode (no bundle) | alive | Strategy 3 fresh attach | Strategy 3 fresh attach (unchanged) |
| running, tmux-mode (no bundle) | dead | Dead-session quickpick | Dead-session quickpick (unchanged) |
| completed/failed/stopped | either | Bundle focused | Bundle focused (unchanged — no live lane to protect) |
| discovered agent (no task record) | n/a | Strategy 0 bundle focus | Strategy 0 bundle focus (unchanged — `task === undefined` trusts the surface) |

## What CC can safely fix vs. ghostty-launcher surface hygiene

**Command Central can safely fix (covered by this patch):**

- Refuse to route a running focus click into a bundle surface when the
  tmux session is already dead. This is the dominant failure mode and
  it's purely Command Central's routing decision.
- Cache the liveness probe so Strategy 3 doesn't repeat the shell.

**Command Central could still improve on its side (deferred):**

- Detect when the **launcher bundle's Ghostty process isn't running** at
  all (not just tmux liveness) — `open -a` will relaunch a fresh empty
  instance which is mildly misleading, though not as bad as a stale
  surface. Could gate Strategy 1 on a `pgrep -x <bundle>` check.
- When Strategy 1 does fire but `tmux select-window` fails (the bundle
  has no tmux client attached, or the client's at the wrong window),
  we currently still return success. A future patch could probe
  `tmux list-clients -t <window>` and fall back to Strategy 3 on
  mismatch.
- Surface a concrete "Fresh tmux attach" item in the dead-session
  quickpick when the tmux session happens to be alive but the bundle
  surface is otherwise untrusted (e.g. a future `focus.preferFreshAttach`
  policy). Not needed for the current bug.

**Remains a ghostty-launcher surface-hygiene problem (out of scope here):**

- **Garbled visual state inside the bundle window itself** (terminal
  screen redraw artifacts, wrong tmux client attached, stale pane
  contents). Command Central can only decide *whether* to raise the
  bundle — once it's raised, the fidelity of what the user sees is
  ghostty-launcher's responsibility. In particular, if the launcher's
  oste-focus.applescript or its tmux client lifecycle leaves the
  visible window pointing at a defunct session, Command Central has no
  way to detect or repair that from the VS Code side.
- **Bundle process lifecycle** (when a launcher bundle stays running
  after its last tmux session ends, vs. quits, vs. relaunches empty).
  That's governed by ghostty-launcher's spawn/cleanup logic, not CC.
- **Multi-task bundles** where several concurrent tasks share one
  bundle: the "right" window to land on is fundamentally a
  ghostty-launcher concern (tmux window naming, client attachment).
  Command Central's `tmux select-window -t <windowId>` is a best-effort
  hint — if the launcher has no client attached, the hint goes nowhere.

## Tests

- `bun test test/commands/extension-commands.test.ts` — 68 tests pass
  (13 new).
- `just test` — full suite: 1404 pass / 0 fail.
- `just check` — biome ci + tsc + knip: clean.

## Related research

- `research/COMMAND-CENTRAL-LAUNCHER-TRUTH-HIERARCHY-2026-04-20.md`
  (established the truth hierarchy the focus action now honors).
