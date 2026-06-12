# RESULT — cc-agent-status-render-perf-polish-20260612

**Date:** 2026-06-12 · **Repo:** `~/projects/command-central` · **Branch:** main
**Start HEAD:** `e8c33fc8` · **Final HEAD:** `92788e0c` · **Tree:** clean (`.oste-report.yaml` is the only untracked file; it is ephemeral and intentionally uncommitted)

> Amended after initial close: the implementer landed two click-guard hardening commits (`815d4d9e`, `92788e0c`) while the first version of this receipt (recorded at `3abaf823`) was being finalized; this version reflects the true final tree, re-verified by the lead.

Team run (Agent Teams): team-lead (this lane, Fable) + implementer (Sonnet) + tester (Sonnet). All code/test commits below were made by teammates and verified by the lead.

## 1. Root causes found

### A. Render perf / "rattling" (slow Agent Status tree, frequent process/fs churn)
1. **`getDisplayLauncherTasks()` recomputed 12+× per render cycle** (call sites at provider lines ~2508–7487), each pass running `toDisplayTask()` over every task — no per-render memo.
2. **`getStreamTerminalState()` uncached sync I/O** (`readFileSync` + `statSync` per running task) inside `toDisplayTask()` — multiplied by the 12× call pattern → dozens of sync file reads per repaint.
3. **`hasCommitsSinceStart()` uncached `execFileSync("git", ["rev-list", "--count", …])`** (3s timeout) as last-resort liveness inference — synchronous git spawns on the extension-host thread per repaint; this is the "rattling".
4. **`resolveStreamFilePath()`** probing 3–4 candidate paths with `fs.existsSync` per call, uncached.
5. **`scheduleTreeRefresh()` debounce was 0 ms** — only coalesced same-microtask calls; cross-tick triggers (discovery events, config changes, dual watchers) each fired a full tree refresh.

Already healthy (no change needed): tmux liveness, pane evidence, handoff state, and pending-review receipt checks all had 5s TTL caches.

### B. Symphony row stuck on "Running · tmux · fresh attach" (completed review)
**Partial-write race in `toDisplayTask()`:** when `tasks.json` momentarily holds `status:"running"` with `completed_at` already written (launcher writes the timestamp before flipping status), and the tmux window is alive on a **custom socket** with pane evidence `"unknown"` (fail-open), `isRunningTaskHealthy()` returned true and the completion-evidence check (old Tier 4) was never reached. The task stayed Running indefinitely with the fresh-attach chip. Ground truth verified on disk for `review-symphony-orchestrator-http-decision-client-20260612`: now `status:"completed"`, `completed_at:2026-06-12T18:19:58Z`, session alive on custom socket `…/symphony-daemon-worksystem-lease-3699459906.sock` (default-server `tmux list-sessions` empty — consistent with Mike's observation).

**Attach-socket wiring: verified correct as-is, then hardened at click time.** `buildTaskTmuxArgs` (`src/commands/task-terminal-routing.ts:28–45`) prepends `-S <tmux_socket>` for every tmux invocation; the click path (`openGhosttyTmuxAttach`) already performs a `has-session` probe on the correct socket before attaching (`src/extension.ts:680–688`); the "tmux · fresh attach" chip only renders for `status === "running"` rows (provider line ~9004). The empty-Ghostty click Mike hit was the classification race above (row stuck Running after the session ended), not socket plumbing. A separate resurrection guard test confirms `status:"completed"` short-circuits (Tier 1a) before any liveness inference — completed records cannot be promoted back to Running.

### C. "Needs Review · review queue pending" row (cc-worksystem-projection-reader-gate-fixup-20260612)
**Genuine data hygiene, not a CC classification bug.** On-disk truth: `status:"completed"`, `review_state:"pending"` (non-terminal), `pending_review_path:/tmp/oste-pending-review/cc-worksystem-projection-reader-gate-fixup-20260612.json` → **ENOENT**. The lane advertised a receipt that was never written (or was removed without updating `review_state`). Per f5cb3729's logic the row is *correctly* flagged; hiding it would mask a real contract failure. CC's presentation was misleading, though — fixed by relabeling (below).

## 2. Fixes landed (commits e8c33fc8..92788e0c)

| Commit | What | Why safe |
|---|---|---|
| `93e2e69d` perf(agent-status) | 4 new caches: `_streamFilePathCache` (5s), `_streamTerminalStateCache` (5s), `_commitsSinceStartCache` (30s), `_displayTasksRenderCache` (per-render, registry-reference-gated + `queueMicrotask` invalidation); `scheduleTreeRefresh` debounce 0→16 ms | All caches cleared on `reload()` and `dispose()`; per-render memo expires every microtask so the 30s auto-refresh tick never repaints stale state; TTLs ≤ existing 5s liveness-cache convention (30s only for monotonic-ish commit counts); debounce preserves full-refresh-wins coalescing |
| `0eed7f0e` + `83c80884` + `11e4fc1a` test(agent-status) | Regression suite `agent-status-completed-tmux-regression.test.ts` (8 tests: 2 race repros, 5 guards incl. dead-session/dead-pane/no-chip/View-Changes, 1 completed+alive-session resurrection guard) + 17 perf-cache tests (`agent-status-perf-caches.test.ts`, 602 lines) | Tests only; locks the contract "completed records never show Running / fresh attach" |
| `f2096bca` fix(agent-status) | **Tier 2c**: completion evidence (`completed_at` set or `exit_code === 0`) promoted ABOVE `isRunningTaskHealthy()` in `toDisplayTask()` | Launcher completion evidence in tasks.json now wins over tmux liveness signals; cannot hide a genuinely running task (evidence fields are written only at completion); flipped the 2 failing regression repros to green |
| `3abaf823` fix(agent-status) | "review queue pending" → **"review receipt missing"** when `pending_review_path` is ENOENT (`src/utils/review-queue-health.ts`); row stays in Needs Review | More truthful, more actionable, hides nothing; group badge already rolls limbo into `doneTotal` so "16 done" header is consistent |
| `815d4d9e` fix(agent-status) | New public `isTaskTmuxSessionAlive(task)` on the provider, delegating to the private 5s-TTL `_tmuxSessionHealthCache` probe; false for remote-node tasks and missing/invalid session IDs | Exposes existing cached liveness — no new shell spawns |
| `92788e0c` fix(agent-status) | Click-time guard in `commandCentral.focusAgentTerminal` (Strategy 3): cached liveness check before spawning Ghostty; dead session → dead-session QuickPick (View Diff/Transcript), no spawn; TOCTOU race (session dies between probe and attach) → explicit warning notification + same QuickPick | All paths explicit and visible; never a silent integrated-terminal fallback (hard user constraint); reuses the render-path cache so clicks add zero probe cost |
| `b2b4123a` docs | This receipt committed to history (later amended to final HEAD) | Docs only |

Note: `83c80884` is an Oste-Agent auto-commit that captured the perf-cache test file; content reviewed and legitimate.

## 3. Files changed

- `src/providers/agent-status-tree-provider.ts` (caches, debounce, Tier 2c, public cached-liveness accessor)
- `src/extension.ts` (click-time liveness guard + TOCTOU warning in focusAgentTerminal)
- `src/utils/review-queue-health.ts` (receipt-missing label)
- `test/tree-view/agent-status-completed-tmux-regression.test.ts` (new, 8 tests)
- `test/tree-view/agent-status-perf-caches.test.ts` (new, 17 tests)
- `test/tree-view/agent-status-review-queue-gap.test.ts` (label assertions updated)

## 4. Verification (run by team lead, first-hand)

| Command | Result |
|---|---|
| `just ready` at `3abaf823` (fix + check + test) | **EXIT:0** — 2060 pass / 1 skip / 0 fail, 5557 expect() calls, 2061 tests across 146 files [16.02s] |
| `just ready` at final `92788e0c` (re-run after click-guard commits) | **EXIT:0** — 2060 pass / 1 skip / 0 fail, 5557 expect() calls, 2061 tests across 146 files [15.13s]; quality gates clean (zero `as any`, zero reflection, zero skipped-actives) |
| `git status --short` after each gate | clean |

Teammate runs during development (reported, consistent with the lead's gate): regression file 8/8; `just test-unit` 622/622; implementer's own `just ready` EXIT:0.

**Independent review (team reviewer, delivered post-close):** `e8c33fc8..3abaf823` reviewed — **0 blocking, 3 nits**. Confirmed safe: Tier 2c cannot mask a running retry (oste-spawn writes a fresh record without exit_code/completed_at on task-id reuse, and Tier 2c sits inside the `status !== "running"` guard at provider:2176); all caches cleared on `reload()`/`dispose()`; debounce coalescing keeps full-refresh-wins; no new silent terminal fallbacks; style clean. Nits: (1) `_displayTasksCachedRegistry` reference not nulled in the queueMicrotask callback (harmless, held until next population); (2) no cross-burst memo-expiry test (`await Promise.resolve()` between calls → recompute) — coverage gap for the core memo invariant; (3) `_streamFilePathCache` caches null results for 5s, so a just-created stream file can be missed briefly → bounded, self-correcting false "stuck" window on freshly started agents. The click-guard commits `815d4d9e`/`92788e0c` were NOT reviewed (reviewer shut down before the addendum).

## 5. Remaining follow-ups

1. **Upstream data hygiene (ghostty-launcher / OpenClaw, outside this repo):** `cc-worksystem-projection-reader-gate-fixup-20260612` advertised a pending-review receipt that was never materialized (`review_state:"pending"`, receipt ENOENT). Fix belongs in the launcher completion/review-watchdog flow (`oste-complete.sh` / `oste-review-watchdog-runner.sh`); also consider making the launcher's tasks.json completion write atomic (status + completed_at in one write) to remove the race window at the source.
2. **Sync → async spawns:** `hasCommitsSinceStart()` still uses `execFileSync` (now 30s-cached, so frequency is bounded); converting the remaining sync git/fs probes to async is the long-term fix for extension-host stalls.
3. **Code review pass:** base range `e8c33fc8..3abaf823` is reviewed (0 blocking, 3 nits — see §4); remaining review scope is only the click-guard commits `815d4d9e..92788e0c` (TOCTOU path, public accessor surface). The three nits are cheap cleanups to fold into the next touch of the provider.
4. **Click-guard tests missing:** the tester was shut down before writing tests for the new `isTaskTmuxSessionAlive` accessor and the dead-session/TOCTOU click paths (`815d4d9e`/`92788e0c` landed test-less; full suite still green). Add unit tests for: dead session + click → no spawn + QuickPick; alive session + click → attach with `-S <socket>`; TOCTOU → warning notification path.
