# RESULT — cc-worksystem-projection-reader-gate-fixup-20260612

Fixup for the BLOCKED verdict in
`/tmp/command-central-cc-worksystem-projection-reader-20260611-review/research/REVIEW-cc-worksystem-projection-reader-20260611.md`
(pending fixup receipt `/tmp/oste-pending-fixup/cc-worksystem-projection-reader-20260611.json`,
2 blockers, attempt 1).

- Base commit at start: `7101eca3` (= reviewed `f94ec43d` + one docs receipt)
- Fix commit: `db809078` — `fix(gates): make projection-reader verification gates truthful`

## Root-cause diagnosis (both review blockers reproduced exactly)

The review's two blockers were **real observations of a non-hermetic gate
environment**, not defects in the projection-reader feature code:

1. **`just check` failed at the pinned commit (14 Biome errors).**
   The repo lockfile pins Biome **2.3.1** (passes clean). The review worktree
   had no `node_modules`, so `bunx @biomejs/biome ci` downloaded **latest
   (2.4.16)**, whose expanded `useOptionalChain` rule plus `organizeImports`
   assist flag 14 errors in 4 pre-existing files (none in the feature diff).
   Reproduced byte-for-byte here with `bunx @biomejs/biome@2.4.16 ci`:
   13 × `lint/complexity/useOptionalChain` + 1 × `assist/source/organizeImports`.

2. **`just test` exited 0 while the inner suite failed (review: 1987 pass /
   19 fail / 4 errors).** Two independent environmental causes, both
   reproduced, plus one recipe bug:
   - *Recipe masking (real bug, fixed):* the `test` recipe ran
     `bun run test; …; just test-quality;` in one shell `if` — the recipe's
     exit code was the last command's, so inner failures were swallowed.
   - *No `bun install` in the review worktree:* a fresh worktree at HEAD
     without install yields exactly **4 errors + 4 fails**
     (`Cannot find module '@vscode/test-electron'` ×1, `fast-check` ×3 —
     both ARE declared in package.json/bun.lock; they just weren't installed).
   - *Ambient `TASKS_FILE` in the review shell:* the resolver honors
     `process.env["TASKS_FILE"]` unconditionally, and the test preload
     snapshotted/restored it as-is. With
     `TASKS_FILE=~/.config/ghostty-launcher/tasks.json` exported (as in
     launcher-spawned shells), the suite fails with exactly **15 fails** —
     including `tasks-json-startup-smoke.test.ts` ingesting the operator's
     real registry and failing "expected no tasks", precisely as the review
     described.
   - Arithmetic check: 2002 + (−15) = **1987 pass**, 4 + 15 = **19 fail**,
     **4 errors** — the review's numbers exactly. The review environment was
     an uninstalled worktree with ambient `TASKS_FILE`.

## Changes (commit `db809078`)

| File | Change |
| --- | --- |
| `justfile` | `test` recipe: `bun run test \|\| exit 1` so inner suite failure propagates (proven: patched recipe exits 1 in the broken probe env where the old recipe exited 0) |
| `test/setup/global-test-cleanup.ts` | Delete ambient `TASKS_FILE` at preload **before** the env snapshot, so the per-test restore keeps it deleted; tests that need the override still set it explicitly |
| `test/integration/tasks-json-startup-smoke.test.ts` | New regression guard test "ambient TASKS_FILE is sanitized by the global preload" pinning the hermeticity contract |
| `src/utils/openclaw-gateway-health.ts` | `useOptionalChain` fix (semantically equivalent) |
| `test/tree-view/agent-status-dead-process-running.test.ts` | `useOptionalChain` fix |
| `test/tree-view/openclaw-task-nodes.test.ts` | 11 × `useOptionalChain` fixes |
| `test/tree-view/_helpers/agent-status-tree-provider-test-base.ts` | `organizeImports` ordering fix |

Projection-reader feature code (`b1803349`) is untouched: no changes under
`src/` except the one-line optional-chain rewrite in
`openclaw-gateway-health.ts`, which is outside the feature slice.

## Gates run (all at `db809078`, main repo, deps installed)

| Gate | Result |
| --- | --- |
| `bun test test/integration/worksystem-lanes-projection.test.ts` | exit 0 — 10 pass / 0 fail |
| `just test-validate` | exit 0 — 145 test files partitioned, 0 orphaned |
| `just check` (pinned Biome 2.3.1 + tsc + knip) | exit 0 — clean |
| `bunx @biomejs/biome@2.4.16 ci ./src ./test ./scripts-v2` | exit 0 — clean (review's failing version now passes) |
| `bunx tsc --noEmit` | exit 0 |
| `just test` (full suite + quality) | exit 0 — 2023 pass / 1 skip / 0 fail |
| `env TASKS_FILE=~/.config/ghostty-launcher/tasks.json bun run test` | exit 0 — 2023 pass / 0 fail (was 2007 pass / 15 fail before fix) |
| `env TASKS_FILE=… bun test test/integration/tasks-json-startup-smoke.test.ts` | exit 0 — 10 pass (was 1 pass / 8 fail) |
| Masking-fix proof: patched `just test` in uninstalled probe worktree | exit 1 (old recipe: exit 0) — failure now propagates |
| `just fix` before commit | no changes needed; pre-commit Biome hook passed |

## Residual blockers / caveats

- **Gate environments must run `bun install` first.** All inner-suite module
  errors the review saw (`@vscode/test-electron`, `fast-check`) come from
  running the suite in an uninstalled worktree; both deps are declared and
  lockfile-pinned. With node_modules present, `bunx @biomejs/biome` also
  resolves the lockfile-pinned 2.3.1 instead of downloading latest. The code
  now additionally passes under latest (2.4.16), so the Biome-version drift
  no longer changes the verdict either way.
- **One unreproduced flake:** a single full-suite run early in this session
  showed 1 fail (2021 pass) with `TASKS_FILE` unset; 8 subsequent runs
  (6 plain + 2 ambient-env) all passed and the failing test name was not
  captured. Not attributable to this slice; noting for honesty.
- No push/tag/publish/Linear mutations were made. The pending-fixup JSON in
  `/tmp/oste-pending-fixup/` was left untouched (launcher-owned).

## Pending fixup status

**Cleared from this side.** Both review blockers are addressed at the root:
`just check` is green under both the pinned and the review's Biome version,
and `just test` can no longer report success while the inner suite fails —
verified in the exact environment shape that produced the false verdict.
The projection-reader slice is truthfully gateable for the next
installed-VSIX/UI process test: re-run `bun install && just check && just
test` (or the focused `worksystem-lanes-projection` suite) in any fresh
worktree; results are now deterministic regardless of ambient `TASKS_FILE`.
