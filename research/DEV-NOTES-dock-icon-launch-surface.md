# DEV NOTES: Dock Icon Launch Surface

## Implementation Summary
- Updated `src/ghostty/TerminalManager.ts` so `runInProjectTerminal()` now opens the project launch surface (`launcher <projectDir>`) after bundle creation when no tmux session exists.
- Added a dedicated `openProjectTerminal()` helper in `TerminalManager` and used it for:
  - no-session path: `createProjectTerminal()` then `openProjectTerminal()`
  - existing-session/no-command path: directly re-open/activate the project bundle launch surface
- Updated `commandCentral.launchAgent` in `src/extension.ts` to route through `terminalManager.runInProjectTerminal(...)` and removed `--no-bundle` direct spawning. This ensures first-time launches no longer depend on a pre-existing bundle and keep per-project Dock identity.
- Added focused test coverage for the new behavior:
  - `test/ghostty/terminal-manager.test.ts`
    - asserts bundle is opened after bundle creation in no-session path
    - asserts existing-session/no-command path opens bundle instead of rebuilding
    - asserts command path does create -> open -> steer sequence when session appears
  - `test/commands/launch-agent.test.ts`
    - asserts launch command is routed through `runInProjectTerminal`
    - asserts command string no longer includes `--no-bundle`
    - keeps backend/task-id behavior checks

## Tests Run
- `just format` (fails: recipe not defined in this repo)
- `just fix` (format/lint autofix path used by this repo)
- `bun test test/ghostty/terminal-manager.test.ts`
- `bun test test/commands/launch-agent.test.ts`
- `bun test test/ghostty/terminal-manager.test.ts test/commands/launch-agent.test.ts`
- `just check`

## Design Tradeoff
- Chosen approach: use launcher bundle mode (`launcher <projectDir>`) as the launch/activation path rather than AppleScript/open-only activation.
- Why: launcher invocation preserves project bundle identity and aligns with launcher-managed terminal/session wiring, while pure activation paths do not guarantee session establishment needed for reliable steering.

## Follow-ups
- Optional: if desired, tighten shell escaping in composed spawn command strings for unusual paths containing double quotes.
