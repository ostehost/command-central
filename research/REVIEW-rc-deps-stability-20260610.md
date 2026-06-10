# RECEIPT — RC dependency/stability lane (2026-06-10)

Task: `command-central-rc-deps-stability-20260610` · Node: Mike MacBook Pro · Repo: `~/projects/command-central`

## HEAD movement

| | Commit | Subject |
|---|---|---|
| Start | `18a9c33c` | docs: record Fable patch closeout and rc50 readiness review |
| Last code commit | `1665defe` | fix(release): record artifact identity in preview-cut lifecycle receipts |
| End | HEAD | docs commit carrying this receipt + the gate provenance JSON |

Branch: `main...origin/main [ahead 7]` after this lane (was ahead 4). Tree clean. **Not pushed** per constraints.

## Dependency posture evaluated

| Surface | State | Evidence |
|---|---|---|
| Runtime dependencies | **None** — devDependencies only | `package.json` has no `dependencies` key |
| Lockfile ↔ manifest | **Consistent** | `bun install --frozen-lockfile --dry-run` exits 0 |
| Bundled launcher binary | **In sync** (v1.2.8, content-compared) | `sync-launcher.ts --check` |
| Bundled launcher helpers | **Was drifted (3 files) → fixed this lane** | see below |
| Bundled terminal app | Not present on this node (`~/ghostty-fork` absent) — `_check-terminal-sync` is a no-op here, as designed | justfile guard |
| Preview lifecycle receipts | **Recorder gap → fixed this lane** | rc49 record showed `version: (none)` despite success |

## Fixes applied (2 commits)

### 1. `997c3d71` — chore(sync): pull committed launcher helper fixes into bundled resources

The three helpers flagged in the rc50 readiness review (`REVIEW-fable-rc-perspective-20260609.md`) had drifted from launcher canonical after the rc49 cut:

- `oste-stop-hook.sh` — worktree-aware artifact-dir candidates
- `reaper.sh` — single-pass `ps` orphan scan (launcher `70e3abc5`)
- `terminal-persist.sh` — shared `--lines N` capture interface (launcher `432656e1`)

Synced via `just sync-launcher` from a **clean** launcher tree at `f4e5e493`. All three byte-identical to launcher's committed copies (`cmp`). The launcher repo was **not modified**. With this, the rc50 candidate bundle content is deterministic before the cut instead of changing mid-flight inside `cut-preview`'s sync step.

### 2. `1665defe` — fix(release): record artifact identity in preview-cut lifecycle receipts

Root cause of rc50-review risk #4: the `cut-preview` EXIT trap calls `preview-status finish --exit-code=$rc` and nothing ever supplies `--version/--artifact/--artifact-sha`, so every successful cut records `(none)` for artifact identity (rc49's record demonstrates it: `state: succeeded`, `version: (none)`, `artifact: (none)`).

Fix: `detectArtifact(cwd)` in `scripts-v2/preview-status.ts` + a `--auto-artifact` flag on `finish` — on exit 0 it fills version from the record-cwd's `package.json` (dist bumps the version mid-cut, so `start` can never carry it) and locates `releases/command-central-<version>.vsix` with its sha256. Explicit flags win; everything degrades to null rather than blocking the record write. The justfile trap now passes `--auto-artifact`. rc50's lifecycle record will carry real artifact identity.

## Gates (all green, this session)

| Gate | Result | Evidence |
|---|---|---|
| `bun test test/scripts-v2/preview-status.test.ts` | ✅ 45 pass (6 new) | this session |
| `bun test test/integration/cross-repo-smoke.test.ts` | ✅ 33 pass | post-helper-sync |
| `shellcheck` (3 synced helpers) | ✅ info-level only, pre-existing in launcher canonical | bundle must stay byte-identical |
| `just ready` (fix + check + full suite) | ✅ 1703 pass / 1 skip / 0 fail + quality checks | this session |
| `just prerelease-gate` | ✅ all 6 checks passed | `research/prerelease-gate/prerelease-gate-2026-06-10T06-54-03.143Z.json` (cc `1665defe` × launcher `f4e5e493`) |

Pre-commit Biome hooks ran on both commits. No `--no-verify`, no push, no tag, no publish, no `git fetch/pull/reset`.

## Next RC recommendation

**rc50 is cut-ready: run `just cut-preview --prerelease` on request.** It will now contain the Fable patch (`12b07332`), the three launcher helper fixes (already bundled and gated, so the cut's own sync step becomes a no-op), and trustworthy lifecycle receipts via `--auto-artifact`. Carried-over post-cut follow-ups from the rc50 review remain valid:

1. Install rc50 VSIX + reload for installed-extension proof of the Fable patch.
2. One manual ACP lane launch to execution-test the trailing `--model 'fable'` flag (still composition-tested only).

## Manager approvals needed (exact)

- **Push approval**: command-central `main` is now ahead 7 (and ghostty-launcher node remains ahead locally). Hub/node sync debt keeps accumulating; approve a push/sync lane after rc50.
- **Cut approval**: say the word to cut rc50 (`just cut-preview --prerelease`); nothing blocks it locally.

No Ghostty Launcher or config-repo changes were needed or made.
