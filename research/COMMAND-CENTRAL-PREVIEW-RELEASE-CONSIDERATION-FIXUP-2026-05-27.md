# Command Central Preview Release Consideration — FIXUP

**Task ID:** `cc-preview-release-consideration-fixup-20260527-1422`
**Date:** 2026-05-27
**Prior handoff:** `research/COMMAND-CENTRAL-PREVIEW-RELEASE-CONSIDERATION-2026-05-27.md`
**HEAD:** `9be0971c` on `main`
**Role:** Reviewer/planner (read-only)

---

## Corrected Verdict

```
release_readiness: ready_after_review
recommended_version: 0.6.0-rc.43
blockers: untracked research files fail _preview-preflight (not a code blocker)
prerequisite: commit or stash 5 untracked research/*.md files
```

Code is release-worthy. All post-rc.42 commits are reviewed with zero blockers, tests pass, and the delta strengthens the release. The sole obstacle is that `just _preview-preflight` rejects untracked files outside its allowlist, and untracked `research/*.md` files are **not** on that allowlist.

---

## Manager-Facing Summary

The prior handoff (`COMMAND-CENTRAL-PREVIEW-RELEASE-CONSIDERATION-2026-05-27.md`) concluded `ready_now`. That verdict was wrong. The handoff stated on line 33 that untracked research files were "on preflight allowlist" and on line 139 that "untracked `research/` files are allowlisted." Both claims are false.

**The actual allowlist** (`justfile:619`) is:

```
ALLOW='^.. (resources/bin/ghostty-launcher|resources/bin/\.launcher-version|
            resources/bin/scripts/|resources/app/\.terminal-version|
            package\.json|releases/|research/prerelease-gate/)'
```

This covers `research/prerelease-gate/` (gate JSON artifacts), **not** `research/*.md` (handoff documents). The prior review read the prefix `research/` in the regex and inferred it covered the whole directory. It does not — the trailing `prerelease-gate/` narrows the match to that subdirectory only.

**Impact:** The false assumption caused Oste to attempt `just cut-preview`, which failed immediately at the preflight gate. No artifacts were produced, no state was mutated. The fix is a 30-second commit of the untracked research files.

---

## Live Evidence

### Preflight failure (reproduced)

Simulating the preflight allowlist filter against `git status --porcelain`:

```
$ ALLOW='^.. (resources/bin/ghostty-launcher|...releases/|research/prerelease-gate/)';
  git status --porcelain | grep -vE "$ALLOW"

?? research/AGENT-STATUS-NEEDS-REVIEW-TRIAGE-2026-05-26.md
?? research/COMMAND-CENTRAL-GHOSTTY-CRASH-COUNT-INVESTIGATION-2026-05-26.md
?? research/COMMAND-CENTRAL-PREVIEW-RELEASE-CONSIDERATION-2026-05-27.md
?? research/COMMAND-CENTRAL-RELEASE-READINESS-DOGFOOD-2026-05-26.md
```

All four untracked files fall through the allowlist filter, causing `_preview-preflight` to `exit 1`. After this fixup handoff is written, a fifth file (`COMMAND-CENTRAL-PREVIEW-RELEASE-CONSIDERATION-FIXUP-2026-05-27.md`) will also be present.

### Allowlist anatomy (`justfile:619`)

| Allowlist entry | Purpose | Status |
|-----------------|---------|--------|
| `resources/bin/ghostty-launcher` | Synced launcher binary | Expected churn from `sync-launcher` |
| `resources/bin/.launcher-version` | Launcher version stamp | Expected churn |
| `resources/bin/scripts/` | Launcher scripts | Expected churn |
| `resources/app/.terminal-version` | Terminal version stamp | Expected churn |
| `package.json` | Version bump from `npm version` | Expected churn |
| `releases/` | Built VSIX artifacts | Expected churn |
| `research/prerelease-gate/` | Gate JSON artifacts | Expected churn |

`research/*.md` is absent. These files are handoff documents from agent review workflows and were never anticipated by the allowlist.

### Prior handoff errors

| Prior claim | Location | Actual |
|-------------|----------|--------|
| "3 research files (on preflight allowlist)" | Line 33 | **False.** `research/*.md` is not on the allowlist. Only `research/prerelease-gate/` is. |
| "untracked research/ files are allowlisted" | Line 139 | **False.** Same root cause. |
| "No additional pre-flight checks are needed" | Line 144 | **False as stated.** The embedded checks are sufficient *if* the working tree is clean or only has allowlisted churn. The untracked research files cause the check to fail. |

---

## Iteration Plan

### Option A — Commit the research files (recommended, ~30 seconds)

This is the smallest safe step. The research files are review artifacts with no effect on the extension build or tests.

```bash
# ⚠️ Requires Oste/Mike approval (git commit)
git add \
  research/AGENT-STATUS-NEEDS-REVIEW-TRIAGE-2026-05-26.md \
  research/COMMAND-CENTRAL-GHOSTTY-CRASH-COUNT-INVESTIGATION-2026-05-26.md \
  research/COMMAND-CENTRAL-PREVIEW-RELEASE-CONSIDERATION-2026-05-27.md \
  research/COMMAND-CENTRAL-RELEASE-READINESS-DOGFOOD-2026-05-26.md \
  research/COMMAND-CENTRAL-PREVIEW-RELEASE-CONSIDERATION-FIXUP-2026-05-27.md

git commit -m "chore: stage research handoffs for rc.43 preview cut"

# Then proceed with the release
just cut-preview
```

**Preserves WIP:** Yes — the files are committed as-is, no content changes.
**Reversible:** Yes — `git reset HEAD~1` undoes it.
**Risk:** None — research markdown has zero effect on CI, build, or test gates.

### Option B — Temporary worktree (validation or release path)

A detached-HEAD worktree created from `main` HEAD would not contain the untracked research files, so `_preview-preflight` would pass.

```bash
# ⚠️ Requires Oste/Mike approval (creates worktree + runs release)
git worktree add --detach /tmp/cc-preview-cut HEAD
cd /tmp/cc-preview-cut
just cut-preview
# Install from worktree path:
code --install-extension /tmp/cc-preview-cut/releases/command-central-0.6.0-rc.43.vsix
# Cleanup:
cd /Users/ostehost/projects/command-central
git worktree remove /tmp/cc-preview-cut
```

**Can this validate gates?** Yes — `just _preview-preflight`, `just ci`, and the full prerelease gate would all execute in the clean worktree.

**Can this actually cut the release?** Yes, with caveats:
- The VSIX is produced in `/tmp/cc-preview-cut/releases/` and can be installed from there.
- `package.json` is bumped in the worktree. Since it's a detached HEAD, you'd need to cherry-pick or manually apply the version bump back to `main`.
- `sync-launcher` runs against `~/projects/ghostty-launcher/` (absolute path), so it works from either worktree.

**Tradeoff:** More complex than Option A. Useful if the research files should *not* be committed (e.g., they contain draft content that shouldn't enter git history yet). But these are review handoff artifacts — committing them is the norm in this project.

### Option C — Broaden the allowlist (code change)

Change `justfile:619` from `research/prerelease-gate/` to `research/`. This would let all `research/` files through the preflight gate.

```
# Would require editing justfile:619
# Old: research/prerelease-gate/
# New: research/
```

**Not recommended for this iteration:** It's a code change, requires `just ready` validation, and changes the safety semantics of the preflight gate. The gate is intentionally narrow — broadening it should be a deliberate policy decision, not a release-day workaround.

---

## Recommended Sequence

1. **Oste reviews this fixup** and confirms the corrected verdict.
2. **Oste commits the untracked research files** (Option A commands above).
3. **`just cut-preview`** runs with a clean preflight.
4. **Standard smoke test** per prior handoff's recommended steps (lines 153–167).

The code assessment from the prior handoff remains valid — all post-rc.42 commits are reviewed, tests pass (1632), and the delta strengthens the release. Only the `ready_now` verdict was incorrect due to the allowlist misread.

---

## What Remains True from the Prior Handoff

- All 5 post-rc.42 code commits reviewed with 0 blockers
- Test count: 1632 pass, 0 fail
- Ghostty launcher signing fix integrated
- Cross-repo lanes not blocking CC
- No code, test, or integration blockers exist

The only correction is the release-readiness verdict: `ready_after_review` (clean up untracked files first), not `ready_now`.
