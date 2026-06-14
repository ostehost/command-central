# RESULT — CC "rattle"/notification noise + Agent Status perf hunt

- **Task:** `cc-rattle-perf-critical-bugs-20260613`
- **Repo:** `~/projects/command-central` (Mike MacBook Pro)
- **Branch state at finish:** `main`, 7 commits ahead of `origin/main`; version `0.6.0-rc.60`
- **My commit:** `05af4109 fix(agent-status): suppress duplicate registry-fallback log spam`
- **Tree:** clean (`git status --porcelain` empty); `git diff --check origin/main...HEAD` clean

---

## TL;DR

**Is the "rattle" CC-caused?** → **Almost certainly NOT CC runtime. It is external** —
the Ghostty Launcher's `terminal-notifier` posting macOS notifications (which play the
system notification sound), and/or terminal bells from agents. In Mike's *actual* config
Command Central emits **no audible sound at all** (proof below).

That said, I found and addressed two real **notification/log-noise** defects in CC that
share one root cause (a registry read-race), and confirmed one **performance** gap worth a
follow-up. No history is hidden or dropped by any change — the doctrine that every
terminal/lane stays revisitable is preserved.

---

## Why the audible rattle is external, not CC (evidence)

CC has exactly **one** code path that can make a sound: `playNotificationSound()` →
`process.stdout.write("\x07")` (terminal BEL), at `src/providers/agent-status-tree-provider.ts`.

1. **It is gated and default-off.** `commandCentral.notifications.sound` default = `false`
   (`package.json`). **Mike's user `settings.json` does not set it** → it is `false`. CC
   never writes the BEL in his config.
2. **Dock bounce is a no-op in real VS Code.** `requestDockAttention()` calls
   `vscode.window.requestAttention()`, which **is not a real VS Code API** — the code guards
   `if (typeof windowWithAttention.requestAttention !== "function") return;`. It only "fires"
   in unit tests (where it is mocked). So dock attention produces no sound or bounce in
   production.
3. **`osascript` calls are user-triggered**, not timed: `src/ghostty/window-focus.ts` and
   `src/ghostty/TerminalManager.ts` invoke `osascript` only on explicit Focus-Terminal /
   activation actions — never on a poll.
4. **Discovery polling is off on this host.** Mike's `settings.json` has
   `commandCentral.discovery.enabled: false`, so the `ps`/`lsof` ProcessScanner +
   SessionWatcher poll loop is not even running here.
5. **CC itself fingers the real culprit.** The tree renders a warning when it detects
   `terminal-notifier` processes: *"⚠️ N stale terminal-notifier processes — run:
   `pkill -f "terminal-notifier.*oste"`"* (`agent-status-tree-provider.ts` ~line 8095).
   The launcher uses `terminal-notifier`/`osascript` for completion notifications, and those
   are macOS Notification Center posts that play the user's chosen notification sound = the
   "rattle".

**How to validate the external hypothesis (no code needed):**
- Confirm `commandCentral.notifications.sound` is `false` (it is) → CC will not BEL.
- Temporarily silence the launcher notifier (or macOS System Settings → Notifications →
  terminal-notifier / Script Editor / Ghostty → set sound to None) and observe the rattle stop.
- `pkill -f "terminal-notifier.*oste"` to clear the stale notifier processes CC warns about.
- If you *do* hear a bell tied to CC specifically, check whether `notifications.sound` got
  enabled — that BEL rings the launching terminal (e.g. Ghostty) when the extension host's
  stdout is a TTY.

---

## Findings (P0/P1/P2)

### P0 — none in CC runtime
No P0 release blocker originates in Command Central runtime. The standing P0/P1 release
blockers in the broader context (Ghostty auto-review `stdin is not a terminal`; Symphony
write dogfood NO_GO) are **launcher/review-infra and dogfood-env**, not CC code.

### P1 — Duplicate completion notifications on a registry read-race flap  *(fixed; in HEAD)*
- **Root cause:** `checkCompletionNotifications()` fires on the **raw** registry status, and
  `readRegistryFile()` returns an **empty** registry on any transient/partial read (mid-write
  truncation, momentary parse failure, empty file). With two merged sources (primary registry
  + Work-System lanes projection), a busy launcher can flap a task's raw status
  `completed → running → completed`. Each re-arrival re-fires the completion toast (and the
  BEL, if sound were on). `previousStatuses` alone does **not** stop this, because the spurious
  `running` read resets the transition.
- **Fix:** a `started_at`-keyed de-dup guard `shouldNotifyTerminalTransition(task)` (keyed
  `<status>::<started_at>`) so a given terminal *run* notifies exactly once; a genuine re-run
  (new `started_at`) still notifies. Tests cover both the flap (1 toast) and a genuine re-run
  (2 toasts).
- **Provenance note:** this was my work. While I was mid-task, a **concurrent "Claude Code"
  lane** committed `72216ce1` and swept my staged notification-de-dup changes (provider guard +
  the two flap tests in `agent-status-tree-provider-diff-notifications.test.ts`) into that
  commit alongside its own display-semantics work. The fix is therefore present and green in
  HEAD; it is just attributed to `72216ce1` rather than a separate commit of mine.

### P1 — Registry-fallback **log spam** on every reload  *(fixed by me — commit `05af4109`)*
- **Root cause:** `warnTaskRegistryFallback()` called `console.warn` **unconditionally**. The
  same read-race above (or a persistently empty/missing registry) makes CC re-emit an
  identical *"Falling back to an empty tasks registry … : tasks.json is empty"* line on **every**
  reload — and reloads are triggered by every launcher write (file-watch, 150 ms debounce). That
  is the log-channel "rattle".
- **Fix:** dedupe per `(source path → reason)` — warn once, stay quiet until the reason actually
  changes. This matches the file's existing *"log on change"* doctrine used for the
  path/state/quarantine info lines. **No task data is affected** — `readRegistry` still returns
  every lane; only the redundant log line is suppressed.
- **Tests** (`agent-status-tree-provider-read-registry.test.ts`):
  - repeated unchanged empty/partial reads warn **at most once**, and the registry is still
    fully readable (`registry.tasks === {}` for an empty source, nothing hidden);
  - **distinct** fallback reasons each still warn (dedup is per-reason, not a global mute).

### P2 — Synchronous tmux/git health spawns on the 5 s auto-refresh hot path  *(observed; not changed)*
- **Where:** `checkStaleTransitions()` → `getStaleTransitionReason()` → `isTaskSessionConfirmedDead()`
  shells out via **`execFileSync`** (`tmux has-session`, `tmux list-windows`, pane `pgrep/ps`,
  `persist`, and `git` for commits-since-start) **per running task**, on the extension-host
  **main thread**.
- **Cadence:** results are cached with a **5 s TTL**, but `commandCentral.agentStatus.autoRefreshMs`
  default is **5000 ms**. So in steady state, with N running agents, CC does ~N synchronous
  subprocess batches every ~5 s on the UI thread → periodic micro-jank on a busy host. This is
  the most plausible "performance" signal Mike felt. *Mitigated here because `discovery.enabled`
  is off*, but it still applies whenever agents are running.
- **Recommended follow-up (not done — behavior-sensitive, needs its own tests):** make the
  health probes async (move off the main thread), or set the health cache TTL strictly **>**
  `autoRefreshMs`, or back the auto-refresh off when the window is unfocused. Keep it a separate,
  test-driven change.

### P2 — Needs-Review backlog / idle Symphony summary noise  *(handled by sibling lane `72216ce1`)*
- The concurrent commit `72216ce1 "fix(agent-status): collapse stale Needs Review backlog and
  calm idle Symphony summary"` implements exactly the display-semantics doctrine Mike steered to:
  Needs-Review (limbo) groups auto-expand **only** while they hold a review item from the active
  working window; older review backlog is **collapsed-but-counted** ("the bucket header keeps its
  full count, so nothing is hidden — only auto-expansion is suppressed"); Done is always collapsed;
  a large historical attempt count reads as read-only history. **History stays present and
  navigable** — only auto-expansion/visual dominance is calmed. No further action needed from this
  task; flagged here for review awareness.

---

## Changes made (this task)

| File | Change |
|---|---|
| `src/providers/agent-status-tree-provider.ts` | `warnTaskRegistryFallback` → instance method with per-`(path→reason)` dedup (`_lastWarnedRegistryFallback`); 7 call sites routed through it. |
| `test/tree-view/agent-status-tree-provider-read-registry.test.ts` | +2 tests: repeated unchanged reads warn once (history still readable); distinct reasons each warn once. |

Committed as `05af4109`. (The P1 notification-flap guard + its 2 tests are in HEAD via the
concurrent `72216ce1`, as noted above.)

**Doctrine compliance:** neither change hides or drops any lane/terminal. Both only suppress
*repeated, unchanged* noise (a duplicate toast for the same run; a duplicate warning for the same
unhealthy state). `readRegistry` returns the full task set unchanged.

---

## Gates (all green)

- `just test` (full incl. typecheck): **2071 pass / 0 fail**, *"✅ Quality checks passed!"*, *"✅ Zero 'as any'"*.
- `just test-unit`: **622 pass / 0 fail** (git-sort 129 + core 493).
- `bun test test/tree-view/`: **449 pass / 0 fail** (includes the 2 new log-spam tests + the 2 flap tests).
- `just check`: passes. (8 pre-existing Biome `noNonNullAssertion` warnings in
  `test/tree-view/agent-status-perf-caches.test.ts` — **not introduced here**; `just check` is
  non-strict and they do not block. `just ci` would treat them as errors — pre-existing.)
- `git diff --check origin/main...HEAD`: clean.
- Pre-commit Biome hook: passed (no `--no-verify`).

---

## Remaining release blockers for the next CC RC

1. **Not CC runtime — external infra:**
   - Ghostty auto-review startup still broken (`stdin is not a terminal`) — launcher/review-infra.
   - Symphony write dogfood NO_GO pending live approval/env.
2. **CC performance follow-up (P2, optional for RC):** async-ify or TTL-tune the synchronous
   tmux/git health probes on the 5 s auto-refresh path (see P2 above). Not a hard blocker; matters
   on hosts running many agents with `discovery.enabled` on.
3. **Operational, not code:** clear stale `terminal-notifier` processes
   (`pkill -f "terminal-notifier.*oste"`) and confirm the launcher's notification sound is the
   intended source of the "rattle" before any RC sign-off that references the noise.

No release was cut/built/installed (not requested). No push/tag/publish. No other repos mutated.

---

## Concurrency caveat for the reviewer

A second `Claude Code`-identity lane was committing to this same working copy during the task
(commits `72216ce1`, `eb23f3da`). It bundled my staged notification-de-dup changes into
`72216ce1`. The end state is consistent and fully green, but provenance of the notification guard
lives in `72216ce1`, not in a commit of mine. My isolated, independently-committed contribution is
the log-spam dedup in `05af4109`.
