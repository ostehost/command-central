# Command Central Push + Review Handoff

**Date:** 2026-05-27
**Repo:** `~/projects/command-central`
**Branch:** `main` (34 commits ahead of `origin/main`)
**Scope:** 80 files changed, +8392 / -227 lines

## What Needs to Happen

Push 34 unpushed commits on main to origin, with a review pass to ensure nothing regresses. The commits span rc39–rc45, so most of this code has been through dogfood cycles already. The review should focus on the net diff, not per-commit archaeology.

## Commit Groups (for review prioritization)

### High-value features + fixes (review these)

| Commit | Area | Summary |
|--------|------|---------|
| `3ad35631` | agent-status | Surface completion routing, redesign action menu |
| `0cb14648` | agent-status | Lifecycle conflict when launcher=failed but process alive |
| `60a848c0` | tree | Deterministic single-click for agent tree items |
| `721a6b98` | tree | Non-running tasks default-click opens diff, not terminal |
| `475a6cfb` | tree | Surface lifecycle conflict — completed tasks with live tmux panes |
| `41eba078` | tree | Filter auto-review lanes from primary Agent Status tree |
| `792f0434` | tree | Polish review-lane UX — calmer detached copy, standalone run labels |
| `ab850c19` | badge | Working count for activity badge, pid-null dedup |
| `613b6b78` | discovery | Check internal-tool-dir before symlink canonicalization |
| `6e75dbe3` | symphony | Preserve launcher owner_actions on codex run projection |
| `ffc80dbb` | focus | Allow completed tasks with terminal metadata to use focus strategies |
| `86b69a40` | agent-status | Suppress completed launcher Claude sessions |
| `1570f21e` | model-aliases | Add claude-opus-4-7 and claude-sonnet-4-6 exact entries |

### New skill (review for conventions compliance)

| Commit | Summary |
|--------|---------|
| `fe0984d2` | `feat(skill): add command-central-vscode-extension skill` — 8 files, 1734 lines |
| `0739c832` | `docs: add skill conventions and CLAUDE.md skills section` — CONVENTIONS.md + CLAUDE.md pointer |

The skill has been through 4 review iterations with fixture testing (39/39 pass), shellcheck, quick_validate.py, and a safety review checklist documented in `.claude/skills/command-central-vscode-extension/proof.md`.

### Prerelease cuts (low-risk, already shipped)

`rc39` through `rc45` — version bumps and VSIX builds. These are mechanical.

### Auto-commit agent work (10 chore commits)

Each pairs with a feature/fix commit above. Contains the raw agent work before it was cleaned up into the named commits.

### Research/docs (5 commits)

Research handoffs, computer-use smoke records, review-lane validation docs. No code impact.

## Suggested Review Strategy

1. **Run `just ready`** to confirm the full suite passes at HEAD before pushing.
2. **Review the net diff** (`git diff origin/main..HEAD`) rather than per-commit. The 13 feature/fix commits are the substance.
3. **Key risk areas:**
   - Tree click behavior (`60a848c0`, `721a6b98`) — changed the default single-click action. Verify it doesn't break existing muscle memory.
   - Review-lane filtering (`41eba078`, `792f0434`) — new tree section. Confirm it doesn't appear when no review lanes exist.
   - Lifecycle conflict surfacing (`475a6cfb`, `0cb14648`) — new warning nodes in the tree. Confirm they don't false-positive on normal completed tasks.
   - Discovery symlink fix (`613b6b78`) — changed canonicalization path. Edge case for internal tools.
4. **Skill review:** Skim `proof.md` for the safety checklist. Confirm no hardcoded paths, no VS Code settings mutation, scripts default to dry-run.
5. **Push** after review passes.

## Push Command

```bash
git push origin main
```

## Post-Push

After push, propagate the skill to OpenClaw (if not already done):
```bash
openclaw skills install .claude/skills/command-central-vscode-extension --as command-central-vscode-extension --force
```

Verify:
```bash
openclaw skills info command-central-vscode-extension
```
