---
name: cut-preview
description: Cut a preview VSIX release (e.g. 0.6.0-rc.N) for command-central. Invoke on "cut a preview", "ship the next RC", "release the next preview", "build the prerelease". Wraps `just cut-preview` with cross-repo coordination and a clean handoff.
---

# Cut Preview — command-central

Single entry: `just cut-preview`. Skill's job is to check preconditions, invoke the recipe, interpret failures, and hand off to the user for smoke-test + commit.

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

If any hard precondition fails: STOP, report, do not auto-fix in sister repos.

## Happy path

1. Run `just cut-preview`. ~15–20s on hub.
2. On success, dist prints VSIX + digest paths and installs to VS Code.
3. Tell user to `Cmd+Shift+P → Developer: Reload Window` and smoke-test:
   - Agent Status sidebar renders project → status → time sub-groups
   - Toolbar `Clear Completed Agents` + `Reap Stale Agents` work
   - Right-click stale → `Mark as Failed` persists
   - `Focus Terminal` routes to the exact tmux pane
   - Output channel: no activation errors
4. Hand off: show `git status`. Agent may `git add` on explicit user request but cannot `git commit` — user finalizes the commit.

## Failure paths

**CC dirty outside allowlist / launcher dirty**
STOP. Ask user to commit or stash. Do not pick for them. First-run paradox: scaffolding that adds `cut-preview` is itself NOT on the allowlist; user must commit `justfile` / `.claude/` edits before the skill can guard itself.

**`just ci` fails (rehearsal or gate)**
Fix upstream. Do NOT silence knip, skip tests, or use `--no-verify`. Biome: `just fix`. tsc/knip/tests: real bugs.

**Gate fails in launcher `just check`**
Read `research/prerelease-gate/latest.json` `output` field. Most common: shfmt drift → user runs `just fix` in launcher, commits, then re-sync here. Contract violations (CLI flags, `oste-steer.sh`) → cross-repo coordination.

## Never do

- `git commit` or `git push` in either repo. The harness denies `git commit` even after verbal authorization; `git add` usually works. User finalizes commits.
- `just fix` in the launcher repo without user consent — risks rewriting their in-progress work.
- Update `CHANGELOG.md` for a preview — the digest is the record. CHANGELOG is curated for stable GA.
- Run on node (`ostemini`) — hub only, per `machines_hub_vs_node` memory.

## Key gotchas

- **`sync-launcher` only pulls the top-level `launcher` script**, not `scripts/lib/*.sh`. Changes to helper shells don't reach the VSIX unless `launcher` itself is regenerated upstream. If a launcher commit touches only helpers, the gate SHA advances but the shipped bytes may not change — confirm with the launcher author if in doubt.
- **Preflight first-run paradox**: the scaffolding that adds `cut-preview` isn't on the allowlist. User must commit the skill/justfile first, then cut.
- **VSIX files are `.gitignore`'d** (`*.vsix`). `git status` after a cut won't list them — the digest `releases/digest-v<v>.md` is the tracked record.

## Reference files

- `justfile` L528–589 — `cut-preview`, `_preview-preflight`, `_preview-rehearsal`
- `scripts-v2/prerelease-gate.ts` — cross-repo gate
- `scripts-v2/dist-simple.ts` — version bump + VSIX build
- `scripts-v2/sync-launcher.ts` — canonical launcher pull
- `research/prerelease-gate/latest.json` — last gate record (read on failure)
