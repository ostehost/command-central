# RESULT — Command Central knip/dependency analysis scope hardening

- **Task:** `cc-knip-analysis-scope-fable-20260610`
- **Date:** 2026-06-10
- **Start HEAD:** `4477b628` (clean tree, rc53 cut)
- **Baseline:** `bunx knip` exit 0 before changes (clean, but with the blind spots below)

## Findings

### 1. `playwright` ignore was masking a real, detectable usage
`knip.json` force-ignored `playwright` via `ignoreDependencies`, but the dependency has a
genuine static consumer: `scripts/svg-to-png.ts` (`import { chromium } from "playwright"`).
The ignore existed only because `scripts/**` was outside knip's `entry`/`project` scope, so
knip could not see the import. There is also a second consumer knip can never see: the
justfile `site-screenshot` recipe shells out to `bun x playwright screenshot`.

### 2. Legacy `scripts/**` was invisible to analysis
`scripts/` contains one TypeScript file (`svg-to-png.ts`, a CLI entry run via
`bun run scripts/svg-to-png.ts`) plus three shell scripts (`install-hooks.sh`,
`release.sh`, `site-check.sh` — outside knip's domain). The TS file was in no
analysis scope at all.

### 3. Shadowed duplicate config: `knip.config.ts` was dead
The repo carried **two** knip configs. Knip's config resolution prefers `knip.json`,
confirmed via `bunx knip --debug` (`configFilePath: .../knip.json`). `knip.config.ts` was
never loaded, was referenced by nothing in the repo, and its contents had drifted from the
live config (it still documented `scripts/**` as ignored and carried its own
`ignoreDependencies` rationale). Misleading dead config — removed.

## Changes

| File | Change |
| --- | --- |
| `knip.json` | Added `scripts/**/*.ts` to `entry` (CLI scripts are roots, not imports) and to `project`; removed `playwright` from `ignoreDependencies` (now detected via the real import) |
| `knip.config.ts` | Deleted — shadowed by `knip.json`, never loaded by knip, content stale |
| `research/RESULT-cc-knip-analysis-scope-fable-20260610.md` | This receipt |

Kept as-is: the `@biomejs/biome` ignore is legitimate — biome is invoked only from the
justfile (`bunx @biomejs/biome ci …`), which knip cannot parse, and no `package.json`
script references it.

## Verification

- `bunx knip` (strict, same invocation as `just ci`): **exit 0** with widened scope and
  no playwright ignore — confirming knip now resolves `playwright` as used through
  `scripts/svg-to-png.ts`. `--debug` shows the file in the analyzed set.
- `just check` (biome ci + tsc + knip): ✅ passes.
- `just test`: **1767 pass / 0 fail** (1768 tests, 125 files, ~12s).

## Dependency follow-up (recommendation, no action taken)

`playwright` (~50MB installed + on-demand browser downloads) remains the heaviest
devDependency, held by two marketing/site tooling paths: `scripts/svg-to-png.ts`
(icon/hero PNG generation; outputs are committed) and `just site-screenshot`. It is now
honestly tracked rather than force-ignored, so if `svg-to-png.ts` is ever retired, knip
will flag the dependency as unused automatically. Removal today is **not** recommended:
both consumers are real, and the dependency never ships in the VSIX (runtime
`dependencies` is empty). If install weight matters later, the candidate move is retiring
`svg-to-png.ts` + `site-screenshot` together and dropping `playwright` in the same change.
