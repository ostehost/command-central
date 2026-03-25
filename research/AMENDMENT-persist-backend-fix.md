CLEAR
# CRITICAL AMENDMENT: Persist Backend Session Check

## The Real Bug

The focus guard at `src/extension.ts` ~line 727 checks `tmux has-session` to determine if an agent's terminal is alive. **But the default terminal backend is `persist` (Unix domain socket), NOT tmux.** For persist-backed agents, `tmux has-session` always fails, causing the code to wrongly declare the session dead.

The persist socket path pattern is: `~/.local/share/cc/sockets/{session_id}.sock`

## Fix Required

Replace the tmux-only check with a multi-backend session check:

```typescript
// Guard: for completed/stopped/failed tasks, check if session is alive
if (
  task &&
  task.status !== "running" &&
  sessionId &&
  isValidSessionId(sessionId)
) {
  let sessionAlive = false;
  
  // Check 1: persist socket (default backend)
  if (!sessionAlive) {
    try {
      const os = await import("node:os");
      const persistSocketPath = path.join(
        os.homedir(),
        ".local",
        "share",
        "cc",
        "sockets",
        `${sessionId}.sock`,
      );
      const fsModule = await import("node:fs");
      if (fsModule.existsSync(persistSocketPath)) {
        sessionAlive = true;
      }
    } catch {
      // ignore
    }
  }
  
  // Check 2: tmux session (fallback backend)
  if (!sessionAlive) {
    try {
      await execFileAsync("tmux", ["has-session", "-t", sessionId]);
      sessionAlive = true;
    } catch {
      // neither persist nor tmux alive
    }
  }
  
  if (!sessionAlive) {
    // Session truly dead — show diff (not toast!)
    // [existing dead-session handler, but with status bar msg instead of toast]
  }
  // else: fall through to normal focus strategies
}
```

## Also Important

The `SessionStore` (session-store.ts) already maps project dirs to Ghostty bundle paths. **Strategy 0** (line ~764) already tries to `open -a` the bundle. The fix above ensures we reach Strategy 0 for persist-backed agents instead of short-circuiting into the dead-session toast.

## What This Enables

With this fix:
1. **Persist-backed completed agents** → click in sidebar → opens the Ghostty bundle → shows the terminal with full scrollback history
2. **Tmux-backed completed agents** → click → reattaches to tmux session (same as before, when it works)
3. **Truly dead sessions (no socket, no tmux)** → show diff viewer + brief status bar message (not toast)

This is the persistence Mike wants — completed agent terminals stay alive and reattachable. The launcher already keeps Ghostty bundles running after completion. CC just needs to stop wrongly declaring them dead.
