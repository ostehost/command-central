# Command Central rc55 dogfood preview — 2026-06-11

## Verdict

`0.6.0-rc.55` was cut locally as a dogfood candidate after CC-001 health-status fixes and CC-002 badge/grouping fixes were merged into `main`.

This is **not** a public release. No push, tag, Marketplace publish, GitHub release, or external distribution action was performed.

## Included dogfood fixes

- CC-001 / PAR-38: OpenClaw health status no longer collapses degraded/stale/task-service-alive states into misleading red `OpenClaw DOWN`.
- CC-001 follow-up: infrastructure health refreshes immediately when agent-status tree data changes, reducing the transient mismatch window.
- CC-002: Activity Bar badge count uses active work only and avoids double-counting Symphony + Agent Status surfaces.
- CC-002 follow-up: Command Central detached worktrees canonicalize/group under `COMMAND CENTRAL` instead of path-derived worktree names.

## Artifact

- Version: `0.6.0-rc.55`
- VSIX: `releases/command-central-0.6.0-rc.55.vsix`
- SHA-256: `c8b7503845d9c06cbad095d6c6ebb8db791abae2a4b27261fe9d351405ce5783`
- Size: `269317` bytes (`263.0 KB` reported by dist)
- VSIX content gate: passed
  - compressed: `269317` bytes / budget `600000`
  - uncompressed: `891518` bytes / budget `2000000`
  - files: `52` / budget `120`
  - forbidden artifacts: none

## Gates run

- Focused CC-001/CC-002 tests: passed
  - `bun test test/services/infrastructure-health-status-bar.test.ts test/services/agent-status-bar.test.ts test/tree-view/agent-status-activity-badge.test.ts`
- `just check`: passed
- `just test-electron`: passed
- `just test`: passed
- `just cut-preview --prerelease`: passed
- Installed consumption proof: passed
  - `bun run scripts-v2/verify-vscode-extension-consumption.ts --vsix releases/command-central-0.6.0-rc.55.vsix --expected-version 0.6.0-rc.55 --manifest-out research/vscode-consumption-rc55-20260611.json`
  - `installedVersionFromCode`: `0.6.0-rc.55`
  - installed package version: `0.6.0-rc.55`
- Installed VSIX Agent Status proof: passed
  - `just test-installed-vsix-agent-status`
  - manifest: `logs/installed-vsix-agent-status-proof-1781200229665.json`
  - observed version: `0.6.0-rc.55`

## Notes / risks

- The first bare `just verify-vscode-consumption` invocation failed because the recipe requires explicit `--vsix` arguments. The direct script invocation with the rc55 VSIX and expected version passed and wrote the rc55 manifest.
- VS Code reported the extension host briefly unresponsive during installed-agent-status proof, then recovered and the test exited 0. Keep an eye on activation/performance during dogfood.
- rc55 is installed locally and requires `Developer: Reload Window` in VS Code to activate in the normal profile.

## Next step

Dogfood rc55 locally. If the UI is now truthful under live agent activity, the next approval decision is whether to push commits and later tag/publish. Public publish remains a separate approval gate.
