# DEV-NOTES: Dead-Session Interactive Resume POC

**Date**: 2026-04-13
**Branch**: `resume-poc-0413`
**Task**: `cc-dead-session-resume-poc-0413b`

## Summary

Implemented and proved the dead-session interactive resume flow in Command Central.
The key scenario: a concierge launcher task (e.g. `agent-concierge-midnight-elite`)
finishes or dies, and the user wants to reopen the project launcher and start a new
interactive resume.

## What Changed

### 1. `src/commands/resume-session.ts` — Bundle availability helpers

Added two new exported functions:

- **`resolveProjectBundlePath(task)`** — Derives the expected `.app` bundle path from
  a task. Checks in order: (a) explicit `bundle_path` on the task if it's a real `.app`
  that exists on disk, (b) convention path `/Applications/Projects/<basename>.app`.
  Returns the path or `null`.

- **`isProjectBundleAvailable(task)`** — Boolean wrapper. Used by the dead-session
  fallback to decide whether "Open Project Launcher" should appear in the QuickPick.

### 2. `src/extension.ts` — Enhanced dead-session fallback in `focusAgentTerminal`

**Before**: When a tmux session was dead, the handler silently opened the transcript
or project launcher with no choice.

**After**: A QuickPick appears with up to 4 contextual options:
1. **Resume in Interactive Mode** — builds the backend-specific resume command
   (e.g. `claude --resume <id>`) and sends it to the project terminal
2. **View Session Transcript** — opens the transcript/stream file in the editor
3. **Open Project Launcher** — activates the launcher bundle without a command
4. **View Diff** — shows the git diff for the task's changes

Options are only shown when they're actually available (e.g., "Resume" only for
non-ACP backends, "Open Project Launcher" only when the `.app` exists on disk).

### 3. `src/extension.ts` — Improved `runResumeInTaskTerminal` messaging

The warning message when a session is dead now distinguishes between:
- **Bundle exists**: "Opening command-central.app and starting a new interactive resume."
- **No bundle**: "Starting interactive resume in a new terminal."

### 4. `src/extension.ts` — Enhanced `resumeAgentSession` QuickPick

The "Resume in Interactive Mode" description now shows the actual terminal target
(e.g. "Run `claude --resume` in command-central.app") and correctly distinguishes
between steering into a live session vs. opening a new terminal.

### 5. Tests

- **`test/commands/resume-session.test.ts`** — 12 new tests covering:
  - `resolveProjectBundlePath` with explicit paths, sentinel values, missing paths,
    and conventional paths
  - Dead-session resume decision logic for all backends and statuses (completed,
    failed, completed_stale, completed_dirty, ACP, codex, gemini, unknown)

- **`test/integration/agent-notification-ux.test.ts`** — 4 new tests covering:
  - Dead tmux session with resumable task shows QuickPick (not toast)
  - Bundle name appears in warning message when bundle exists
  - Generic message when no bundle exists
  - ACP tasks don't offer resume option

## What Now Works

1. **"Task session X is no longer live"** → User gets a QuickPick with actionable
   options instead of being silently dumped into a transcript or launcher.

2. **Resume in Interactive Mode** → Builds the correct resume command for the backend
   and routes it through the project's launcher terminal (or integrated terminal
   fallback). Works for claude, codex, gemini backends.

3. **Project bundle detection** → The system now checks whether the `.app` bundle
   actually exists at the expected path before offering "Open Project Launcher".

4. **Contextual messaging** → Warning messages now tell the user *what* terminal
   they're being sent to (bundle name or "new terminal").

## What Still Doesn't Work / Limitations

1. **Automatic resume on dead-session click** — The flow requires user choice via
   QuickPick. Fully automatic "detect dead + resume" would need confidence that the
   user always wants resume (vs. transcript or diff). Currently, this is a deliberate
   design choice — the QuickPick is one click.

2. **ACP tasks** — ACP sessions have no interactive resume path. This is a backend
   limitation, not a Command Central limitation.

3. **Launcher binary absence** — If the ghostty-launcher binary is not installed,
   the flow falls back to VS Code's integrated terminal. The resume command still
   runs, but it won't open the project's Ghostty bundle.

4. **tmux session resurrection** — If the tmux session died completely (not just
   disconnected), `claude --resume <id>` creates a new session. The old terminal
   output is not recovered — only the Claude conversation state is resumed.

5. **Bundle path detection** — Convention-based detection (`/Applications/Projects/
   <basename>.app`) works for standard launcher setups. Non-standard bundle locations
   require the task to carry an explicit `bundle_path`.

## Concierge POC Implications

This is the critical path for concierge dogfooding:
- Concierge launchers in `/Applications/Projects/` are preserved (no deletions).
- When a concierge agent session dies, the user can resume interactively with one
  QuickPick selection.
- The flow correctly identifies the project launcher bundle and routes the resume
  command through it.
- For the specific scenario "Task session agent-concierge-midnight-elite is no longer
  live", the user now sees a clean QuickPick instead of a confusing silent redirect.

## Verification

- `bunx tsc --noEmit` — clean
- `bun test test/commands/ test/integration/agent-notification-ux.test.ts` — 153 pass, 0 fail
- Biome check — clean on all changed files
