# RESULT — cc-release-digest-base-hardening-fable-20260610

Hardening pass on the git-derived "Since previous prerelease cut" digest
section (approved in `6a2e57a5`), addressing the three non-blocking nits from
`review-cc-release-digest-freshness-fable-20260610`. No preview was cut; no
committed rc52 digest artifacts were touched.

## Nits → fixes

### 1. `git log --grep` semantics varied with `grep.patternType`

The base query used `--grep='^chore(release): cut '` with no pattern-type
flag, so it inherited whatever `grep.patternType` the repo/user config set.
The pattern is valid BRE (parens literal) but under `extended`/`perl`
semantics `(release)` becomes a group and the pattern silently matches
nothing — the section would just vanish.

**Fix:** pass `--fixed-strings` explicitly; the command-line flag overrides
any `grep.patternType` config. Demonstrated in the real repo:

```console
$ git -c grep.patternType=extended log --grep='^chore(release): cut ' -n 3 --oneline
(no output — old pattern silently broken)

$ git -c grep.patternType=extended log --fixed-strings --grep='chore(release): cut ' -n 3 --oneline
6d052d21 chore(release): cut rc52 preview
0d33511a chore(release): cut rc51 preview
07fe65fb chore(release): cut rc50 preview
```

### 2. `--grep` matches commit bodies, not just subjects

A commit that merely *mentions* `chore(release): cut rc1 preview` in its body
could be returned by the grep and selected as the base, producing an
empty/wrong range. (Note this was true even for the old anchored pattern —
git's grep anchors `^` at the start of any message line, including body
lines.)

**Fix:** the grep is now only a coarse pre-filter. An exported
`isCutCommit(subject)` — `subject.startsWith("chore(release): cut ")` — is
the authoritative check, applied to `%s` (subject only) in TypeScript. The
candidate window was widened from `-n 10` to `-n 50` so body-only false
positives cannot crowd the real cut out of the window; if more than 50
matches ever sit between HEAD and the real previous cut, resolution fails
to `null` (section omitted — safe failure, never a wrong base).

### 3. Stable `0.6.0` (non-rc) base resolution

Old behavior: a non-rc current version took the *most recent* cut as base.
Pre-stable-cut that is plausible (last rc), but post-cut the most recent cut
could be the stable cut itself — there is no rc number with which to
recognize "the current version's own cut", so the section would silently
describe an empty or wrong range. No stable cut commit convention exists yet
(rc cuts use `chore(release): cut rcNN preview`; nothing generates a stable
variant), so own-cut detection for stable is not implementable today.

**Fix (guard, documented):** `resolvePreviousCutBase` returns `null` when
`rcNumber(currentVersion)` is `null`. Stable digests render the changelog
section only. This is also semantically right: the since-section exists to
cover the changelog gap *between* RCs; a stable cut writes a full
`## [0.6.0]` changelog section, so nothing is lost.

## Files changed

- `scripts-v2/release-digest.ts` — `--fixed-strings` + `-n 50` grep, exported
  `CUT_SUBJECT_PREFIX` / `isCutCommit()` subject filter, non-rc guard in
  `resolvePreviousCutBase`, updated docs.
- `test/scripts-v2/release-digest.test.ts` — new coverage:
  - `isCutCommit` accepts cut subjects, rejects mere mentions
    (revert/embedded).
  - temp-repo: cuts resolve with `grep.patternType=extended` set in repo
    config (fails against the old code).
  - temp-repo: a commit mentioning a cut only in its body is not selected as
    base.
  - temp-repo + pure: non-rc version returns `null` (replaces the old
    "most recent cut for non-rc" expectation).

## Verification

```console
$ bun test test/scripts-v2/release-digest.test.ts   # 28 pass, 0 fail
$ just fix                                          # 1 file (import order)
$ just check                                        # biome + tsc + knip clean
$ just test                                         # 1767 pass, 0 fail
$ bun run scripts-v2/release-digest.ts --format discord   # output unchanged:
# base rc51, `6a2e57a5` + `ebdb7382` listed, noise filtered
$ bun run scripts-v2/release-digest.ts --format plain     # since-section renders
```

## Remaining stable-release implications

- The stable `0.6.0` cut lane **must write a complete `## [0.6.0]` changelog
  section** — the digest will not backfill stable releases from git by
  design.
- If a stable cut commit convention is later defined (e.g.
  `chore(release): cut v0.6.0`), the resolver can be extended to recognize
  the current version's own cut by exact version-string match and re-enable
  the section for stable cuts. Until then, omission is the safe behavior.
