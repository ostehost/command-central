# RESULT — cc-agent-status-render-perf-polish-20260612

**Date:** 2026-06-12 · **Repo:** `~/projects/command-central` · **Branch:** main
**Start HEAD:** `e8c33fc8` · **Final HEAD:** `3abaf823` · **Tree:** clean (no dirty/untracked tracked-path changes; this receipt and `.oste-report.yaml` are the only new untracked files)

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

**Attach-socket wiring: verified correct, no code change needed.** `buildTaskTmuxArgs` (`src/commands/task-terminal-routing.ts:28–45`) prepends `-S <tmux_socket>` for every tmux invocation; the click path (`openGhosttyTmuxAttach`) already performs a `has-session` probe on the correct socket before attaching (`src/extension.ts:680–688`); the "tmux · fresh attach" chip only renders for `status === "running"` rows (provider line ~9004). The empty-Ghostty click Mike hit was the classification race above (row stuck Running after the session ended), not socket plumbing. A separate resurrection guard test confirms `status:"completed"` short-circuits (Tier 1a) before any liveness inference — completed records cannot be promoted back to Running.

### C. "Needs Review · review queue pending" row (cc-worksystem-projection-reader-gate-fixup-20260612)
**Genuine data hygiene, not a CC classification bug.** On-disk truth: `status:"completed"`, `review_state:"pending"` (non-terminal), `pending_review_path:/tmp/oste-pending-review/cc-worksystem-projection-reader-gate-fixup-20260612.json` → **ENOENT**. The lane advertised a receipt that was never written (or was removed without updating `review_state`). Per f5cb3729's logic the row is *correctly* flagged; hiding it would mask a real contract failure. CC's presentation was misleading, though — fixed by relabeling (below).

## 2. Fixes landed (commits e8c33fc8..3abaf823)

| Commit | What | Why safe |
|---|---|---|
| `93e2e69d` perf(agent-status) | 4 new caches: `_streamFilePathCache` (5s), `_streamTerminalStateCache` (5s), `_commitsSinceStartCache` (30s), `_displayTasksRenderCache` (per-render, registry-reference-gated + `queueMicrotask` invalidation); `scheduleTreeRefresh` debounce 0→16 ms | All caches cleared on `reload()` and `dispose()`; per-render memo expires every microtask so the 30s auto-refresh tick never repaints stale state; TTLs ≤ existing 5s liveness-cache convention (30s only for monotonic-ish commit counts); debounce preserves full-refresh-wins coalescing |
| `0eed7f0e` + `83c80884` + `11e4fc1a` test(agent-status) | Regression suite `agent-status-completed-tmux-regression.test.ts` (8 tests: 2 race repros, 5 guards incl. dead-session/dead-pane/no-chip/View-Changes, 1 completed+alive-session resurrection guard) + 17 perf-cache tests (`agent-status-perf-caches.test.ts`, 602 lines) | Tests only; locks the contract "completed records never show Running / fresh attach" |
| `f2096bca` fix(agent-status) | **Tier 2c**: completion evidence (`completed_at` set or `exit_code === 0`) promoted ABOVE `isRunningTaskHealthy()` in `toDisplayTask()` | Launcher completion evidence in tasks.json now wins over tmux liveness signals; cannot hide a genuinely running task (evidence fields are written only at completion); flipped the 2 failing regression repros to green |
| `3abaf823` fix(agent-status) | "review queue pending" → **"review receipt missing"** when `pending_review_path` is ENOENT (`src/utils/review-queue-health.ts`); row stays in Needs Review | More truthful, more actionable, hides nothing; group badge already rolls limbo into `doneTotal` so "16 done" header is consistent |

Note: `83c80884` is an Oste-Agent auto-commit that captured the perf-cache test file; content reviewed and legitimate.

## 3. Files changed

- `src/providers/agent-status-tree-provider.ts` (caches, debounce, Tier 2c)
- `src/utils/review-queue-health.ts` (receipt-missing label)
- `test/tree-view/agent-status-completed-tmux-regression.test.ts` (new, 8 tests)
- `test/tree-view/agent-status-perf-caches.test.ts` (new, 17 tests)
- `test/tree-view/agent-status-review-queue-gap.test.ts` (label assertions updated)

## 4. Verification (run by team lead, first-hand)

| Command | Result |
|---|---|
| `just ready` (fix + check + test) | **EXIT:0** — 2060 pass / 1 skip / 0 fail, 5557 expect() calls, 2061 tests across 146 files [16.02s]; quality gates clean (zero `as any`, zero reflection, zero skipped-actives) |
| `git status --short` after gate | clean |

Teammate runs during development (reported, consistent with the lead's gate): regression file 8/8; `just test-unit` 622/622; implementer's own `just ready` EXIT:0.

## 5. Remaining follow-ups

1. **Upstream data hygiene (ghostty-launcher / OpenClaw, outside this repo):** `cc-worksystem-projection-reader-gate-fixup-20260612` advertised a pending-review receipt that was never materialized (`review_state:"pending"`, receipt ENOENT). Fix belongs in the launcher completion/review-watchdog flow (`oste-complete.sh` / `oste-review-watchdog-runner.sh`); also consider making the launcher's tasks.json completion write atomic (status + completed_at in one write) to remove the race window at the source.
2. **Sync → async spawns:** `hasCommitsSinceStart()` still uses `execFileSync` (now 30s-cached, so frequency is bounded); converting the remaining sync git/fs probes to async is the long-term fix for extension-host stalls.
3. **Code review pass:** the independent reviewer dispatch was intentionally deferred at contract-close time; a post-hoc review of `e8c33fc8..3abaf823` (especially Tier 2c evidence provenance and cache invalidation) is recommended — e.g. `/code-review` or remote review lane.
4. This receipt is untracked at close (not committed), per the close-out instruction; commit it with a `docs(agent-status):` message if the receipt should live in history like prior handoffs.
