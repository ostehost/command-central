# DEV NOTES: Dock Icon Shell Escaping

## Summary
Implemented a targeted shell-escaping hardening for Dock-icon project-terminal launch paths that inject `oste-spawn.sh` commands into project terminals.

Changes made:
- Added a new helper module: `src/utils/shell-command.ts`
  - `shellQuote(argument)` for POSIX-safe single-quote argument escaping
  - `joinShellArgs(parts)` to assemble argv-style lists into a shell command string
  - `buildOsteSpawnCommand(options)` to build `oste-spawn.sh` launch commands safely
- Updated `src/extension.ts` to use `buildOsteSpawnCommand(...)` in both affected launch paths:
  - `commandCentral.launchAgent`
  - `commandCentral.restartAgent`

This removes brittle ad hoc interpolation like:
- `oste-spawn.sh "${projectDir}" ...`
and replaces it with centrally escaped command construction.

## Regression Tests
Added focused tests:
- `test/utils/shell-command.test.ts`
  - validates shell quoting behavior
  - validates spawn command construction
  - includes spaces + embedded double-quote cases
- `test/commands/launch-agent.test.ts`
  - updated to use the shared command builder in the command simulation
  - added regression case for workspace-derived values with spaces + embedded double quotes

## Commands Run
- `just fix`
- `bun test test/utils/shell-command.test.ts test/commands/launch-agent.test.ts`

## Remaining Follow-ups
- Optional: migrate other `runInProjectTerminal(..., "raw shell text")` call sites to the shared helper when they start injecting non-static/user-derived values.
