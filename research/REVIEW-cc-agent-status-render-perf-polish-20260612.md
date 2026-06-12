# REVIEW — cc-agent-status-render-perf-polish-20260612

**Date:** 2026-06-12 · **Reviewer:** independent review lane (`review-cc-agent-status-render-perf-polish-20260612`)
**Repo:** `~/projects/command-central` · **Branch:** main
**Range reviewed:** `e8c33fc8..92788e0c` (9 commits, includes manager follow-through `815d4d9e` + `92788e0c`)
**HEAD at review:** `92788e0cc20d9961653b855051ec997d2cde6d66`
**Working tree:** clean before and after review (`git status --porcelain` empty; this handoff is the only new file)

## Verdict: **ACCEPT**

Safe to cut/install the next rc. Full suite green, strict biome gate exits 0, tsc clean,
no behavioral regressions found. All findings below are Low/Info severity — none block
acceptance; they are suitable for a follow-up polish lane.

## Commands run (all exit 0)

| Command | Result |
|---|---|
| `bun test test/tree-view/agent-status-completed-tmux-regression.test.ts test/tree-view/agent-status-perf-caches.test.ts test/tree-view/agent-status-review-queue-gap.test.ts` | 33 pass / 0 fail (105ms) — EXIT:0 |
| `just check` (biome + tsc + knip, read-only) | EXIT:0 — 8 biome warnings (see F7) |
| `bunx @biomejs/biome ci ./src ./test ./scripts-v2` (strict CI lint gate) | EXIT:0 — warnings do not fail the gate |
| `just test` (full suite + quality gates) | EXIT:0 — 2060 pass / 1 skip / 0 fail, 5557 expect() across 146 files [14.8s]; zero `as any`, zero reflection, zero skipped-actives |

`just ready` was deliberately NOT run (its `fix` step writes to the tree; review mode
requires an untouched tree). `just check` + full `just test` is the read-only equivalent
and matches the receipt's claimed results (receipt: 2060/1/0).

## Scope-item verification

### 1. Tier 2c — completion evidence above liveness (f2096bca) ✅ SOUND
- Verified final ordering in `toDisplayTask()` (`agent-status-tree-provider.ts:2167-2241`):
  Tier 1b receipt → Tier 2a stale-cache → Tier 1a terminal-status short-circuit →
  Tier 2b stream terminal event → **Tier 2c completion evidence** → Tier 3 liveness →
  Tier 4 commits/stopped. Tier 2c only runs for `status === "running"` records.
- **Cannot hide a genuinely running task** — verified at the source of truth:
  the only writer of `status:"running"` in the launcher is `oste-spawn.sh:1341`
  (`~/projects/ghostty-launcher/scripts/`), and it writes a **complete replacement
  record** (`.tasks[$id] = {...}`) containing no `completed_at`/`exit_code`. A respawned
  task id therefore cannot carry stale completion evidence into a live run; those fields
  exist on a "running" record only via the partial-write completion race Tier 2c targets.
- Branch logic correct: `exit_code === 0` → completed; `exit_code == null && completed_at`
  → completed; non-zero `exit_code` → failed. `applyRuntimeStatusOverlay` synthesis of
  `exit_code ?? 0` / `completed_at ?? now` matches the pre-existing Tier 4 pattern.
- Resurrection direction also locked: Tier 1a returns terminal records before any
  liveness inference; the dedicated test (`agent-status-completed-tmux-regression.test.ts:321`)
  guards completed+alive-window+unknown-pane staying "done".

### 2. TTL caches + invalidation (93e2e69d) ✅ SOUND
- `_streamFilePathCache` (5s), `_streamTerminalStateCache` (5s),
  `_commitsSinceStartCache` (30s, keyed `taskId::startRef`), `_displayTasksRenderCache`
  (per-burst memo, registry-reference-guarded + `queueMicrotask` invalidation).
- All four cleared in `reload()` (provider:2846-2852) **and** `dispose()` (provider:9366-9372);
  the debounce timer is also cleared on dispose (provider:9354-9357).
- Per-render memo safety verified: all 14 `getDisplayLauncherTasks()` call sites use
  non-mutating ops (`find`/`filter`/`some`/spread); `reconcileDuplicateRunningSessions`
  returns a fresh `.map()` array, so the shared memoized reference cannot be poisoned.
  `queueMicrotask` clears only the cache pointer, not the registry pointer — correct,
  since the hit check requires `cache !== null`.
- TTLs are consistent with the pre-existing 5s liveness-cache convention; 30s for commit
  counts is justified (near-monotonic signal, 3s-timeout sync git spawn was the
  "rattling"). Negative results are also cached — a dirty-exit task may show "stopped"
  up to 30s before flipping to completed_dirty; bounded and acceptable.

### 3. 16ms refresh debounce ✅ SOUND
- `scheduleTreeRefresh` (provider:1596-1630): full-refresh-wins coalescing preserved
  (global refresh clears element queue; unkeyable elements promote to global); single
  timer, nulled in callback, cleared on dispose. 16ms ≈ one frame — imperceptible
  latency, meaningful coalescing of cross-tick watcher/config/discovery storms.

### 4. Click-time cached tmux liveness (815d4d9e + 92788e0c) ✅ SOUND, 2 nits
- `isTaskTmuxSessionAlive()` (provider:1806-1810) delegates to the 5s-TTL
  `_tmuxSessionHealthCache`; **on cache miss the underlying probe is a fresh synchronous
  `tmux has-session` (500ms timeout)** — so a cold-cache click still gets a real answer,
  never a default-false. Remote-node and invalid-session guards match the extension-local
  helper's semantics.
- TOCTOU fallback (extension.ts:1218-1227): if the cache said alive but
  `openGhosttyTmuxAttach` fails (it re-probes `has-session` on the correct socket via
  `buildTaskTmuxArgs` before attaching), the click is never silently dropped — explicit
  warning + dead-session QuickPick. Complies with the no-silent-integrated-terminal-
  fallback rule (the dead route is a QuickPick of transcript/resume/focus actions).

### 5. "review receipt missing" label (3abaf823) ✅ COMPLETE
- Label string lives at provider:8963; rename is exhaustive — zero remaining
  "review queue pending" references in src/ or test/. Metadata-authority guard
  (resolved review states suppress the probe) unchanged in `review-queue-health.ts`
  (comment-only diff there). True warnings preserved: ENOENT receipt still routes the
  row to "limbo"/Needs Review (provider:4329-4331); host-mismatch and post-approval
  steady states still suppress it (re-verified by the updated gap tests).

### 6. Test quality ✅ MEANINGFUL, minor nits
- The two race repros mirror the production scenario exactly (running + completed_at /
  exit_code=0 + alive window + unknown fail-open pane) with ground-truth values from the
  real Symphony task. The resurrection guard covers the strongest inverse case.
- Perf-cache tests prove behavior by spawn-count deltas (not just timestamps) and cover
  reload/dispose/registry-reassignment invalidation. White-box access to private cache
  maps is acceptable coupling for cache tests and fails loudly on rename.
- Not overfit: assertions target observable outcomes (group, status, description,
  command title, spawn counts), not implementation order.

## Findings (none blocking)

| # | Severity | Location | Finding |
|---|---|---|---|
| F1 | Low | `src/extension.ts:1203-1206` | Liveness chain prefers the provider's ≤5s-stale cached value over `probedTmuxSessionAlive`, which was probed fresh earlier in the same click handler (line 1076). Stale-alive is fully covered by the TOCTOU guard; stale-dead can misroute a click to the dead-session QuickPick for ≤5s after a session comes alive (graceful, bounded). Ordering `probedTmuxSessionAlive ?? providerCache ?? fresh` would be strictly better. |
| F2 | Low | `src/extension.ts:1224-1226` | TOCTOU warning text claims "Session ended just before Ghostty could attach", but `openGhosttyTmuxAttach` also returns false when the `open -n -b com.mitchellh.ghostty` spawn fails (Ghostty missing/launch error). Message can misattribute the cause; fallback behavior is still correct. |
| F3 | Info | `test/tree-view/agent-status-completed-tmux-regression.test.ts:402-415, 421, 445` | Stale "FAILING TEST — awaits fix in task #3" / "CURRENTLY FAILS" comments describe the pre-fix state; the tests now pass. Update to plain regression-guard wording. |
| F4 | Info | `test/tree-view/agent-status-perf-caches.test.ts` | No direct test for the `queueMicrotask` invalidation (e.g. `await Promise.resolve()` → expect a fresh array reference). Same-burst memo, reload, and registry-reassignment paths are covered. |
| F5 | Info | receipt `RESULT-…20260612.md` §2 | Receipt attributes the label change to `src/utils/review-queue-health.ts`; the label string actually lives in the provider (line 8963) — the util got a comment-only update. No impact. |
| F6 | Info | 30s `_commitsSinceStartCache` | Caches negative results, so a dirty-exit task can read "stopped" for up to 30s before flipping to completed_dirty. Acceptable trade against the sync-git rattling; noting for awareness. |
| F7 | Info | `test/tree-view/agent-status-perf-caches.test.ts` (8 sites) | Biome `lint/style/noNonNullAssertion` warnings (fixable-unsafe, so `just fix` leaves them). `biome ci` exits 0 with warnings, so neither `just ci` nor GitHub CI is blocked. Cosmetic. |

## Residual risks accepted
- `hasCommitsSinceStart` remains `execFileSync` (frequency now bounded by the 30s cache);
  async conversion is correctly listed as a receipt follow-up.
- Upstream launcher data hygiene (receipt advertised but never written;
  non-atomic status/completed_at writes) is out of scope here and correctly routed to
  ghostty-launcher as a follow-up — Tier 2c makes CC robust to that race in the meantime.

## Conclusion

**ACCEPT.** The three user-reported bugs have correct, well-tested fixes; cache
invalidation is complete (reload + dispose + reference guard + microtask); Tier 2c
cannot suppress a genuinely running task given how the launcher writes task records;
the click path never silently dead-ends. Safe to proceed with the next rc cut/install.
F1–F4 are good candidates for a small follow-up fixup lane but do not gate the release.
