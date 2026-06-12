# REVIEW — cc-projection-reader-gate-fixup-20260612

Independent review of the gate fixup `cc-worksystem-projection-reader-gate-fixup-20260612`
(fix commit `db809078`, receipt commit `806b72f7`), which claims to clear both blockers
from `REVIEW-cc-worksystem-projection-reader-20260611` (pending fixup
`/tmp/oste-pending-fixup/cc-worksystem-projection-reader-20260611.json`, 2 blockers, attempt 1).

## Verdict: **ACCEPT**

Both prior blockers are cleared at root cause, each verified with a counterfactual
(the failure reproduces at the pre-fix commit and disappears at HEAD in the same
environment). The projection-reader feature slice is untouched except one
semantically-equivalent lint rewrite outside the slice. All gates are green at HEAD.
No blocker for proceeding to the local RC proof / installed-VSIX UI dogfood.

## Review environment

- Repo: `/Users/ostehost/projects/command-central` (main repo, deps installed)
- HEAD: `806b72f799f7892351d156ab1b64fcedb5bd8186` (`docs(agent-status): add projection-reader gate fixup receipt`)
- Working tree: clean before and after review (`git status --porcelain` empty; only this
  review artifact added). No product code modified. A throwaway detached worktree at
  `7101eca3` was created in `/tmp/rev-prefix-wt` for counterfactual runs and removed afterward.
- Receipt commit `806b72f7` touches only `research/RESULT-…gate-fixup-20260612.md` (verified
  via `git show --stat --name-only`).

## Answers to the review questions

### 1. Does the fix preserve the work-system-lanes-projection reader behavior? — YES

- The fix commit's only `src/` change is `src/utils/openclaw-gateway-health.ts:75`:
  `!gateway || gateway["mode"] !== "remote"` → `gateway?.["mode"] !== "remote"`.
  `gateway` is typed `Record<string, unknown> | undefined` and assigned only object-or-undefined,
  so the rewrite is exactly equivalent (and equivalent even for arbitrary falsy values,
  since optional chaining yields `undefined` → `!== "remote"` → return local). This file is
  not part of the feature slice.
- The feature commit `b1803349` files (`src/providers/agent-status-tree-provider.ts`,
  `src/utils/tasks-file-resolver.ts`, the focused suite, skill docs, package.json) are
  untouched by `db809078`. All other fix-commit changes are test-file lint rewrites of the
  same `!x || x.type !== "y"` → `x?.type !== "y"` shape (equivalent for `find()` results)
  plus one export-statement reorder.
- Focused suite `test/integration/worksystem-lanes-projection.test.ts`: **10 pass / 0 fail, exit 0**.

### 2. Does `just test` now fail when the inner suite fails? — YES (proven both directions)

The recipe (`justfile:278`) now reads `bun run test || exit 1;` before the trailing
`just test-quality` step. `bun run test` is a plain `bun test <dirs>` (package.json:1882),
so its exit code is the suite's. Empirical proof with a PATH shim that makes `bun run test`
exit 1 and delegates everything else to real bun (no tree changes):

- **New recipe (HEAD)**: `PATH=shim just test` → **exit 1** (`Recipe 'test' failed on line 285 with exit code 1`).
- **Old recipe (`git show 7101eca3:justfile`)**: same shim, same repo → **exit 0**, ending with
  "✅ Quality checks passed!" — the exact masking the original review hit.
- End-to-end counterfactual (no shim): at pre-fix `7101eca3` in an installed worktree with
  ambient `TASKS_FILE` exported, the inner suite reported **2007 pass / 15 fail** yet
  `just test` exited **0** — the false-green reproduced for real.

A test-quality failure still propagates (it is the last command in the branch), and the
filtered branch (`bun test {{args}}`) propagates as the if-statement's final command.

### 3. Is ambient `TASKS_FILE` sanitized without breaking tests that intentionally set it? — YES

- `test/setup/global-test-cleanup.ts:109` deletes `process.env["TASKS_FILE"]` **before** the
  env snapshot at line 115, so the per-test `afterEach` restore (lines 119–133) keeps it
  deleted: any test that sets it is cleaned up (key not in snapshot → deleted). The preload
  is wired for every `bun test` run via `bunfig.toml [test] preload`.
- The leak mechanism is real: `src/utils/tasks-file-resolver.ts:123` honors
  `process.env["TASKS_FILE"]` unconditionally.
- Tests that intentionally set it (`tasks-json-startup-smoke.test.ts:224`,
  `worksystem-lanes-projection.test.ts`, `lane-registry-projection.test.ts`) set it inside the
  test and restore with a proper `=== undefined ? delete : assign` guard (no
  `env.X = undefined` → `"undefined"`-string coercion bug). All pass in the full suite.
- New regression guard test "ambient TASKS_FILE is sanitized by the global preload" exists
  and is order-independent (both the file's `afterEach` and the global restore delete the key).
- Counterfactual, against the operator's real registry (67 live tasks in
  `~/.config/ghostty-launcher/tasks.json`):
  - Pre-fix `7101eca3` + `TASKS_FILE` exported → smoke test **1 pass / 8 fail, exit 1**;
    full `just test` → 15 inner failures masked to exit 0 (matches the original review and
    the RESULT artifact exactly).
  - HEAD + same export → smoke test **10 pass / 0 fail, exit 0**; full suite
    **2023 pass / 1 skip / 0 fail, exit 0** — identical to the unexported run. Hermetic.

### 4. Does `just check` pass, and is the Biome drift explanation accurate? — YES on both

- `just check` at HEAD: **exit 0** (Biome ci + tsc + knip-informational).
- Pinning verified: package.json `"@biomejs/biome": "^2.3.1"`, bun.lock resolved **2.3.1**,
  `./node_modules/.bin/biome --version` → 2.3.1. The recipe uses `bunx @biomejs/biome ci`,
  which resolves the locally installed 2.3.1 when node_modules exists and downloads latest
  in an uninstalled worktree — consistent with the drift explanation.
- Drift counterfactual: `bunx @biomejs/biome@2.4.16 ci ./src ./test ./scripts-v2`
  - at pre-fix `7101eca3`: **exit 1, 14 findings** (useOptionalChain + organizeImports —
    the original review's blocker 1, byte-for-byte the same rule families and count);
  - at HEAD: **exit 0, clean** (280 files checked). The code now passes under both the
    pinned and the review's Biome version, so the drift no longer flips the verdict.

### 5. Do focused tests, test validation, and the full suite reproduce green here? — YES

All run at HEAD `806b72f7` in this repo. The RESULT artifact's numbers reproduce exactly.

| Command | Result | Exit |
| --- | --- | --- |
| `bun test test/integration/worksystem-lanes-projection.test.ts` | 10 pass / 0 fail | 0 |
| `just test-validate` | 145 test files, all partitioned, 0 orphaned | 0 |
| `just check` (pinned Biome 2.3.1 + tsc + knip) | clean | 0 |
| `just test` (full suite + quality) | 2023 pass / 1 skip / 0 fail | 0 |
| `env TASKS_FILE=~/.config/ghostty-launcher/tasks.json bun run test` | 2023 pass / 1 skip / 0 fail | 0 |
| `env TASKS_FILE=… bun test test/integration/tasks-json-startup-smoke.test.ts` | 10 pass / 0 fail | 0 |
| `bunx @biomejs/biome@2.4.16 ci ./src ./test ./scripts-v2` (HEAD) | clean, 280 files | 0 |
| Shim proof: `just test` (new recipe) with failing inner suite | failure propagates | 1 |
| Shim proof: old recipe (`7101eca3` justfile) with same failing inner suite | masked | 0 |
| Counterfactual worktree `7101eca3`: ambient smoke test | 1 pass / 8 fail | 1 |
| Counterfactual worktree `7101eca3`: ambient `just test` | 2007 pass / 15 fail, masked | 0 |
| Counterfactual worktree `7101eca3`: Biome 2.4.16 ci | 14 findings | 1 |

The RESULT's arithmetic for the original review env (uninstalled worktree + ambient
TASKS_FILE → 1987 pass / 19 fail / 4 errors) is consistent with what I measured: installed
baseline 2022 non-skip pass; ambient poisoning costs exactly 15 (2022−15 = 2007 here); the
review's additional 4 errors + 4 fails match missing `@vscode/test-electron`/`fast-check`
modules in an uninstalled worktree (both are declared and lockfile-pinned).

### 6. Any blocker before cutting a local RC proof / installed-VSIX UI dogfood? — NO

Non-blocking notes:

- **Gate environments must `bun install` first.** Uninstalled worktrees still produce
  module-not-found failures — but they now fail *loudly* (exit ≠ 0) instead of being masked,
  which is the correct behavior. The installed-VSIX proof harness builds its own child env
  (it sets `TASKS_FILE` explicitly), so the preload sanitization does not affect it.
- **Optional hardening, not required:** `just check` still runs un-versioned
  `bunx @biomejs/biome ci`, so a future Biome (2.5.x+) could reintroduce drift findings in
  uninstalled environments. Pinning the recipe to the lockfile version (or requiring install)
  would close that residual hazard permanently.
- **RESULT's honesty note on one unreproduced flake** (a single 1-fail run, test name not
  captured): I ran the full suite twice (plain + ambient) — both fully green. Not attributable
  or reproducible; worth watching during RC runs but not a blocker.
- `knip` remains informational in `just check` (`|| true`) by long-standing design; `just ci`
  is the strict gate. Pre-existing, not a regression from this fixup.

## Contract reporting

- HEAD: `806b72f799f7892351d156ab1b64fcedb5bd8186`
- Dirty/untracked state: clean apart from this review artifact
  (`research/REVIEW-cc-projection-reader-gate-fixup-20260612.md`); no product code modified;
  throwaway counterfactual worktree removed.
- Review artifact: `research/REVIEW-cc-projection-reader-gate-fixup-20260612.md`
- No push, tag, publish, Linear mutation, or external message was made. The pending-fixup
  JSON in `/tmp/oste-pending-fixup/` was left untouched.

REVIEW COMPLETE — verdict **ACCEPT**
