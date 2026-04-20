# Command Central — Truthful Surface Open/Focus Contract (2026-04-20)

task_id: `cc-truthful-surface-open-contract-20260420-1722`
branch: `main`

## Goal

Make tree-item open/focus behavior for launched terminals truthful: when the
user clicks a launcher-managed task, Command Central must prefer the exact
known surface recorded by the launcher (not a generic Ghostty fallback) — and
when it cannot land on an authoritative surface, it must say so rather than
silently conjuring a new window.

## Root cause / remaining gap

Prior work on the focus cascade already:

- Gated Strategies 0/1/2 on a `shouldTrustBundleSurface` liveness probe
  (`src/extension.ts:143-152`, commit `1a52857`) so dead tmux sessions no
  longer raise stale Ghostty surfaces.
- Guarded the session-store cached mapping with `taskMatchesSessionStoreBundle`
  (`src/extension.ts:119-126`) so a tmux-mode task can't collapse onto a
  sibling's bundle.
- Enforced the launcher-truth hierarchy for discovered-agent attribution
  (commit `cf6dbef`).

The remaining "untruth" lived in **Strategy 3** (`src/extension.ts:1435-1449`
before this change): when a tmux-backed task had no authoritative bundle
metadata (or Strategies 1/2 had failed), the handler ran

```ts
open -a Ghostty --args -e tmux attach -t <session>
```

…and returned as if it had *focused* the task's visible surface. In truth,
that invocation spawns a **fresh client** onto the authoritative tmux session
using the stock `com.mitchellh.ghostty` app — never a focus of the launcher's
project-specific bundle. The click was silently creating a new Ghostty window
and leaving the user to guess whether CC had hit the right lane or any lane
at all.

## Contract implemented

`commandCentral.focusAgentTerminal` now routes by backend as follows:

| Preconditions | Action | Truthfulness |
| --- | --- | --- |
| Session-store mapping matches `task.ghostty_bundle_id` + bundle trusted | Strategy 0 — `focusGhosttyBundleAndTmuxWindow` on cached bundle, then `tmux select-window` | Exact known surface |
| `terminal_backend === "tmux"` + `ghostty_bundle_id` + bundle trusted | Strategy 1 — same, keyed on task's own bundle id | Exact known surface |
| `bundle_path` set, real, not `(test-mode)`/`(tmux-mode)`, bundle trusted | Strategy 2 — `focusGhosttyWindow` then `selectTaskTmuxWindow` | Exact known surface |
| tmux-backed, valid session id, tmux alive, no authoritative bundle focus | Strategy 3 — `open -a Ghostty --args -e tmux attach …` **+ info message** | Truthful: fresh client, not a focus |
| tmux-backed, tmux dead | Dead-session QuickPick (Resume / Transcript / Launcher / Diff) | Truthful: no live lane |
| Discovered agent, no bundle mapping | "No Ghostty bundle found for this discovered agent." | Truthful: unknown |
| Nothing matches | "No terminal available for this agent." | Truthful: unknown |

### The Strategy 3 change (this patch)

In `src/extension.ts`, after `openGhosttyTmuxAttach` returns true we now
notify the user that a **new** Ghostty window was spawned rather than an
existing lane focused:

```ts
vscode.window.showInformationMessage(
  `Opened a fresh Ghostty window attached to tmux session "${task.session_id}" — no launcher surface known for this task.`,
);
```

The inline comment documents the semantic explicitly: Strategy 3 is NOT a
focus of the launcher's visible bundle surface; it creates a new tmux client
onto the authoritative session.

### What makes this "authoritative metadata only"

- Strategies 0/1/2 fire on recorded task fields (`ghostty_bundle_id`,
  `bundle_path`) validated by the launcher-truth gate.
- Strategy 3 fires on `terminal_backend === "tmux"` + `session_id` (a
  launcher-recorded, `isValidSessionId`-checked value) with verified
  `tmux has-session` liveness.
- No fake bundle paths (`(test-mode)` / `(tmux-mode)`) ever reach a bundle
  strategy — they're filtered out.
- The session-store convention fallback
  (`src/services/session-store.ts:53-73`) is only reachable for launcher
  tasks via `taskMatchesSessionStoreBundle`, which requires the task's own
  `ghostty_bundle_id` to match the mapping — so the "heuristic" only applies
  when it agrees with the launcher-recorded id.

## Files changed

- `src/extension.ts` — Strategy 3 now emits a truthful info message and the
  inline comment documents the fresh-client semantic.
- `test/commands/extension-commands.test.ts` — 3 new tests covering
  message emission, invalid-session-id short-circuit, and dead-session
  suppression.

## Tests run

- `bun test test/commands/extension-commands.test.ts` — 71 pass (3 new).
- `just test` — 1407 pass / 0 fail across 107 files.
- `just check` — biome ci + tsc + knip clean.

## Current limitations (deferred)

- **Bundle process liveness vs. tmux liveness.** The launcher-truth gate
  only probes tmux session liveness. If the tmux session is alive but the
  bundle's own Ghostty process isn't running, Strategy 1 still fires and
  `open -a` will relaunch a fresh empty bundle instance. Detecting this
  would need a `pgrep`/`lsappinfo`/bundle-id probe before Strategy 1.
  Listed as deferred in `research/COMMAND-CENTRAL-FOCUS-TRUTHFUL-LANE-2026-04-20.md`.
- **Attached-client awareness.** Strategy 3 does not consult
  `tmux list-clients -t <session>`. If the launcher bundle is already
  displaying this session somewhere, Strategy 3 creates a duplicate client
  rather than raising the existing window. Detecting "attached elsewhere"
  would let us downgrade Strategy 3 into a QuickPick ("Open fresh attach" /
  "View transcript" / "Cancel") — deferred because it adds a shell hop on
  the hot path.
- **Discovered-agent convention heuristic.** `SessionStore.lookup` still
  derives `dev.partnerai.ghostty.<basename>` from a `/Applications/Projects/<basename>.app`
  existence check (`src/services/session-store.ts:61-70`). For launcher
  tasks this is guarded by `taskMatchesSessionStoreBundle`; for discovered
  agents (no task record) it remains a heuristic. Removing it would make
  discovered-agent focus unusable for users without a persisted mapping,
  so the heuristic stays but is scoped to the ghostty-launcher naming
  convention.
- **In-bundle visual fidelity.** Once CC opens a bundle, the fidelity of
  the visible tmux contents (client attachment state, pane redraw, window
  selection) is ghostty-launcher's responsibility. CC does `tmux
  select-window` as a best-effort hint only.

## Recommended demo posture

1. **Launch a tmux-backed task with a known bundle** — clicking its tree
   item focuses the exact launcher bundle and lands on the correct tmux
   window. No modal, no info message. *This is the "exact known surface
   by backend" happy path.*
2. **Launch a tmux-mode task with `--tmux` (no bundle)** — clicking its
   tree item spawns a fresh generic Ghostty window and tmux-attaches into
   the authoritative session. The info message explicitly says
   `Opened a fresh Ghostty window attached to tmux session "…" — no
   launcher surface known for this task.` *This is the "truthful
   task-specific fallback" — the action completes but the user is told
   it was a fresh attach, not a focus.*
3. **Kill the tmux session on a running tmux-backed task, then click
   focus** — the dead-session QuickPick (Resume / Transcript / Launcher /
   Diff) appears. No stale bundle surface is raised. *This is the "no
   live lane" truthful-fallback path introduced by `1a52857`.*
4. **Click focus on a discovered agent with no session-store mapping and
   no convention-named `/Applications/Projects/<name>.app`** — the
   "No Ghostty bundle found for this discovered agent." message fires.
   *This is the explicit "unknown surface" truthful-fallback path.*

Demo script: `just dev`, open the Command Central view, and walk through
the four states above. Do **not** demo via
`code --install-extension releases/…vsix` into a user profile — always
launch the dev host with `--extensionDevelopmentPath` so the Five
Commandments hold.

## Related research

- `research/COMMAND-CENTRAL-FOCUS-TRUTHFUL-LANE-2026-04-20.md` — the
  earlier launcher-truth gate (`shouldTrustBundleSurface`).
- `research/COMMAND-CENTRAL-LAUNCHER-TRUTH-HIERARCHY-2026-04-20.md` —
  the broader attribution/status truth hierarchy.
- `research/COMMAND-CENTRAL-MANUAL-TERMINAL-PICKUP-2026-04-20.md` —
  proposed adoption sidecar for manual terminals (orthogonal to the
  focus path but relevant to the "authoritative metadata" principle).
