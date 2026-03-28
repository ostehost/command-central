# DEV NOTES: prerelease gate v1

Date: 2026-03-28
Task ID: cc-prerelease-gate-v1

## What was implemented

1. Added a new cross-repo prerelease gate script:
   - `scripts-v2/prerelease-gate.ts`
   - Hard-fail checks included:
     - Command Central validation via `just verify`
     - Ghostty Launcher validation via `just check` in `~/projects/ghostty-launcher`
     - Cross-repo launcher contract checks:
       - launcher help must include: `--create-bundle`, `--parse-name`, `--parse-icon`, `--session-id`
       - Command Central source must reference `--session-id`
       - Command Central source must not reference legacy `--tmux-session`
       - launcher CLI sanity invocations for `--parse-name`, `--parse-icon`, `--session-id`
   - Provenance report output:
     - `research/prerelease-gate/latest.json`
     - `research/prerelease-gate/prerelease-gate-<timestamp>.json`
   - Report includes machine-readable SHAs for both repos:
     - Command Central `git rev-parse HEAD`
     - Ghostty Launcher `git rev-parse HEAD`

2. Added just workflows:
   - `just prerelease-gate` → runs the new hard gate
   - `just prerelease` → runs gate then `just dist --prerelease`

3. Replaced legacy launcher repo references in prerelease/release path touched:
   - `scripts-v2/sync-launcher.ts`
     - default source changed from `~/ghostty-dock-launcher-v1` + `ghostty`
     - to `~/projects/ghostty-launcher` + `launcher`
   - `justfile`
     - `_check-launcher-sync` now diffs against `~/projects/ghostty-launcher/launcher`
     - `ghostty` helper prefers `~/projects/ghostty-launcher/launcher`
   - `docs/releasing/CHECKLIST.md`
     - launcher diff path updated to active repo/binary

4. Updated release docs for implemented workflow only:
   - `docs/releasing/PROCESS.md`
     - adds `just prerelease` / `just prerelease-gate`
     - corrects `dist` behavior description (no claim that `dist` runs validation)
     - documents gate checks and provenance artifact paths

5. Added focused tests for new contract logic:
   - `test/scripts-v2/prerelease-gate.test.ts`
   - Covers:
     - help-flag extraction
     - session-flag extraction from TerminalManager source
     - contract pass/fail behavior for session flag drift and missing launcher flags

## Validation and tests run

1. `just format` (fails in this repo because no `format` recipe)
2. `just fix` (successful; pre-existing warnings in unrelated tests remain)
3. `bun test test/scripts-v2/prerelease-gate.test.ts` (pass)
4. `just prerelease-gate` (fails as designed because ghostty-launcher `just check` currently fails in its own environment-dependent test)
5. `just prerelease-gate --skip-launcher-validation` (pass; validates CC + contract + provenance generation path)

## Exact remaining gaps

1. Full gate currently blocked by upstream launcher check instability in local environment:
   - `~/projects/ghostty-launcher` `just check` failure observed in `test/test-codesign-ordering.sh` with spotlighterror/codesign scan failure.
   - This is an external repo validation failure, not a Command Central gate logic bug.

2. Host-level VS Code Extension Host E2E prerelease harness remains intentionally out of scope for v1 (per task instruction).

3. Gate currently supports skip flags for troubleshooting (`--skip-cc-validation`, `--skip-launcher-validation`); release workflow should keep default strict mode for partner artifacts.
