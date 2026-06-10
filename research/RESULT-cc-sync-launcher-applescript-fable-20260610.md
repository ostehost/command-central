# RESULT — cc-sync-launcher-applescript-fable-20260610

Fixed the warning from `review-cc-rc51-preview-cut-fable-20260610`: the
sync-launcher flow mirrored only `.sh`/`.py` files from Ghostty Launcher's
`scripts/lib/`, so `window-probe.applescript` — referenced by the synced
`bundle-runtime.sh` for hardened window probing — never reached
`resources/bin/scripts/lib/`. Fallback was safe (legacy `osascript` window
count), so this is a follow-up fix, not an rc51 respin. Local-only: no preview
cut, no push, no tags, no publish.

## Preconditions verified

- command-central tree clean at start; HEAD `d9a08200` (rc51 receipt).
- ghostty-launcher tree clean at HEAD `3cab35c4`; launcher version 1.2.8.
- Bug reproduced live before the fix: `bun run scripts-v2/sync-launcher.ts
  --check` exited 0 ("helpers already in sync") despite the bundled
  `window-probe.applescript` being absent.

## Changes

| File | Change |
| --- | --- |
| `scripts-v2/sync-launcher.ts` | New exported `HELPER_LIB_EXTENSIONS` (`.sh`, `.py`, `.applescript`) + `isHelperLibEntry()` predicate; replaces the four duplicated extension filters in `checkHelpers()`/`syncHelpers()` (check both directions, stale cleanup, copy). `main()` now guarded by `import.meta.main` so tests can import the predicate. Pre-existing TS4111 env access fixed (`process.env["..."]`) — the test import pulled the file into the type-checked program for the first time. |
| `scripts-v2/vsix-content-gate.ts` | `extension/resources/bin/scripts/lib/window-probe.applescript` added to `REQUIRED_ENTRIES`, making a future missing-probe package a hard build failure. |
| `resources/bin/scripts/lib/window-probe.applescript` | Bundled via the fixed sync; byte-identical to launcher HEAD `3cab35c4` (verified with `cmp` against `git show HEAD:scripts/lib/window-probe.applescript`). |
| `test/scripts-v2/sync-launcher.test.ts` | New. Unit tests for the predicate (accepts `.sh`/`.py`/`.applescript`, rejects `.txt`/`.md`/`.json`/`.bak`) plus an end-to-end temp-dir test: sync copies the applescript helper and skips non-runtime files, clean `--check` exits 0, deleting the probe and planting a stale `zombie.applescript` makes `--check` exit 1 naming both, and re-sync restores the probe and removes the zombie. |
| `test/scripts-v2/vsix-content-gate.test.ts` | Fixture + contract test updated for the new required entry. |

Deliberately narrow scope: the extension allowlist grew by exactly
`.applescript` (the only other runtime type `bundle-runtime.sh` invokes via
`osascript`), not to arbitrary file types. `copyExecutable()` still chmods only
`.sh`; the probe is run through `osascript` and stays non-executable, matching
upstream permissions.

## Commands run

```bash
bun run scripts-v2/sync-launcher.ts --check   # pre-fix: exit 0 (bug reproduced)
bun run scripts-v2/sync-launcher.ts           # post-fix: 36 helper files (was 35)
bun run scripts-v2/sync-launcher.ts --check   # post-fix: exit 0, probe accounted for
cmp resources/bin/scripts/lib/window-probe.applescript \
  <(git -C ~/projects/ghostty-launcher show HEAD:scripts/lib/window-probe.applescript)
just ready                                    # fix → check → test
```

## Gates

| Gate | Result |
| --- | --- |
| `just fix` (Biome format/lint, 249 files) | ✅ |
| `just check` (Biome CI + tsc + knip) | ✅ |
| `just test` | ✅ 1739 pass / 1 skip / 0 fail (124 files, 10.69s) |
| Test quality checks (no `as any`, no reflection, no skips) | ✅ |
| Targeted: `bun test test/scripts-v2/sync-launcher.test.ts test/scripts-v2/vsix-content-gate.test.ts` | ✅ 16 pass / 0 fail |
| Bundled probe vs launcher HEAD `3cab35c4` | ✅ byte-identical |
| Re-run `--check` after sync | ✅ exit 0 |

## Notes for the next preview cut

- The shipped rc51 VSIX intentionally does **not** contain the probe; it now
  fails the updated `REQUIRED_ENTRIES` if re-gated via `just vsix-gate`. That
  is the gate doing its job retroactively — rc52 (next cut) will package the
  probe and pass. No respin required per the review verdict.
- File-count budget headroom is unaffected (51 → 52 files of 120 allowed at
  the next cut).
