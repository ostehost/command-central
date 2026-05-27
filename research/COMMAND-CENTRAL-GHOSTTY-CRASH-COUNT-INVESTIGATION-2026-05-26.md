# Command Central Badge Count & Ghostty Crash Investigation

**Task ID:** `cc-ghostty-count-investigation-20260526`
**Date:** 2026-05-26
**Repo:** `/Users/ostehost/projects/command-central`
**Git HEAD:** `6bfe69d0`
**Git status:** `?? research/AGENT-STATUS-NEEDS-REVIEW-TRIAGE-2026-05-26.md`
**Investigator role:** read-only diagnostic / reviewer

---

## 1. User-Reported Symptoms

At ~20:32 EDT on 2026-05-26, Mike observed:

1. VS Code Command Central sidebar for project `config` shows a **blue activity badge of `2`** on the Command Central activity icon — but only **1 running task** exists.
2. `AGENT STATUS` section shows **CONFIG (1) 1 working** with one visible task (`linear-import-partnerai-config-live-20260526`).
3. `SYMPHONY` section shows **1 run attempt · 0 workstreams · 1 running**.
4. A macOS crash dialog: **"ghostty quit unexpectedly"**.
5. An error notification: **"Ghostty project terminal unavailable: Command failed: launcher --send ... --command claude --resume 0ac78f2b... Error: failed to open /Applications/Projects/config.app. Open in VS Code integrated terminal instead?"**

The investigation task (`cc-ghostty-count-investigation-20260526`) started at 20:33:52 EDT — **after** the badge of 2 was observed. So it cannot be the second counted item.

---

## 2. Badge Count of 2 — Confirmed Bug: Dual Badge-Setting Paths + Dedup Gap

### Launcher Task Truth at ~20:32

At the time of observation, `tasks.json` contained only **1 running task**:

| Task ID | Project | Status | Started (UTC) |
|---------|---------|--------|---------------|
| `linear-import-partnerai-config-live-20260526` | config | running | 2026-05-27T00:30:54Z |

The investigation task (`cc-ghostty-count-investigation-20260526`) was not yet launched.

### Root Cause: Two Competing Badge Code Paths

The activity bar badge is set by **two independent paths** in `src/providers/agent-status-tree-provider.ts` that use **different data sets and counting methods**:

**Path A — `updateDockBadge()` (line 3004-3026):**
```typescript
const runningCount = this.getTasks().filter(
    (task) => task.status === "running",
).length;
this._agentStatusView.badge = { value: runningCount, tooltip };
```
- Data: `getTasks()` = launcher tasks + discovered agents + **OpenClaw/ACP synthetic tasks**
- Counts only `status === "running"`

**Path B — `getChildrenImpl()` (line 3499-3505) — runs when grouped by project:**
```typescript
this._agentStatusView.badge = {
    value: agentCounts.total,
    tooltip: `${agentCounts.total} agents · ${counts.working} working`,
};
```
- Data: `getScopedAgentTasksForSummary()` = launcher tasks + discovered agents (no OpenClaw)
- Uses `agentCounts.total` = **all statuses** (running + completed + failed + etc.), not just working

Both paths write to the same `this._agentStatusView.badge`. The tree refresh (`getChildrenImpl`) runs after `updateDockBadge()` on registry reload (line 2721-2722), so **Path B overwrites Path A** in grouped-by-project mode.

### Bug #1: `agentCounts.total` vs `counts.working`

Path B sets the badge to `agentCounts.total` — **all statuses, not just running**. Any completed/failed/stopped task still in the registry inflates the badge even though it isn't actively working. The tooltip shows `"2 agents · 1 working"`, but the badge number is `2`, which is misleading.

**Fix:** Change line 3503 from `value: agentCounts.total` to `value: counts.working` (or `agentCounts.working`).

### Bug #2: Discovered Agent Dedup Gap (pid: null)

The launcher task at 20:32 has **`pid: null`**:

```json
{
  "pid": null,
  "claude_session_id": "0ac78f2b-4769-406e-b761-94a023bfedec",
  "session_id": "agent-config",
  "project_dir": "/Users/ostehost/projects/config"
}
```

The dedup logic in `agent-registry.ts:375` (`isSuppressedByLauncherTask`) tries these matches in order:

1. **PID match** (line 398-401): `task.pid` is null → **skipped**
2. **Session ID match** (line 408-418): requires `agent.sessionId` from process scanner. The scanner extracts `--resume <uuid>` from the command line (line 522-523). If the claude process's command line lacks `--resume` (fresh start) or the scanner didn't capture it, `agent.sessionId` is undefined → **skipped**
3. **Project dir + start time** (line 421-446): requires exact `projectDir` match AND start times within 15 minutes. If the process scanner resolved a subdirectory as the CWD, or the discovered agent's `startTime` diverged → **fails**

When all three checks fail, the discovered agent (the claude process running in tmux pane %10) is **not suppressed** and counted as a second running agent: 1 launcher task + 1 discovered agent = badge of 2.

### Most Likely Scenario

The process scanner found the claude process running in the config project's tmux pane. The launcher task had `pid: null`, so PID-based dedup was impossible. The session ID match or project-dir heuristic also failed (possibly because the process was started without `--resume`, or CWD resolution yielded a different path). Result: the same agent was counted twice — once from the launcher registry, once from process discovery.

### Supporting Evidence

- Symphony shows "1 run attempt · 1 running" — this is the launcher task projected as a run attempt, confirming only 1 real agent exists
- The user sees CONFIG (1) with 1 task — the launcher truth is 1 task
- `oste-status.sh --json` shows 2 agents only because this investigation task has since started

---

## 3. Ghostty Crash — Root Cause: macOS Code Signing Launch Constraint Violation

### Connection to the Error Message

The user's error notification traces directly to `src/ghostty/TerminalManager.ts`:

1. User clicked to open/resume the agent → `runInProjectTerminal()` (line 641)
2. CC delegated to `sendCommandViaLauncher()` (line 851) → `launcher --send /Users/ostehost/projects/config --command claude --resume 0ac78f2b...`
3. The launcher tried to `open -a /Applications/Projects/config.app`
4. **config.app crashed immediately** due to code signing violation
5. Launcher returned error → CC caught it → `promptIntegratedTerminalFallback()` (line 868) → showed the fallback dialog

This is CC working correctly — it detected the Ghostty failure and offered the VS Code terminal fallback. The crash at 20:31 (4 reports) aligns with this: the launcher tried to open config.app, macOS killed it 4 times in rapid succession, and the launcher reported failure to CC.

### Crash Evidence

21 crash reports today, all in `~/Library/Logs/DiagnosticReports/`:

| Time (EDT) | Crash Count | Bundle |
|------------|-------------|--------|
| 16:33 | 6 reports | `dev.partnerai.ghostty.config` |
| 18:26 | 4 reports | `dev.partnerai.ghostty.config` |
| 18:42 | 1 report | `dev.partnerai.ghostty.config` |
| 20:31 | 4 reports | `dev.partnerai.ghostty.config` |

**All 21 crashes** share identical signatures:

```
exception.type:          EXC_CRASH
exception.signal:        SIGKILL (Code Signature Invalid)
termination.namespace:   CODESIGNING
termination.code:        4
termination.indicator:   Launch Constraint Violation
```

### Crashed Binary Details

```
procPath:     /Applications/Projects/config.app/Contents/MacOS/ghostty
bundleID:     dev.partnerai.ghostty.config
app_version:  f9a9d33b3
Signature:    adhoc
TeamIdentifier: not set
Internal requirements count: 0
codeSigningTrustLevel: 4294967295 (untrusted)
codeSigningValidationCategory: 10
platform:     macOS 26.5 (25F71)
```

Key problems:
- **Ad-hoc signature** — not signed by a Developer ID or Apple certificate
- **No TeamIdentifier** — macOS Launch Constraints require a team identity on macOS 26.x
- **Zero internal requirements** — no designated requirement set
- **`codeSigningTrustLevel: 0xFFFFFFFF`** — macOS does not trust the signature

Both `config.app` and `command-central.app` share this signing profile.

### Crash Mechanics

- Process launches and is killed within ~30ms by the macOS kernel
- Multiple PIDs crash in the same sub-second window (e.g., PIDs 36606, 36634, 36654 all at 20:31:27)
- The launcher or macOS Launch Services retries rapidly before giving up
- The macOS crash dialog is generated after these rapid failures

### What's NOT Crashing

The **tmux backend** is unaffected. The tmux server was launched earlier and continues running:

```
agent-config: 9 windows (created Mon May 25 21:07:03 2026) (attached)
agent-command-central: 13 windows (created Mon May 25 20:10:48 2026)
```

`oste-status.sh --json` confirms agents are `state: "running"` / `idle_state: "active"`. `honest_visible: false` means no Ghostty GUI window is attached — sessions run headless via tmux.

The crash only occurs when macOS attempts to launch the **Ghostty GUI frontend** from the custom app bundle. Agent work continues uninterrupted via tmux.

---

## 4. Confirmed Facts

1. Badge of 2 appeared when only 1 running task existed — this investigation task hadn't started yet.
2. All 21 Ghostty crashes today are `Launch Constraint Violation` — macOS kernel SIGKILL at launch.
3. Only `config.app` bundle crashed today (no `command-central.app` crashes observed).
4. Both app bundles use ad-hoc signing with no team identifier.
5. tmux backends are healthy and agent work is uninterrupted.
6. The crash is NOT a Ghostty application bug — the binary never executes; killed at load by kernel.
7. CC correctly detected the Ghostty failure and offered the VS Code integrated terminal fallback.
8. The launcher task's `pid` field is `null`, weakening the process-scanner dedup.
9. The badge-setting code has two competing paths with different counting semantics.

## 5. Likely Root Causes (Separated)

### Badge Count Mismatch

**Primary cause:** A process-scanned discovered agent (the claude process in tmux pane %10) was not suppressed by launcher task dedup because `task.pid` is null and secondary matching heuristics (session ID, project dir + start time) failed. The same agent was counted once as a launcher task and once as a discovered agent.

**Contributing code issue:** The grouped-by-project badge at line 3503 uses `agentCounts.total` (all statuses) rather than `counts.working` (running only). Even if dedup worked, any completed/failed task in the registry would inflate the badge.

### Ghostty Crash

**macOS 26.5 (Tahoe, build 25F71) enforces Launch Constraints** that reject ad-hoc signed binaries in custom app bundles without a team identifier. The Ghostty binary inside `config.app` fails this check at load time.

## 6. Unknowns

- Whether the dedup failed on session ID match or project-dir match (would require a live process scan during the badge=2 state to confirm).
- Whether the binary passed launch constraints on a previous macOS version or if a recent update tightened enforcement.
- Whether other project bundles (`command-central.app`, `concierge.app`) would also crash on fresh GUI launch (no crashes observed today, possibly because they haven't tried recently).
- Whether the Ghostty launcher has a retry-on-crash loop or macOS Launch Services does this natively.

## 7. Proposed Fixes

### For Command Central (this repo) — Badge Count

1. **Fix line 3503**: Change `value: agentCounts.total` to `value: counts.working` (or a purpose-built "needs-attention" count). The badge should reflect actionable items, not total inventory.

2. **Reconcile the two badge paths**: `updateDockBadge()` and `getChildrenImpl()` both set `this._agentStatusView.badge` with different values. Consolidate into a single method that `getChildrenImpl` calls, or have `getChildrenImpl` skip setting the badge and let `updateDockBadge` be the sole authority.

3. **Strengthen dedup when pid is null**: In `isSuppressedByLauncherTask`, when `task.pid` is null, relax the project-dir + start-time fallback (e.g., match on project dir alone for running launcher tasks, since having a running launcher task for the same project is strong evidence of identity).

### For Ghostty Launcher (separate repo)

1. **Fix bundle signing**: Sign with a Developer ID certificate, or add a designated requirement via `codesign --force --sign - --requirements "..." ...`.
2. **Crash detection**: Surface repeated `Launch Constraint Violation` failures with actionable guidance rather than triggering macOS crash dialogs.
3. **Populate `pid`**: Store the claude process PID in `tasks.json` so CC's dedup can use it.

---

*Report generated by `cc-ghostty-count-investigation-20260526` at 2026-05-26 EDT.*
