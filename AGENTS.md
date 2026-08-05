# Command Central Agent Policy

Command Central is a Bun-based VS Code extension for observing and controlling
coding-agent workflows. Root `AGENTS.md` is the only always-on project policy
body. `CLAUDE.md` is a thin `@AGENTS.md` adapter. `.agents/rules/project.md`
symlinks here for workspace discovery.

Product and historical assistant depth that used to live in root `CLAUDE.md` is
preserved in `docs/historical-claude-policy.md` (not auto-loaded).

## Commands

Fleet local-eight (`config/WORKFLOW.md`). Prefer `just <recipe>`; inspect
`just --list` before ops recipes.

- `just install` — synchronize Bun dependencies from `bun.lock`
- `just format` / `just format --check` — write or verify Biome formatting
- `just lint` — Biome lint plus TypeScript
- `just test` — deterministic test suite
- `just check` — fast static validation; excludes tests
- `just ci` — strict check plus tests (Knip failures block)
- `just clean` — remove declared build/package artifacts
- `just info` — argument-free project metadata; `just package-info <name>` for package details

Legacy helpers (`fix`, `ready` / `r`, short aliases) remain but do not replace
the local eight and do not imply the retired five-entrypoint contract. There is
no fleet-standard `verify` recipe. This is not Universal 8 adoption.

Common project ops (see justfile): `just dev`, `just dist`, preview/prerelease
gates, launcher sync. Prefer documented just recipes over ad-hoc bun/vsce.

## Non-negotiable product rules

1. Always use `--extensionDevelopmentPath` — never symlink/copy into
   `~/.vscode/extensions/`.
2. Bun exclusively — no npm/yarn/webpack lockfiles or toolchains.
3. Package as VSIX via the documented just/vsce path.
4. Never bundle the `vscode` module — keep it external.
5. Never skip typechecking before build.
6. Never use `--no-verify` on commit/push; fix hook failures.

## Cross-repo: Ghostty Launcher

Preview/release paths depend on sibling `ghostty-launcher` for lane
orchestration and `resources/bin/` launcher assets. If a CC preview/release
gate is blocked by a launcher defect, treat unblocking as owned release-path
work only when the operator authorized that cross-repo scope: smallest safe
launcher fix, launcher validation, then return here. Do not push, tag, or
publish either repo without explicit approval.

## Invariants

- Current registry/runtime behavior is defined by `package.json` and
  implementation, not stale README prose. Legacy launcher task inputs require
  `commandCentral.legacyLauncherTasks.enabled`.
- Do not edit or commit in `ghostty-launcher` or other siblings unless the user
  explicitly authorizes that cross-repository scope.
- Preserve pre-existing dirt; stage only owned paths; never `git add .`.
- Never bypass hooks or publish a VSIX/release without explicit authorization.

Run focused tests, then `just ci`. Do not commit or push unless explicitly asked.
