# RESULT — VSIX Diet (Lane A from the bloat map)

- **Task:** cc-vsix-diet-fable-20260610 (implementation)
- **Date:** 2026-06-10, starting from clean HEAD `adb5eacd`
- **Input:** `research/RESULT-cc-bloat-map-2026-06-10.md` lane A — rc50 ships dev artifacts because `.vscodeignore` misses nested dirs and the root-only `*.md` glob misses nested markdown
- **Scope guard honored:** no cut, no version bump, no push/tag/publish/install; `releases/` untouched; proof VSIX packaged to `/tmp`

## Outcome

| Metric | rc50 (before) | Dieted candidate (after) | Reduction |
|---|---|---|---|
| Compressed | 2,667,775 bytes (2.5MB) | 264,518 bytes (258KB) | **10.1×** |
| Uncompressed | 21,217,743 bytes (21.2MB) | 880,796 bytes (0.88MB) | **24×** |
| Files | 488 | 51 | **9.6×** |

Removed from the package: `logs/` (10.8MB), `research/` (6.9MB, 219 files), `dist/extension.js.map` (1.4MB), `.clawpatch/` (91 files), `releases/` (74 files), `.preview-status/`, `.claude/`, `specs/`, `coverage-ci/`, `drafts/`, `.vscode/`, `scripts/`, `assets/`, all nested markdown.

Preserved (verified in the proof listing): `dist/extension.js` (no `.map`), `package.json`, `readme.md`, `changelog.md`, `LICENSE.txt`, `resources/bin/**` (ghostty-launcher + 33 scripts + `.launcher-version`), `resources/icons/**` (icon.png, activity-bar.svg, git-status set), `resources/shell/command-central.zsh`.

## Files changed

1. **`.vscodeignore`** — added the missing exclusions: `logs/**`, `research/**`, `.clawpatch/**`, `releases/**`, `.claude/**`, `specs/**`, `.preview-status/**`, `drafts/**`, `coverage-ci/**`, `.vscode/**`, `.vscode-test/**`, `scripts/**`, `assets/**`, `memory/**`, `.cursor/**`, `**/*.map`, `**/*.log`, `*.vsix`, `bun.lock`, `.oste-report.yaml`; replaced root-only `*.md` with `**/*.md` (still negating `!README.md` / `!CHANGELOG.md`). `assets/icon.svg` confirmed unreferenced in `src/` and `package.json` before excluding; `resources/**` left untouched (conservative — `resources/shell/command-central.zsh` kept even though no static reference was found).
2. **`scripts-v2/vsix-content-gate.ts`** (new) — deterministic gate over `unzip -l` output: forbidden directory prefixes (mirrors `.vscodeignore`), forbidden suffixes (`.map`, `.log`, `.vsix`, `.tsbuildinfo`), markdown allowlist (root `readme.md`/`changelog.md`/`license.md` only — vsce lowercases them), required runtime entries (`dist/extension.js`, `package.json`, `resources/bin/ghostty-launcher`, `resources/icons/icon.png`), and budgets (600KB compressed / 2MB uncompressed / 120 files ≈ 2–3× headroom over the measured 258KB / 0.88MB / 51).
3. **`scripts-v2/dist-simple.ts`** — runs the gate on every production VSIX candidate right after `vsce package`, before the candidate is moved into `releases/` or installed; a violation fails the build and leaves the candidate in place for inspection.
4. **`justfile`** — new `just vsix-gate [--vsix <path>]` recipe (defaults to newest VSIX in `releases/`).
5. **`test/scripts-v2/vsix-content-gate.test.ts`** (new) — 13 tests: listing parser (header/footer/directory skipping, names with spaces), every rc50 leak directory flagged, sourcemap/markdown/required-entry rules, package-metadata exemption, rc50-scale budget failure, inclusive budget boundary, report formatting.

### Gate placement rationale
`scripts-v2/prerelease-gate.ts` runs **before** packaging (`just prerelease` = gate → dist), so a hard VSIX check there could only inspect the *previous* rc — which would block the next clean cut on rc50's pre-diet bloat. The candidate-build hook in `dist-simple.ts` gates the actual artifact at creation time; `just vsix-gate` covers ad-hoc inspection of shipped artifacts.

## Evidence / exact commands

```bash
# Before (rc50, unchanged in releases/)
unzip -l releases/command-central-0.6.0-rc.50.vsix   # 21,217,743 bytes, 488 files
ls -la releases/command-central-0.6.0-rc.50.vsix     # 2,667,775 bytes

# Negative proof: gate rejects rc50
bun run scripts-v2/vsix-content-gate.ts --vsix releases/command-central-0.6.0-rc.50.vsix
# → ❌ 440 violation(s), exit 1

# After: production-equivalent candidate with the new .vscodeignore
bun build ./src/extension.ts --outdir ./dist --format esm --target node \
  --external vscode --external @vscode/sqlite3 --minify --sourcemap=external
bunx @vscode/vsce package --out /tmp/cc-vsix-diet-proof.vsix --no-dependencies \
  --allow-star-activation --allow-missing-repository --skip-license
# → DONE Packaged: /tmp/cc-vsix-diet-proof.vsix (51 files, 258.32 KB)

# Positive proof: gate passes the dieted candidate
bun run scripts-v2/vsix-content-gate.ts --vsix /tmp/cc-vsix-diet-proof.vsix
# → ✅ compressed 264,518 / uncompressed 880,796 / 51 files, exit 0

# Repo gates
bun test test/scripts-v2/vsix-content-gate.test.ts   # 13 pass / 0 fail
just fix && just check                               # clean
just test                                            # 1736 pass / 0 fail (10.2s)
just ci                                              # strict gate passed
```

## Residual size blockers

- **The "<100KB VSIX" commandment in CLAUDE.md is not reachable** with the current payload: `dist/extension.js` alone is 391KB uncompressed (~110KB share compressed) and the bundled launcher runtime (`resources/bin/**`) is ~330KB across 36 files. 258KB compressed is the realistic floor; shrinking further means trimming launcher scripts or splitting the bundle, not packaging hygiene. Consider updating the commandment to the gate budget (600KB).
- `releases/command-central-0.6.0-rc.{48,49,50}.vsix` on disk remain bloated until the next cut rotates them out; `just vsix-gate` will keep failing against them by design (they predate the diet).
- `logs/` on disk (10MB, untracked) no longer leaks into packages but is still a janitorial deletion candidate (bloat-map dead-code item 3).
- Lane E (bloat map) can later mirror the budget into CI; today the gate fires on every `just dist` production build.

## Release-gate note for the next cut

Nothing about this change runs at `just prerelease-gate` time, so the next `just cut-preview` exercises the gate live during `just dist --prerelease`. Expected: candidate packages at ~258KB, gate prints ✅, rc51 lands in `releases/` dieted. Bloat-map gate #4 (unzip -l diff in the lane receipt) is satisfied by this document.
