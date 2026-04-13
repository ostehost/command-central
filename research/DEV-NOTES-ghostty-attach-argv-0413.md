# DEV-NOTES: Ghostty Native tmux-attach argv Fix

**Date:** 2026-04-13
**Branch:** `ghostty-attach-argv-0413`

## Problem

Clicking a running tmux-only task in Agent Status opened a native Ghostty
window that immediately failed with "No such file or directory."

The Ghostty window was launched via:

```
open -a Ghostty --args -e <single-shell-quoted-blob>
```

where `<single-shell-quoted-blob>` was the entire tmux attach command
shell-quoted and joined into one string:

```
'tmux' '-f' '/path/conf' '-S' '/path/sock' 'attach' '-t' 'session-id'
```

Ghostty's `-e` flag expects **argv-style command parts** — each word as a
separate argument. Receiving the whole thing as one string, Ghostty tried to
`execvp` a binary literally named the entire blob, which doesn't exist.

## Root Cause

`buildTaskTmuxAttachCommand()` in `src/commands/task-terminal-routing.ts`
returned a `string` (shell-quoted, space-joined) instead of a `string[]`
(argv array). The call site in `src/extension.ts` passed this single string
as one argument after `-e`, so `open(1)` delivered it to Ghostty as one arg.

## Fix

1. **`src/commands/task-terminal-routing.ts`** — Changed
   `buildTaskTmuxAttachCommand()` return type from `string` to `string[]`.
   Removed the `.map(shellQuote).join(" ")` — now returns raw argv parts.
   Removed the now-unused `shellQuote` import.

2. **`src/extension.ts`** — Spread the returned array into the `open` args:
   ```ts
   await execFileAsync("open", [
       "-a", "Ghostty", "--args", "-e",
       ...buildTaskTmuxAttachCommand(task),
   ]);
   ```
   Each tmux arg is now a separate element in the argv passed to Ghostty.

3. **`test/commands/task-terminal-routing.test.ts`** — Updated existing test
   to expect an array. Added two new tests:
   - Minimal task (no conf/socket) produces correct argv.
   - Full integration-style test showing how argv spreads into the `open`
     call matches the expected Ghostty invocation.

## What Was NOT Changed

- Bundle-based focus paths (unaffected — they don't use this function).
- tmux session liveness checks (the `has-session` call uses
  `buildTaskTmuxArgs` directly, which was already correct).
- `buildTaskTmuxArgs()` helper (already returned `string[]`).
- Shell-quoting utilities in `src/utils/shell-command.ts` (still used
  elsewhere; just no longer needed by this function).

## Verification

- `bunx tsc --noEmit` passes.
- All 7 task-terminal-routing tests pass (including 2 new ones).
- Full test suite: no new failures introduced.
