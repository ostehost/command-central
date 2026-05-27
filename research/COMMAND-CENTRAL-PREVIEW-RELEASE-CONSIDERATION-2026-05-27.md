# Command Central Preview Release Consideration

**Task ID:** `cc-preview-release-consideration-20260527-1408`
**Date:** 2026-05-27
**Role:** Reviewer/planner (read-only)
**HEAD:** `9be0971c` on `main`
**Current version:** `0.6.0-rc.42`
**Next version:** `0.6.0-rc.43`

---

## Verdict

```
release_readiness: ready_now
recommended_version: 0.6.0-rc.43
release_command: just cut-preview
blockers: none
```

All post-rc.42 code changes have been reviewed with 0 blockers. Quality gates passed at every commit. The `just cut-preview` command includes its own `just ci` rehearsal step, which will validate the aggregate before packaging.

---

## Git Status at Review Time

```
Branch:    main
HEAD:      9be0971c (chore: auto-commit agent work [cc-review-lane-tree-cleanup-20260526])
Ahead:     27 commits ahead of origin/main (local only, not pushed)
Working:   clean (no staged or unstaged changes)
Untracked: 3 research files (on preflight allowlist)
  - research/AGENT-STATUS-NEEDS-REVIEW-TRIAGE-2026-05-26.md
  - research/COMMAND-CENTRAL-GHOSTTY-CRASH-COUNT-INVESTIGATION-2026-05-26.md
  - research/COMMAND-CENTRAL-RELEASE-READINESS-DOGFOOD-2026-05-26.md
```

---

## WIP Inventory: Commits Since rc.42

| Commit | Type | Description | Review | Tests |
|--------|------|-------------|--------|-------|
| `60a848c0` | feat | Deterministic single-click for agent tree items | Reviewed, 0 blockers | 1603 pass |
| `ab850c19` | fix | Working count for badge, pid-null dedup, launcher error humanization | Reviewed, 0 blockers | 1603 pass |
| `721a6b98` | fix | Non-running tasks default-click opens diff, not terminal | Handoff verified | 1616 pass |
| `41eba078` | fix | Filter auto-review lanes from primary Agent Status tree | Handoff verified | 1632 pass |
| `9be0971c` | chore | Auto-commit wrapper (research file only, no code) | N/A | N/A |

Non-code commits also in range: `b2c9203d`, `8f4b5d94`, `a41ac540`, `6bfe69d0` (research docs, smoke proofs).

**Total delta since rc.42:** 16 source/test files changed, +747/-83 lines (code only).

---

## Pending Review Status

### Command Central lanes (all reviewed, no blockers)

| Task ID | Status | Review State | Blockers |
|---------|--------|-------------|----------|
| `cc-tree-terminal-ux-20260526` | completed_dirty | reviewed | 0 |
| `cc-badge-launcher-polish-20260526` | completed_dirty | reviewed | 0 |
| `cc-tree-terminal-ux-review-fixup-20260526` | reviewed (in reviewed/) | reviewed | 0 |
| `cc-review-lane-tree-cleanup-20260526` | reviewed (in reviewed/) | reviewed | 0 |

### Non-blocking fixup lanes (no code changes)

These three fixup lanes in `/tmp/oste-pending-review/` completed with empty `files_changed` and no commits. They are no-op fixups that don't affect release:

- `cc-dogfood-agent-status-20260525-2008-fixup-1` — pending review, no code
- `cc-prev-chats-completion-20260525-2055-fixup-1` — pending review, no code
- `cc-release-preview-update-20260525-2036-fixup-1` — pending review, no code

### Cross-repo lanes (not CC blockers)

- `ghostty-launcher-signing-fix-20260526` — reviewed, 0 blockers
- `config-node-tmux-bootstrap-verify-20260527` — active review dispatch (config repo, unrelated)
- `ghl-auto-review-dispatch-fix-team-20260526-1512-fixup-1` — pending review (launcher repo, unrelated)

---

## Research Handoffs Referenced

| File | Date | Verdict/Relevance |
|------|------|-------------------|
| `COMMAND-CENTRAL-TREE-TERMINAL-UX-2026-05-26.md` | 05-26 | Documents `60a848c0` UX changes |
| `COMMAND-CENTRAL-TREE-TERMINAL-UX-FIXUP-2026-05-26.md` | 05-26 | Documents `721a6b98` fixup |
| `COMMAND-CENTRAL-BADGE-LAUNCHER-POLISH-2026-05-26.md` | 05-26 | Documents `ab850c19` badge/dedup/error fixes |
| `COMMAND-CENTRAL-REVIEW-LANE-TREE-CLEANUP-2026-05-26.md` | 05-26 | Documents `41eba078` auto-review lane filter |
| `COMMAND-CENTRAL-RELEASE-READINESS-DOGFOOD-2026-05-26.md` | 05-26 | Prior readiness review; recommended rc.43. Predates review-lane cleanup but conclusion still holds |
| `AGENT-STATUS-NEEDS-REVIEW-TRIAGE-2026-05-26.md` | 05-26 | Triage of 117 Needs Review lanes; CC-specific items now all reviewed |

---

## Prior Release Readiness Review Delta

The prior review (`COMMAND-CENTRAL-RELEASE-READINESS-DOGFOOD-2026-05-26.md`) was written at HEAD `99eb00db` and recommended `ready_for_preview: yes` for rc.43. Since that review:

1. **`721a6b98`** landed — tree click fixup (non-running tasks → diff, not terminal). This was a UX correctness fix to the feature reviewed. 13 new tests. `just ready` → 1616 pass.
2. **`41eba078`** landed — auto-review lane filter. Prevents review worktree tasks from polluting the primary tree. 16 new tests. `just ready` → 1632 pass.
3. **`9be0971c`** landed — auto-commit wrapper for the review-lane cleanup handoff (research file only, no code).

Both new code commits strengthen the release; neither introduces risk. The prior recommendation to cut rc.43 is reinforced, not weakened.

---

## Ghostty Launcher Integration Assessment

### App-bundle signing (fixed)

The ghostty-launcher signing issue is resolved:
- Launcher commit `8daba0c9`: `fix(signing): allow ad-hoc bundles to load frameworks`
- `/Applications/Projects/command-central.app` now shows:
  - CodeDirectory **v20500** (correct; was downgraded to v20400 before fix)
  - Flags: `adhoc,runtime` (hardened runtime preserved)
  - Entitlement: `com.apple.security.cs.disable-library-validation` present
- Review: completed, 0 blockers

### CC-side error handling (already in rc.43 delta)

Commit `ab850c19` added:
- `humanizeLauncherError()` for friendly app-bundle failure messages
- Integrated-terminal fallback via `promptIntegratedTerminalFallback()`
- `execLauncher()` wrapping for proper `LauncherExecutionError` propagation

Even if app-bundle signing regresses in the future, CC handles it gracefully — no raw stderr leaks, functional degradation to integrated terminal.

### Sync-launcher integration

`just cut-preview` runs `just sync-launcher` which pulls the canonical launcher script from `~/projects/ghostty-launcher/`. This will pick up the signing fix. The launcher binary at HEAD `8daba0c9` is current.

---

## Checks Embedded in Release Command

`just cut-preview` already performs these gates before building:

1. **`_preview-preflight`** — refuses dirty trees (untracked `research/` files are allowlisted), verifies launcher repo exists
2. **`sync-launcher`** — pulls latest launcher script from ghostty-launcher
3. **`_preview-rehearsal`** — runs `just ci` (biome CI + typecheck + knip + full test suite, warnings=errors)
4. **`prerelease`** — cross-repo prerelease gate + `bun dist --prerelease`

No additional pre-flight checks are needed beyond what the command already performs.

---

## Recommended Next Commands

When ready to cut the preview:

```bash
# 1. Cut the preview (single command: preflight + sync + gate + dist)
just cut-preview

# 2. Install the built extension
code --install-extension releases/command-central-0.6.0-rc.43.vsix

# 3. Reload VS Code
# Cmd+Shift+P → "Developer: Reload Window"

# 4. Smoke test
# - Click an agent tree item (running → terminal, completed → diff)
# - Verify badge shows working count only
# - Verify auto-review lanes are hidden from primary tree
# - Verify Ghostty app bundle launches (signing fix integration)
```

---

## What Must Not Be Disturbed

1. **Untracked research files** — 3 files in `research/` are intentionally untracked. Do not `git add` or delete them.
2. **Pending-review metadata** — `/tmp/oste-pending-review/` and its subdirectories are evidence of the review pipeline. Do not edit or remove.
3. **Launcher tasks.json** — `~/.config/ghostty-launcher/tasks.json` contains active/completed task state. Do not modify.
4. **Origin state** — 27 commits ahead of origin/main. Do not push without explicit user instruction.
5. **Other project lanes** — `config-node-tmux-bootstrap-verify-20260527` has an active review dispatch. Leave it alone.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| `just ci` fails at HEAD | Low | All gates passed at `41eba078`; only a research file was added since then |
| Launcher sync pulls unexpected changes | Low | ghostty-launcher HEAD is `8daba0c9` (the signing fix); no other changes landed |
| App-bundle signing regresses on another macOS update | Low | CC has integrated-terminal fallback; not a CC-level blocker |
| Auto-review lane filter has false positives on manual reviewer lanes | Low | Detection requires `/tmp/*-review` path + corroborating signal; manual reviewer lanes in real project dirs are excluded |
| Test count regression (1632 → lower) | None | No test deletions in the delta; test count only grew |

---

## Summary

**Ready now.** Five feature/fix commits since rc.42, all reviewed with zero blockers, adding 747 lines of code and 232 lines of new tests. The prior release-readiness review's recommendation to cut rc.43 is reinforced by two additional correctness fixes. Ghostty launcher signing is fixed and will be synced by the release command. Run `just cut-preview` when ready.
