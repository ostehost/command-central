# Command Central — Surface Clarity Labels (Agent Status tree)

**Date:** 2026-04-20
**Task:** `cc-surface-clarity-labels-20260420-1730`
**Scope:** Make launched terminal surfaces explicit in the Agent Status tree — before the user clicks focus, they can tell whether a task is backed by a visible Ghostty launcher bundle, a tmux-only lane (fresh attach on click), a headless persist backend, an applescript-only surface, or has no authoritative surface recorded.

Complementary to the 98caa1e + 1a52857 focus-truth work, which was reactive (tell the user *after* Strategy 3 fires). This change is proactive — the same truth now shows up in the tree item before the click.

---

## UX Contract

### Static classifier (pure, metadata-only)

`classifyTaskSurface(task: AgentTask): { kind, tooltipLine, shortTag }` lives next to the other status helpers in `src/providers/agent-status-tree-provider.ts`. It derives surface kind from `terminal_backend`, `ghostty_bundle_id`, and `bundle_path` — never probes tmux liveness (that's the click-time gate's job).

| `kind`              | Condition                                                                                    | `tooltipLine`                                                                                     | `shortTag`             |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| `launcher-bundle`   | `terminal_backend === "tmux"` AND (ghostty_bundle_id set OR bundle_path is a real path)      | "Surface: launcher Ghostty bundle · tmux session (focus raises the bundle window)"                | `null` (happy path)    |
| `tmux-fresh-attach` | `terminal_backend === "tmux"` AND no bundle metadata (bundle_path in `(tmux-mode)`/`(test-mode)` and no ghostty_bundle_id) | "Surface: tmux session only — no launcher bundle; focus spawns a fresh Ghostty attach"            | `"tmux · fresh attach"`|
| `persist`           | `terminal_backend === "persist"`                                                             | "Surface: persist backend — no visible Ghostty window (headless socket lane)"                     | `"persist"`            |
| `applescript`       | `terminal_backend === "applescript"`                                                         | "Surface: AppleScript Ghostty (no launcher bundle)"                                               | `"applescript"`        |
| `launcher-bundle` (fallback) | No `terminal_backend` but bundle metadata exists                                    | "Surface: launcher Ghostty bundle"                                                                | `null`                 |
| `unknown`           | Nothing else matches                                                                         | "Surface: no authoritative terminal surface recorded"                                             | `"surface?"`           |

### Wiring into `createTaskItem()`

1. **Tooltip** (always): `tooltipLine` is spliced between the Transcript line and the Dir line. Users who hover get a definite answer for every task, regardless of status.
2. **Description** (conditional): `shortTag` is appended to `descriptionParts` only when `task.status === "running"` AND the tag is non-null. Rationale:
   - Done tasks route to a QuickPick, not a focus — surface kind isn't the actionable fact for them, so the tag would be noise.
   - Launcher-bundle running tasks are the common case; a null tag keeps them visually clean.
   - The tag rides the existing 80-char truncation and the existing `·` separator, so it integrates naturally with the `model · activity · (possibly stuck)` line.
3. **contextValue unchanged.** `package.json` menu `when` clauses use `==` (exact match) against `viewItem`, so appending any suffix to `agentTask.${status}` would break `focusAgentTerminal` and related menu bindings. Kept out of scope to preserve menu contracts.
4. **Icon unchanged.** Icons remain status-driven (sync~spin for running, check for completed, etc.). Overloading icons with surface kind would fight the status signal; description tags are the right channel for a secondary fact.

### Why not probe liveness

The tree renders on every registry change and every expand. A liveness probe is one `tmux has-session` shell per task — O(N) with the task list. That would regress tree perf and double up on the existing click-time probe. Static metadata is sufficient for the "what surface do I own?" question; the click-time `shouldTrustBundleSurface` gate keeps owning the "is that surface alive right now?" question.

---

## Tests

Added `describe("surface clarity (backend-truthful labels)")` block to `test/tree-view/agent-status-tree-provider-rendering.test.ts` with 5 cases:

- `launcher-bundle` running tmux task: tooltip mentions "launcher Ghostty bundle"; description carries no fresh-attach / surface? noise.
- `tmux-fresh-attach` running task: description contains `tmux · fresh attach`; tooltip explains "no launcher bundle; focus spawns a fresh Ghostty attach".
- `persist` running task: description `persist`; tooltip names "persist backend" + "no visible Ghostty window".
- `unknown` running task: description `surface?`; tooltip says "no authoritative terminal surface recorded".
- Completed tmux-only task: description omits the tag (QuickPick, not focus); tooltip still exposes the surface kind.

**Test run results**

- `bun test test/tree-view/agent-status-tree-provider-rendering.test.ts` — 35 pass, 0 fail.
- `just test` — 1412 pass, 0 fail across 107 files.
- `just check` — biome ci + tsc + knip clean.

---

## Files Changed

- `src/providers/agent-status-tree-provider.ts` — added `TaskSurfaceKind`, `TaskSurfaceSummary`, `classifyTaskSurface()` exports; wired surface tag into `descriptionParts` and surface line into tooltip.
- `test/tree-view/agent-status-tree-provider-rendering.test.ts` — added 5-case describe block for surface clarity.

---

## Known Limitations / Non-Goals

1. **No live-state overlay.** The tree says "launcher bundle" even when the tmux session is dead; the reality of "bundle is stale, click will fall through to QuickPick" surfaces only at click time via the existing dead-session QuickPick. Probing liveness on render was ruled out on perf grounds (see above).
2. **No contextValue discrimination.** Menu bindings in `package.json` use exact `==` matches; surfacing kind into contextValue would need a coordinated menu-clause migration (switch to `=~`). Deferred.
3. **No icon overlay.** A discriminating icon (e.g., a different glyph for tmux-fresh-attach) was considered and rejected: the status-channel icon is already load-bearing (running/stale/stuck/reviewed) and a second dimension would muddy both.
4. **Discovered-agent nodes unchanged.** These don't go through `createTaskItem`; they render in `createDiscoveredItem` with their own tooltip. Out of scope for this pass — the task was specifically about launcher-managed tasks in the Agent Status tree.
5. **Heuristics explicitly avoided.** The classifier only reads launcher-recorded metadata. No PID probes, no process-scan correlation, no Ghostty-window enumeration.

---

## Demo Narration

One-paragraph script for the dogfood demo:

> Before this change, an Agent Status tree item said nothing about *where* the task actually lived — you had to click and hope the right window came up. Now, every task item shows its terminal surface explicitly. A healthy launcher-managed task is visually unchanged (we don't add noise to the happy path), but its tooltip names the launcher Ghostty bundle so you can confirm before clicking. A tmux-only lane — one with no launcher bundle recorded — now carries a `tmux · fresh attach` tag in the description, telling you up front that a click will spawn a fresh Ghostty window instead of raising an existing one. Persist-backed headless tasks are tagged `persist`. Tasks with no authoritative surface get a `surface?` tag so ambiguity is visible, not hidden. The tooltip always spells out the full sentence, so hovers are self-documenting. This is the proactive half of the truthful-open contract: the static tree now agrees with the runtime click behavior.

---

## Follow-ups (recommendation, not in scope)

- If we want live-state surfaces in the tree, reuse the tmux liveness cache (TmuxHealthCache) rather than shelling out per render — already used by other tree paths.
- If we ever migrate menu `when` clauses to regex (`=~`), extending `contextValue` with surface kind becomes a one-liner and opens per-surface menu items (e.g., "Open a fresh tmux attach" only for tmux-fresh-attach tasks).
- Consider a similar classifier for discovered agents so the adoption-sidecar / manual-terminal stories (see `research/RESEARCH-launcher-adoption-sidecar*`) get the same treatment.
