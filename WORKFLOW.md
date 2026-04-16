# Development Workflow

Command Central is the **reference implementation** of the cross-project recipe
standard. The contract — what each `just` recipe must do regardless of language
or tooling — lives in `~/projects/config/STANDARDS.md`. This file documents
**how command-central implements** that contract, plus project-specific recipes
(dist, prerelease, sync, etc.).

## The Five Standard Recipes

Every project (this one included) provides these five recipes with identical
semantics:

| Recipe | Purpose | This project's implementation |
|---|---|---|
| `just check` | Read-only validation | `biome ci` + `tsc --noEmit` + `knip` (warnings allowed) |
| `just fix` | Auto-fix lint + format | `biome check --write` |
| `just test` | Run full test suite | `bun run test` (1365 tests, ~5s) + `just test-quality` |
| `just ready` | fix + check + test | One-shot pre-push flow (replaces old `just pre-commit`) |
| `just ci` | Strict, no leniency | `biome ci` + `tsc` + `knip` (strict, fail on warnings) + `bun run test` |

**Aliases:** `t` (test), `f` (fix), `r` (ready).

## Quick Start

```bash
# First time
just install

# Daily development
just dev          # Start with hot reload
just t            # Run tests during dev (~5s)
just r            # Before pushing: fix + check + test

# Distribution
just dist         # Auto-bump patch + build VSIX
just prerelease   # Run cross-repo gate + build prerelease
```

## Project-Specific Recipes

These exist on top of the standard 5 because command-central has unique needs:

```bash
# Distribution
just dist [--patch|--minor|--major|--current|--dry-run|--prerelease]
just prerelease   # Runs prerelease-gate cross-repo check, then builds
just sync-all     # Sync launcher + terminal binaries from dev repos

# Test sub-commands (Tier 3 — names consistent across projects when present)
just test-unit         # Fast unit subset (~0.5s, 459 tests)
just test-integration  # Integration suite + discovery-e2e (isolated process)
just test-watch        # TDD watch mode
just test-coverage     # Coverage report
just test-validate     # Detect orphaned test files
just test-quality      # Anti-pattern check (no `as any`, no skipped, no reflection)
just test list         # Show test organization

# Site (landing page)
just site             # Local dev server
just site-check       # Validate HTML/links/metadata

# Dead-code detection
just knip             # Find unused files / exports / dependencies

# Utilities
just install / add / update / info / clean / dev / debug-filter
```

## What Changed (2026-04-16)

The recipes `verify`, `pre-commit`, and `check-strict` were retired:

| Old | New | Why |
|---|---|---|
| `just verify` | `just ci` (read-only strict) **or** `just ready` (with auto-fix) | Removed — semantics overlapped with both `ci` and `ready`. |
| `just pre-commit` | `just ready` | The name `pre-commit` collides with the [pre-commit framework](https://pre-commit.com) binary on PATH. The `ready` convention matches oxc, biome, and other modern justfiles. |
| `just check-strict` | `just ci` | Folded in — `ci` IS the strict gate by definition. |

The `.pre-commit-config.yaml` continues to call `just check` (unchanged) for
the actual git pre-commit hook. No CI changes required: the GitHub Actions
workflow (`.github/workflows/ci.yml`) calls bun directly, not the renamed
recipes.

## Pre-commit Hooks

This project uses the [pre-commit framework](https://pre-commit.com) (the tool,
not the old recipe). Configuration is in `.pre-commit-config.yaml`. The hook
runs `just check` on commit.

```bash
# Install (once)
pip install pre-commit
pre-commit install

# Run manually
pre-commit run --all-files
```

The optional auto-fix hook (commented out in `.pre-commit-config.yaml`) calls
`just fix`. Uncomment if you want commits auto-formatted.

## Common Workflows

### Daily development
```bash
just dev          # Start dev server
# ... make changes ...
just t            # Run tests
# ... iterate ...
just r            # Before pushing: auto-fix + check + test
git commit
git push
```

### Investigating a regression
```bash
just test-unit    # Fast — does the unit suite pass?
just test         # Full — does anything else break?
just check        # Type/lint clean?
```

### Pre-release
```bash
just prerelease   # Cross-repo gate (runs `just ci` here + check in launcher)
```

### CI (what GitHub Actions does)
GitHub Actions does not invoke `just ci` (it calls bun + biome directly for
incremental control). If you want to reproduce CI locally, run `just ci`.

## Cross-Project Pattern

If you adopt this same five-recipe contract in another project, the developer
muscle memory carries over. See `~/projects/config/STANDARDS.md` for:

- The full recipe contract (what each name must mean)
- Per-language implementation templates (bash, TypeScript, Rust, Python)
- Migration guide for existing projects

## Troubleshooting

| Symptom | Check |
|---|---|
| `just check` slow on first run | Knip's first parse is cold; subsequent runs are fast |
| `just test` fails on tree-provider tests | 7 known stale assertions — see test/README.md |
| `just fix` doesn't fix something | Biome's `--write` only applies safe fixes; manual changes for unsafe |
| `pre-commit install` doesn't work | Need `pip install pre-commit` first (the framework, not the old recipe) |
