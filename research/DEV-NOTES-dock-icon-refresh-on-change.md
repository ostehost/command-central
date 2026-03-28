# DEV NOTES: Dock Icon Refresh On Change

## Implementation Summary
- Updated `commandCentral.changeProjectIcon` in `src/extension.ts` to perform a best-effort Ghostty bundle refresh immediately after the icon setting is persisted.
- Added `src/ghostty/project-icon-bundle-refresh.ts` with `refreshGhosttyBundleAfterProjectIconChange(...)` to centralize safety behavior:
  - If launcher is unavailable: keep the icon setting, log warning, show user warning that bundle icon was not refreshed.
  - If bundle refresh fails: keep the icon setting, log warning with error detail, show user warning.
  - If available: refresh via `TerminalManager.createProjectTerminal(projectDir)` which runs launcher `--create-bundle` and rebuilds the `.app` identity/icon.
- Scope was kept tight to icon-change flow and refresh safety only.

## Tests Added
- `test/ghostty/project-icon-bundle-refresh.test.ts`
  - no-op when terminal manager is unavailable
  - launcher unavailable path warns and skips refresh
  - refresh failure path warns but does not throw
  - successful refresh path calls bundle creation and does not warn

## Tests / Validation Run
- `bun test test/ghostty/project-icon-bundle-refresh.test.ts`
- `bun test`
- `just fix`
- `just check`

## Notes
- `just format` is not defined in this repo’s current `justfile`; `just fix` is the available formatting/lint auto-fix command and was run instead.

## Remaining Follow-ups
- Optional UX improvement: show a positive status message when icon refresh succeeds (currently only warning paths are surfaced).
