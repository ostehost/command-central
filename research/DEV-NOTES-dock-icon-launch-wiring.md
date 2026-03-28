# Dock Icon Launch Wiring — DEV Notes

## What I changed

1. Added a new `ProjectIconManager` API:
   - `ensureProjectIconPersisted(projectDir: string): Promise<string>`
   - Behavior:
     - Reuses existing `commandCentral.project.icon` from `.vscode/settings.json` when configured.
     - Generates deterministic fallback icon when missing.
     - Awaits settings write so callers can guarantee persistence before proceeding.
     - Preserves malformed `settings.json` files (no clobber): write attempts are safely skipped when parsing fails.

2. Wired the guarantee into Ghostty bundle creation path:
   - `TerminalManager` now accepts an injected icon ensurer (`ProjectIconEnsurer`) with a default `ProjectIconManager`.
   - `createProjectTerminal()` now awaits `ensureProjectIconPersisted(workspaceRoot)` before invoking launcher `--create-bundle`.
   - This covers:
     - Direct command path (`commandCentral.ghostty.createTerminal` → `createProjectTerminal`)
     - Indirect project-terminal creation path (`runInProjectTerminal` when it needs to create a bundle).

3. Added focused tests:
   - `test/services/project-icon-manager.test.ts`
     - `ensureProjectIconPersisted` writes deterministic fallback immediately.
     - Existing configured icons are respected without rewriting file contents.
     - Malformed settings are not clobbered.
   - `test/ghostty/terminal-manager.test.ts`
     - Verifies `createProjectTerminal` ensures icon before `--create-bundle`.
     - Verifies `runInProjectTerminal` path ensures icon before `--create-bundle` when it creates a new project terminal.

## Tests run

- `bun test test/services/project-icon-manager.test.ts test/ghostty/terminal-manager.test.ts`
  - Result: pass (34 pass, 0 fail)

## Notes / follow-ups

- Repository does not provide `just format` or `bun run format`; used `just fix` (Biome auto-fix) instead before final test run.
- No launcher/discovery refactors were made; change kept scoped to icon guarantee + launch wiring + focused tests.
