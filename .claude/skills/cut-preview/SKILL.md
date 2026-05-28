---
name: cut-preview
description: Cut a preview VSIX release (e.g. 0.6.0-rc.N) for command-central. Invoke on "cut a preview", "ship the next RC", "release the next preview", "build the prerelease". Wraps `just cut-preview` with cross-repo coordination and a clean handoff.
---

# Cut Preview — command-central

Single entry: `just cut-preview`. Skill's job is to check preconditions, invoke the recipe, interpret failures, proactively clear direct Ghostty Launcher release blockers, and hand off a verified preview artifact.

## When to invoke

Phrases: "cut a preview", "cut an RC", "release the next preview", "build the prerelease".

Skip for: stable GA (different policy — CHANGELOG required), dev builds (`just dist --current --no-install`).

## Master command

```bash
just cut-preview
```

Composes: `_preview-preflight` → `sync-launcher` → `_preview-rehearsal` (`just ci`) → `prerelease` (`prerelease-gate` → `dist --prerelease`). Prints handoff checklist.

## Preconditions (hard)

- `cwd = ~/projects/command-central`
- `~/projects/ghostty-launcher` exists with a clean tree on a committed HEAD
- command-central tree clean, EXCEPT the release-churn allowlist:
  - `resources/bin/ghostty-launcher`, `resources/bin/.launcher-version`
  - `resources/app/.terminal-version`
  - `package.json`, `releases/**`, `research/prerelease-gate/**`
- Hub machine (`whoami == ostehost`) — warning, not block, if off-hub

If the Command Central tree is dirty outside the release allowlist: STOP and report. If the Ghostty Launcher tree is dirty or failing because of work that directly blocks this preview/release path, cross into `~/projects/ghostty-launcher`, inspect, make the smallest safe fix, validate, write a handoff, commit the launcher fix, then return and rerun `just cut-preview`.

## Happy path

1. Run `just cut-preview`. ~15–20s on hub.
2. On success, dist prints VSIX + digest paths and installs to VS Code.
3. Tell user to `Cmd+Shift+P → Developer: Reload Window` and smoke-test:
   - Agent Status sidebar renders project → status → time sub-groups
   - Toolbar `Clear Completed Agents` + `Reap Stale Agents` work
   - Right-click stale → `Mark as Failed` persists
   - `Focus Terminal` routes to the exact tmux pane
   - Output channel: no activation errors
4. Hand off: show `git status`. In release-prep lanes, commit the focused release metadata/artifacts after gates pass. Do not push, tag, publish, or use `--no-verify`.

## Failure paths

**CC dirty outside allowlist**
STOP. Ask user to commit or separate unrelated Command Central work. Do not stash/reset/clean. First-run paradox: scaffolding that adds `cut-preview` is itself NOT on the allowlist; commit `justfile` / `.claude/` edits before the skill can guard itself.

**Launcher dirty / launcher gate blocker**
Do not stop at “launcher dirty” when the launcher work is a direct Command Central release dependency. Inspect `~/projects/ghostty-launcher`, fix narrowly, run `just check` plus targeted tests when relevant, write a `research/HANDOFF-*.md`, commit the launcher fix, then rerun `just cut-preview`. If the dirty launcher files are clearly unrelated user work, report the exact files and stop rather than overwriting them.

**`just ci` fails (rehearsal or gate)**
Fix upstream. Do NOT silence knip, skip tests, or use `--no-verify`. Biome: `just fix`. tsc/knip/tests: real bugs.

**Gate fails in launcher `just check`**
Read `research/prerelease-gate/latest.json` `output` field. Most common: shfmt drift → user runs `just fix` in launcher, commits, then re-sync here. Contract violations (CLI flags, `oste-steer.sh`) → cross-repo coordination.

## Never do

- `git push`, tags, Marketplace publish, or external release actions without explicit approval.
- Broad rewrites in the launcher repo. Prefer narrow edits and targeted formatting; use `just fix` only when the diff is understood.
- Update `CHANGELOG.md` for a preview — the digest is the record. CHANGELOG is curated for stable GA.
- Run on node (`ostemini`) — hub only, per `machines_hub_vs_node` memory.

## Key gotchas

- **`sync-launcher` mirrors the launcher plus helper scripts** from `~/projects/ghostty-launcher/scripts/` into `resources/bin/scripts/`. If a launcher fix touches helper shells, verify the matching `resources/bin/scripts/**` diff is present before committing the preview metadata.
- **Preflight first-run paradox**: the scaffolding that adds `cut-preview` isn't on the allowlist. User must commit the skill/justfile first, then cut.
- **VSIX files are `.gitignore`'d** (`*.vsix`). `git status` after a cut won't list them — the digest `releases/digest-v<v>.md` is the tracked record.

## Reference files

- `justfile` L528–589 — `cut-preview`, `_preview-preflight`, `_preview-rehearsal`
- `scripts-v2/prerelease-gate.ts` — cross-repo gate
- `scripts-v2/dist-simple.ts` — version bump + VSIX build
- `scripts-v2/sync-launcher.ts` — canonical launcher pull
- `research/prerelease-gate/latest.json` — last gate record (read on failure)
