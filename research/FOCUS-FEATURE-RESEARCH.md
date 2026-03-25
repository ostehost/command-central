CLEAR
# Research: Agent Terminal Focus — The Right Way

> Date: 2026-03-23
> Status: RESEARCH COMPLETE

## Q1: How Does Ghostty Handle Window/Tab Activation?

### Current Usage

The codebase uses `open -a <bundle_id>` to activate Ghostty — **no AppleScript/osascript** is used anywhere in the focus flow.

**Strategy 1** (`src/extension.ts:718`):
```ts
await execFileAsync("open", ["-a", task.ghostty_bundle_id]);
```

**Strategy 3** (`src/extension.ts:773`) — tmux-only fallback:
```ts
await execFileAsync("open", ["-a", "Ghostty", "--args", "-e", `tmux attach -t ${task.session_id}`]);
```

### Behavior

- `open -a <bundle_id>` brings the **entire Ghostty application instance** to the foreground
- It does NOT target a specific window or tab within that instance
- After `open -a`, a `tmux select-window -t <session_id>` is attempted (lines 722–729, 748–756), but this only affects tmux state — not which Ghostty window/tab is visible
- No `osascript -e 'tell application id "..." to activate'` is used
- No Accessibility APIs are used

### Key Limitation

`open -a` activates the whole Ghostty app, but doesn't guarantee the correct window/tab is displayed. The `tmux select-window` only affects which tmux window is active inside tmux — it doesn't control which Ghostty window or tab the user sees.

---

## Q2: What's in the Ghostty Terminal Map?

### File: `/tmp/ghostty-terminals.json`

```json
{
  "agent-command-central-planner": {
    "terminal_id": "4BBEDDCB-FF3F-4797-B3EE-277FA68B496F",
    "window_id": "tab-group-c885ffb60",
    "bundle_id": "dev.partnerai.ghostty.command-central"
  }
}
```

### Structure

Maps **tmux session name** → `{ terminal_id, window_id, bundle_id }`:

| Field | Example | Purpose |
|-------|---------|---------|
| `terminal_id` | `4BBEDDCB-FF3F-4797-B3EE-277FA68B496F` | Ghostty-internal terminal instance UUID |
| `window_id` | `tab-group-c885ffb60` | Ghostty internal window/tab group ID |
| `bundle_id` | `dev.partnerai.ghostty.command-central` | Ghostty instance bundle ID |

### Usage

- The extension does **NOT** read `/tmp/ghostty-terminals.json` directly
- It relies on `AgentTask.ghostty_bundle_id` stored in the task registry
- The `window_id` and `terminal_id` fields could enable **true window targeting** via AppleScript or Ghostty IPC, but this data is currently unused
- The map likely persists after agent completion until explicitly cleaned up by the launcher

---

## Q3: Full `focusAgentTerminal` Flow

**Source:** `src/extension.ts:683–790`

### Flow Diagram

```
commandCentral.focusAgentTerminal(node?)
│
├── GUARD: if !task → show "No terminal available" + return
│
├── telemetry.track("cc_agent_focused")
│
├── STALE GUARD (M1-9, lines 699–713):
│     if task.session_id && isValidSessionId(session_id)
│       └── tmux has-session -t session_id
│             └── THROWS → "Agent session X has ended." → return  ← HARD STOP
│
├── STRATEGY 1 (lines 715–735): terminal_backend === "tmux" && ghostty_bundle_id
│     ├── open -a <ghostty_bundle_id>
│     ├── if session_id valid → tmux select-window -t <session_id> (swallows errors)
│     └── return
│
├── STRATEGY 2 (lines 737–764): bundle_path exists and not "(test-mode)"/"(tmux-mode)"
│     ├── fs.existsSync(bundle_path) check
│     ├── open -a <bundle_path>
│     ├── if session_id valid → tmux select-window -t <session_id> (swallows errors)
│     └── return
│
├── STRATEGY 3 (lines 766–784): terminal_backend === "tmux" && session_id valid
│     ├── open -a Ghostty --args -e "tmux attach -t SESSION"
│     └── return
│
└── FALLBACK: show "No terminal available for this agent."
```

### Where "has ended" Comes From

**Lines 708–712** — the stale session guard:
```typescript
if (task.session_id && isValidSessionId(task.session_id)) {
    try {
        await execFileAsync("tmux", ["has-session", "-t", task.session_id]);
    } catch {
        vscode.window.showInformationMessage(
            `Agent session "${task.id}" has ended. Terminal is no longer available.`
        );
        return;  // HARD STOP
    }
}
```

This runs **before all strategies**. If tmux session is dead, nothing else executes.

### `isValidSessionId`

**`src/providers/agent-status-tree-provider.ts:22–23`:**
```typescript
export function isValidSessionId(name: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(name);
}
```
Shell-injection safety check only — not a live-session check.

### Relevant `AgentTask` Fields

**`src/providers/agent-status-tree-provider.ts:38–57`:**
- `session_id: string` — tmux session name
- `terminal_backend?: "tmux" | "applescript"`
- `ghostty_bundle_id?: string | null` — bundle ID of specific Ghostty instance
- `bundle_path: string` — path to .app; `"(tmux-mode)"` for tmux-only, `"(test-mode)"` for test

---

## Q4: State Matrix — Current vs Desired Behavior

| Agent State | Has Bundle ID | Has tmux | Current Behavior | Desired Behavior | Gap? |
|-------------|--------------|----------|------------------|------------------|------|
| Running | Yes | Yes | Guard passes → Strategy 1 → `open -a <bundle_id>` | Activate Ghostty window | None |
| Running | No | Yes | Guard passes → Strategy 3 → `tmux attach` in new Ghostty | Attach to tmux | None |
| Completed | Yes | Dead | **Guard BLOCKS** → "has ended" message | Activate Ghostty window (scrollback visible) | **BUG** |
| Completed | No | No | Guard passes (no session_id) → falls to fallback message | Show "no terminal" | None |
| Error | Yes | Maybe dead | **Guard BLOCKS** if tmux dead | Activate Ghostty window | **BUG** |

**The two broken cases** are both completed/error agents that have a `ghostty_bundle_id` but whose tmux session has ended. The guard prevents Strategy 1 from ever executing.

---

## Q5: The Stale Session Guard — Root Cause Analysis

### The Guard (M1-9)

**`src/extension.ts:699–713`:**
```typescript
// Guard (M1-9): check if tmux session is still alive before attempting to open
if (task.session_id && isValidSessionId(task.session_id)) {
    try {
        await execFileAsync("tmux", ["has-session", "-t", task.session_id]);
    } catch {
        vscode.window.showInformationMessage(
            `Agent session "${task.id}" has ended. Terminal is no longer available.`
        );
        return;   // ← unconditional early return
    }
}
```

### Is It Blocking Completed Agents?

**Yes, definitively.** The guard:
1. Checks if `session_id` exists and passes regex → runs `tmux has-session`
2. If tmux session is dead → shows "Terminal no longer available" → **hard return**
3. Strategy 1 (`open -a <bundle_id>`) is never reached

### Why It Was Added

M1-9 added the guard to prevent `tmux attach -t <dead-session>` from failing noisily (Strategy 3). This was correct for Strategy 3.

### Why It's Wrong

The guard is placed **before all strategies**. Strategy 1 (`open -a <bundle_id>`) and Strategy 2 (`open -a <bundle_path>`) don't need tmux to be alive — they just bring the Ghostty window to front. The guard should only protect Strategy 3.

### Recommended Fix

Move the `tmux has-session` check to wrap **only Strategy 3**, not the entire function. Strategies 1 and 2 should execute regardless of tmux session state.

---

## Q6: Launcher Completion Chain — Terminal State After Agent Completion

### Completion Chain

```
TaskCompleted hook / oste-done.sh → oste-complete.sh → oste-notify.sh → /hooks/wake → Oste wakes
```

### What `oste-complete.sh` Does

1. **Does NOT kill the tmux session** — no `tmux kill-session` or `tmux kill-window` call anywhere
2. **Renames the tmux window** with emoji (lines 349–380):
   ```bash
   tmux rename-window -t "${task_session}:${window_index}" "${current_title} ${status_emoji}"
   ```
3. Writes `/tmp/oste-complete-<task_id>` marker file
4. Updates `tasks.json` with `status=completed|failed`
5. Fires `oste-notify.sh`
6. Writes pending-review file

### What `oste-notify.sh` Does

**Nothing destructive.** Only:
- Appends to `~/.openclaw/workspace/notifications.jsonl`
- Sends macOS notification via `notify_macos`
- POSTs to `/hooks/wake`
- Sends Discord message

### Terminal State After Completion by Spawn Mode

| Spawn Mode | tmux Alive? | Ghostty Window Alive? | Can Strategy 1 Refocus? |
|---|---|---|---|
| Bundle (no AppleScript) | N/A | May close when process exits | Yes, if Ghostty app still running |
| AppleScript tab (`exec $SHELL` at line 1282) | N/A | **YES** — drops to interactive shell | Yes |
| tmux-only (`--tmux`) | **NO** — exits when agent done | Depends on user attachment | Guard blocks Strategy 1 |

### Key Finding

For **tmux-only agents**: after the agent command completes, `oste-complete.sh` runs and exits. The shell then exits, and the tmux session ends (tmux default: session ends when last pane's process exits). No `exec ${SHELL}` is appended in the tmux path (only in AppleScript at line 1282). The Ghostty window that was attached to it **may still be visible** with scrollback, but the extension's stale guard prevents refocusing it.

---

## Recommended Implementation Plan

### Core Fix: Move the Stale Guard

**File:** `src/extension.ts`
**Lines:** 699–713

**Current:** Guard runs before all strategies (hard stop on dead tmux).

**Proposed:** Remove the guard from its current position. Add tmux-alive check only where it's needed:

1. **Strategy 1** (line 715–735): No guard needed. `open -a <bundle_id>` works regardless of tmux. Keep the `tmux select-window` call but swallow errors (already done).

2. **Strategy 2** (line 737–764): No guard needed. `open -a <bundle_path>` works regardless of tmux. Keep the `tmux select-window` call but swallow errors (already done).

3. **Strategy 3** (line 766–784): Add `tmux has-session` check HERE, before `tmux attach`. This is the only strategy that genuinely requires a live tmux session. If dead, fall through to fallback message.

### Specific Changes

```diff
- // Guard (M1-9): check if tmux session is still alive
- if (task.session_id && isValidSessionId(task.session_id)) {
-     try {
-         await execFileAsync("tmux", ["has-session", "-t", task.session_id]);
-     } catch {
-         vscode.window.showInformationMessage(
-             `Agent session "${task.id}" has ended. Terminal is no longer available.`
-         );
-         return;
-     }
- }

  // Strategy 1: tmux backend + ghostty_bundle_id (unchanged)
  // Strategy 2: bundle_path (unchanged)

  // Strategy 3: tmux-only fallback
  if (task.terminal_backend === "tmux" && task.session_id && isValidSessionId(task.session_id)) {
+     try {
+         await execFileAsync("tmux", ["has-session", "-t", task.session_id]);
+     } catch {
+         // tmux session is dead — can't attach. Fall through to fallback.
+     }
      // ... existing tmux attach logic, but only if has-session succeeded
  }
```

### Edge Cases & Gotchas

1. **Ghostty window may have been closed by user:** `open -a <bundle_id>` will relaunch Ghostty, but it won't have the terminal scrollback. This is acceptable — it's the same behavior as clicking the dock icon.

2. **Multiple Ghostty windows:** `open -a <bundle_id>` brings the whole app to front, not a specific window. For better targeting, the `window_id` from `/tmp/ghostty-terminals.json` could be used with AppleScript in a future enhancement.

3. **tmux-only agents with no Ghostty bundle:** After tmux dies, there's genuinely no terminal to show. The fallback message is correct here.

4. **Race condition:** Agent is completing while user clicks focus. The `tmux select-window` in Strategy 1 already swallows errors, so this is safe.

5. **Test updates needed:** `test/commands/extension-commands.test.ts` likely has tests for the stale guard behavior. These need updating to reflect the new guard position.

### Files to Modify

| File | Change |
|------|--------|
| `src/extension.ts:699–784` | Move stale guard from pre-strategy to wrap only Strategy 3 |
| `test/commands/extension-commands.test.ts` | Update focus tests to verify completed agents with bundle_id can be focused |

---

SPEC COMPLETE
