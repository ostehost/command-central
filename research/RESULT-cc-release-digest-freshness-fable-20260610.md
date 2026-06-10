# RESULT — cc-release-digest-freshness-fable-20260610

Fix the non-blocking rc52 review nit: generated release digests were
content-identical across preview cuts (rc51 vs rc52 differed only in the
header line). Local tooling change only — **no preview was cut**.

## Root cause

`scripts-v2/dist-simple.ts` writes `releases/digest-v<version>.md` by running
`scripts-v2/release-digest.ts --format discord`. That script renders the
**latest CHANGELOG.md section** — and the newest section is `[0.6.0-rc.23]`
(2026-05-09). Preview cuts do not add CHANGELOG sections, so every digest
since ~rc24 re-rendered the same frozen body; only the `## 🚀 Command Central
v…` header (taken from `package.json`) changed. Verified directly:

```bash
diff releases/digest-v0.6.0-rc.51.md releases/digest-v0.6.0-rc.52.md
# → only line 1 (the version header) differs
```

## Fix (deterministic, git-only — no LLM/prose generation)

`scripts-v2/release-digest.ts` was refactored into exported pure helpers plus
an `import.meta.main` CLI guard (matching the `preview-status.ts` convention)
and now appends a **"Since previous prerelease cut (rcNN)"** section to all
three formats (discord / markdown / plain):

1. **Base resolution** — `git log --grep='^chore(release): cut '` finds recent
   cut commits; the base is the most recent cut whose rc number differs from
   the current `package.json` version (`resolvePreviousCutBase`). Skipping
   same-rc cuts makes the output identical whether the digest is generated
   *during* a cut (current cut commit doesn't exist yet) or *after* it
   (e.g. `post-release-digest.sh`).
2. **Commit collection** — `git log <base>..HEAD --format=%h%x09%s`, with
   release-process noise filtered out (`chore(release):`, `docs(research):`
   prefixes — `RELEASE_NOISE_PATTERNS`). Capped at 12 entries with an
   "… and N more" overflow line.
3. **Graceful omission** — any git failure (not a repo, shallow CI clone, no
   prior cut commits) returns `null` and the section is omitted; the
   changelog digest still renders. This preserves the digest's
   best-effort/optional contract in `dist-simple.ts` and keeps CI (shallow
   `actions/checkout`) safe.
4. **`--version` guard** — the git-derived section describes HEAD relative to
   the previous cut, so it is only included when digesting the current
   package version, not when regenerating an older `--version` target.
5. **Empty window** — if only release-process commits landed since the base,
   the section renders an explicit "No functional commits since the rcNN cut
   (release-process commits only)" line, so consecutive digests still
   distinguish themselves truthfully.

For rc52 the digest now ends with exactly what the review nit asked for:

```
📦 **Since previous prerelease cut (rc51)**
  • `ebdb7382` fix(sync-launcher): bundle applescript lib helpers (window-probe)
```

No changes were needed in `dist-simple.ts` or `post-release-digest.sh` — the
CLI interface (`--format`, `--version`) is unchanged.

## Tests

New `test/scripts-v2/release-digest.test.ts` (23 tests):

- Pure helpers: `rcNumber`, `parseChangelogSections`, `parseSection`,
  `resolvePreviousCutBase` (incl. skip-own-cut and non-rc fallback),
  `filterReleaseNoise`, all three formatters (section present/absent, empty
  window, overflow cap).
- Temp-git-repo integration for `collectSinceSection`: surfaces functional
  commits since the previous cut, is identical pre/post the current cut
  commit, reports the no-functional-commits case, returns `null` with no cut
  commits or outside a repo.
- CLI smoke test against the real repo (asserts the digest renders; does not
  assert the git section, so shallow-clone CI stays green).

## Commands run

```bash
git status --porcelain && git log --oneline -5   # clean tree at edf03cd3
bun test test/scripts-v2/release-digest.test.ts  # 23 pass, 0 fail
just fix                                          # biome format/lint
just check                                        # biome ci + tsc + knip → pass
just test                                         # 1763 tests, 0 fail
bun run scripts-v2/release-digest.ts --format discord  # manual verification
```

Explicitly **not** run: `just cut-preview`, push, tag, publish, external
install, release creation.

## Remaining release implications

- **Existing committed digests are not rewritten.** rc24–rc52 digest files in
  `releases/` keep their stale bodies; the fix applies from the next cut
  onward. The committed `digest-v0.6.0-rc.52.md` is the historical artifact
  of the rc52 cut and was intentionally left untouched.
- **The CHANGELOG body itself is still frozen at `[0.6.0-rc.23]`.** The new
  section restores per-RC freshness, but the headline Added/Changed/Fixed
  content will keep describing rc23-era work until someone adds a new
  CHANGELOG section (e.g. at the eventual `0.6.0` stable cut). Worth a
  CHANGELOG refresh before any partner-facing 0.6.0 announcement.
- **`[Unreleased]` caveat:** the generator targets the first `## […]` section
  in CHANGELOG.md. If an `[Unreleased]` section is ever added, it would
  become the default digest target with a mismatched version header — add it
  only together with a generator tweak.
- **Base-marker dependency:** previous-prerelease detection keys off the
  `chore(release): cut rcNN preview` commit-subject convention used by the
  cut flow. If that subject format changes, `CUT_SUBJECT_GREP` /
  `rcNumber()` in `scripts-v2/release-digest.ts` must follow.
- The next `just cut-preview` (rc53) will automatically include its own
  since-section; no flow changes are required.
