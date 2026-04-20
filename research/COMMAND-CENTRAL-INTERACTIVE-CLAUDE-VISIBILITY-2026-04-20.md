# Interactive Claude Visibility — Truth Hierarchy Hardening

**Task:** `cc-interactive-claude-visibility-fallback-20260420-1430`
**Date:** 2026-04-20
**Branch:** `main` (implementation only — release gating still owned by 0.6.0-rc.X handoff)

---

## Headline regression

A launcher-managed Ghostty/tmux Claude lane that the user is actively in
(interactive REPL, no `-p` flag, no JSONL writes for a long turn) was
disappearing from the running-agent view. The chain of responsibility:

1. `isAgentStuck` fired because the stream file was silent for >15 minutes.
2. `isRunningTaskHealthy` for tmux backends returned `!looksStale` once age
   crossed the 60-min stale window — so any quiet-but-alive lane got marked
   unhealthy.
3. `toDisplayTask` then routed the task through the dead-process / stale
   overlays and re-coloured it as `stopped` (or worse, `completed_stale`),
   removing it from the running view.
4. `ProcessScanner.parsePsOutput` simultaneously filtered the live interactive
   `claude` PID as `interactive-process` noise — so cross-validation via
   discovery never had a chance to fire.

End user impact: a real, alive, in-the-middle-of-thinking Claude lane vanished
from "running" and sometimes resurfaced under stale/attention. Truth model
was leaning on indirect signals (stream silence) to declare death.

---

## Truth hierarchy now in place

The strongest signal wins. From most authoritative to least:

| Layer | Source | When it fires |
| --- | --- | --- |
| 1 | Pending-review receipt (`/tmp/oste-pending-review/<task_id>.json`) | Launcher's `oste-complete.sh` wrote it — task is genuinely done |
| 2 | Launcher tasks.json status (non-running) | Launcher persisted a terminal status |
| 3 | Stream `turn.completed` / `error` JSONL terminal event | Agent itself reported completion |
| 4 | **Positive pane evidence** (`inspectTmuxPaneAgent → "alive"`) | A pane in the tmux session has an agent process or descendant — the lane is live |
| 5 | **Discovery cross-validation** (`hasLiveDiscoveredSession`) | Process scanner sees a matching session_id — corroborating evidence when pane evidence is unknown |
| 6 | Stream-mtime staleness + age-based `looksStale` | Last-resort heuristic when nothing positive is observable |
| 7 | **Confirmed dead pane** (`inspectTmuxPaneAgent → "dead"`) | Window alive but no agent process anywhere in the pane tree — definitive dead-process-running signal |

Layers 4-5 are the new positive-evidence path. They short-circuit BEFORE the
stale-stream heuristic can downgrade an interactive lane.

Layer 7 is unchanged — confirmed-dead always wins over silence.

---

## Implementation surface

### `src/utils/tmux-pane-health.ts`

- New `inspectTmuxPaneAgent(sessionId, tmuxSocket): "alive" | "dead" | "unknown"`.
- `"alive"`: positive evidence — a pane's `pane_current_command` matches a known
  agent name OR a descendant comm matches.
- `"dead"`: enumeration succeeded and no agent process was found anywhere in the
  pane tree.
- `"unknown"`: tmux unavailable, session vanished mid-call, malformed output,
  permission error — the legacy fail-open semantics, but now distinguishable
  from positive evidence.
- `isTmuxPaneAgentAlive(...)` is preserved as a back-compat wrapper:
  `inspectTmuxPaneAgent(...) !== "dead"`.

### `src/discovery/process-scanner.ts`

- `parsePsOutput` no longer drops interactive Claude as `interactive-process`
  noise when the PID is claimed by a launcher task.
- New `isLauncherClaimedPid(pid)` walks `launcherTasksProvider()` and matches
  against any task PID surface (process_pid, agent_pid, etc.).
- Net effect: an interactive `claude` running inside a launcher tmux lane
  shows up in discovery, which lets `hasLiveDiscoveredSession` cross-validate
  the lane.

### `src/providers/agent-status-tree-provider.ts`

- New `_tmuxPaneAgentEvidenceCache` (TTL 5s, mirrors the existing pane-health
  cache so call counts stay flat).
- `isRunningTaskHealthy` for tmux backends:
  ```
  if (!windowAlive) return false;
  if (paneEvidence === "dead") return false;
  if (paneEvidence === "alive") return true;          // positive wins
  if (this.hasLiveDiscoveredSession(task)) return true;
  return !looksStale;
  ```
- Non-tmux/non-persist backends:
  ```
  if (this.hasLiveDiscoveredSession(task)) return true;
  return !looksStale;
  ```
- New `hasPositiveLivenessEvidence(task)` helper.
- `createTaskItem` now distinguishes:
  - `stuckRaw && hasPositiveLivenessEvidence` → description tagged
    `(interactive)` with a `comment-discussion` icon and `charts.blue` colour.
  - `stuckRaw && !hasPositiveLivenessEvidence` → original `(possibly stuck)`
    warning UI is preserved.
- Cache invalidation in `reconcileDuplicateRunningSessions` now wipes the new
  evidence cache alongside the legacy boolean cache.

### Tests

- `test/utils/tmux-pane-health.test.ts` — 8 new tests for the tri-state
  inspector covering alive/dead/unknown and the back-compat wrapper.
- `test/tree-view/agent-status-dead-process-running.test.ts` — updated to mock
  both `isTmuxPaneAgentAlive` and `inspectTmuxPaneAgent`. Dead-pane test cases
  now also pin `inspectTmuxPaneAgent → "dead"`.
- `test/tree-view/agent-status-launcher-interactive-claude.test.ts` — new
  regression file (4 tests):
  - positive pane evidence + stale stream → stays running with `(interactive)`
  - unknown pane evidence + stale stream → downgraded out of running (proves
    the alive branch is doing real work)
  - dead pane evidence → drops out of running (sanity)
  - positive pane evidence with non-stale started_at → no `(interactive)` hint
    (guards against accidentally tagging every healthy lane)

---

## Tradeoffs

- **Persist backend left alone.** Persist sessions are designed to write
  streams; silence there is more genuinely suspicious. The positive-evidence
  short-circuit is tmux-only for now.
- **Pane inspection is best-effort.** `inspectTmuxPaneAgent` shells out to
  tmux/pgrep/ps with a 500ms cap. On overloaded systems we fall through to
  `"unknown"` and rely on layers 5-6. That's acceptable — the cache TTL keeps
  the cost bounded and the unknown path still preserves the old behaviour.
- **Honest UI label.** `(interactive)` deliberately replaces `(possibly stuck)`
  ONLY when we have positive evidence — we still surface the warning when
  we genuinely cannot tell. Avoids the failure mode of pretending every lane
  is fine.
- **Discovery override is intentionally narrow.** Process-scanner only
  un-filters interactive Claude when a launcher task already claims the PID.
  We do NOT pretend every interactive Claude in the system is a launcher task.

---

## Remaining gaps

- **No first-class "awaiting input" signal.** We infer interactive-awaiting
  from `(stuck heuristic && positive pane evidence)`. A real signal would
  require Claude to write a marker frame to the stream when it blocks for
  user input. Worth filing on the agent-stream-protocol side.
- **Tmux pane comm matching is name-based.** If the user invokes Claude via a
  shim/wrapper, `pane_current_command` may not match `AGENT_PROCESS_NAMES`.
  Descendant scan covers the common case but isn't bulletproof.
- **Process scanner only consults launcher tasks.json.** Interactive Claude
  lanes started outside the launcher are still filtered as noise. That's the
  correct behaviour for now (we shouldn't claim every random Claude is a
  task), but it means external launches won't appear in the discovered list.
- **Prerelease Ghostty visible-launch is still broken.** As noted in the
  0.6.0-rc.3 release-smoke handoff (commit b3c38f1), the visible-launch path
  via Ghostty currently fails: the new tmux bundle session never reaches a
  shell prompt and the agent process never starts. This work does NOT fix
  that — it hardens the truth model so that WHEN Ghostty visible-launch is
  back to producing live agents, the tree view will correctly show them as
  running/interactive instead of misclassifying them as stuck or stopped.

---

## Verification

- `bun test test/utils/tmux-pane-health.test.ts` — 25 pass / 0 fail
- `bun test test/tree-view/agent-status-dead-process-running.test.ts` — 7 pass / 0 fail
- `bun test test/tree-view/agent-status-launcher-interactive-claude.test.ts` — 4 pass / 0 fail
- `just test` — 1388 pass / 0 fail across 107 files
- `just check` — clean (biome CI + tsc + knip)
