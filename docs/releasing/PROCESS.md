# Release Process

## Overview

This document describes the release workflow for Command Central VS Code extension.

## Release Trust Boundary: Local (Tier 1) vs Public (Tier 2)

Release work splits into two trust tiers. Everything in **Tier 1** is local and
reversible; everything in **Tier 2** is public, hard to unwind, and requires
**explicit partner approval** before it runs.

| Tier | Actions | Approval | Recipes / scripts |
|---|---|---|---|
| **Tier 1 — Local** | build, package (VSIX), install into VS Code, dry-runs, gates | None — run freely | `just dist`, `just dist --dry-run`, `just prerelease`, `just prerelease-gate`, `just sync-launcher`, `code --install-extension`, `./scripts/release.sh --dry-run <version>` |
| **Tier 2 — Public / partner approval** | `git push`, push a `git tag`, GitHub release, Marketplace publish | **Explicit partner approval required** | `git push origin main --tags`, `bunx @vscode/vsce publish`, `./scripts/release.sh <version>` (commits + tags **locally**) |

`just dist` never tags or pushes — it bumps the version with
`npm version … --no-git-tag-version` and writes a VSIX under `releases/`. Tagging,
pushing, and Marketplace publish are always operator-driven Tier 2 steps.

Do **not** run a Tier 2 action without explicit approval. See `CLAUDE.md` ("Do not
push, tag, publish, or use `--no-verify` without explicit approval") and the
`cut-preview` skill.

### Split-identity & push-target guardrails (CCSTD-05)

Command Central and `ghostty-launcher` are a **split identity**: two repos, two
GitHub remotes (`ostehost/command-central` vs `ostehost/ghostty-launcher`). A
mis-set `origin` — a fork, the sibling repo, or the wrong checkout — could tag or
push a release into the wrong repository. Two **non-destructive** guardrails assert
the push target *before* any tag/commit:

- **`scripts/release.sh`** runs `assert_push_target_identity` before any mutation:
  it normalizes `git remote get-url $PUSH_REMOTE` (default `origin`) and the
  `repository` field in `package.json` to an `owner/repo` slug and `exit 1`s on
  mismatch or an unparseable remote. It never pushes or tags on its own — it only
  commits + tags **locally** and prints the push command for an operator. Preview
  it with `./scripts/release.sh --dry-run <version>` (asserts identity, mutates
  nothing). Override the remote with `PUSH_REMOTE=<name>`.
- **`just prerelease-gate --require-push-target [--push-remote <name>]`** adds the
  same check to the cross-repo hard gate (as a `release push-target identity`
  record). It is **opt-in** so default CI / `just cut-preview` keep passing; when
  enabled a wrong target hard-blocks the gate before any publish path.

Expected healthy output:
`✅ Push-target identity OK: origin → ostehost/command-central matches package.json`.

## Release Types

| Type | Version | Example | When to Use |
|------|---------|---------|-------------|
| Patch | X.X.+1 | 1.2.3 → 1.2.4 | Bug fixes, small improvements |
| Minor | X.+1.0 | 1.2.3 → 1.3.0 | New features, backward-compatible |
| Major | +1.0.0 | 1.2.3 → 2.0.0 | Breaking changes |

## Quick Release

```bash
# Standard patch release (most common)
just dist

# Partner prerelease (runs hard gate before build)
just prerelease

# With version bump options
just dist --minor      # Bump minor version
just dist --major      # Bump major version
just dist --current    # Use current version (no bump)
just dist --dry-run    # Preview without building
```

## Pre-Release Checklist

Before running `just dist`:

### 1. Code Quality
```bash
just check              # Lint, typecheck, dead code detection
just test               # Full test suite (624 tests)
just prerelease-gate    # Cross-repo hard gate + provenance artifact
```

### 2. Launcher Sync
```bash
just sync-launcher      # Sync from development repo
# The dist command will warn if out of sync
```

### 3. Documentation
- [ ] CHANGELOG.md updated with changes
- [ ] README.md reflects new features
- [ ] Breaking changes documented

### 4. Version Planning
- Decide on patch/minor/major based on changes
- Theme name (optional, for significant releases)

## Release Workflow

### Step 1: Validate

```bash
# Run strict validation (warnings = errors)
just ci

# Expected output:
# ✅ Biome CI passed
# ✅ TypeScript compiled
# ✅ Knip strict passed
# ✅ 1365 tests passed
# ✅ No test quality issues
```

### Step 2: Build Distribution

```bash
# Build with patch version bump (default)
just dist

# Build prerelease only after gate passes
just prerelease

# Or specify version type
just dist --minor
```

The dist command:
1. Checks launcher sync status (warns if needed)
2. Bumps version via npm version
3. Builds production VSIX
4. Installs in VS Code for testing
5. Archives release

`just prerelease-gate` hard-fails on:
- `just ci` in Command Central
- `just check` in `~/projects/ghostty-launcher`
- launcher CLI contract drift (`--session-id` and required flags)
- provenance artifact generation

Gate artifact output:
- `research/prerelease-gate/latest.json`
- `research/prerelease-gate/prerelease-gate-<timestamp>.json`

### Step 3: Test Installation

After `just dist`, prove the normal VS Code profile has the new version before calling the candidate consumable:

```bash
just verify-vscode-consumption \
  --vsix releases/command-central-<version>.vsix \
  --expected-version <version> \
  --manifest-out research/prerelease-gate/vscode-consumption-<version>.json
```

Then reload VS Code and smoke the installed extension:
- Open Command Palette
- Run `Developer: Reload Window`
- Run extension commands
- Verify key functionality

For MacBook node dogfood, run the same command on the node against `/Users/ostehost/.vscode/extensions`; the receipt must show the exact expected version before reporting a prerelease as installed for consumption.

### Step 4: Commit

```bash
# Stage changes (package.json, CHANGELOG.md, etc.)
git add -p

# Commit with version
git commit -m "Release v1.2.4: Brief description"
```

### Step 5: Tag (Optional) — 🔒 Tier 2 (partner approval)

Tagging and pushing a tag are **Tier 2** actions — get explicit partner approval
first (see the [Release Trust Boundary](#release-trust-boundary-local-tier-1-vs-public-tier-2)).
Prefer `./scripts/release.sh <version>`, which asserts push-target identity before
it commits + tags locally, then prints the push command for the operator to run.

For a manual tag on a significant release (only after approval):
```bash
git tag -a v1.2.4 -m "v1.2.4: Release theme"
git push origin v1.2.4   # Tier 2 — do not run without approval
```

## Distribution Structure

```
releases/
├── command-central-1.2.3.vsix       # Production VSIX
├── command-central-1.2.4.vsix       # Latest release
└── command-central-1.2.4.vsix.dev   # Development build
```

The dist script keeps the last 3 releases and cleans older versions.

## Version-Aware Builds

The `just dist` command is smart about version management:

| Scenario | Action |
|----------|--------|
| Version exists | Builds dev only, skips prod |
| New version | Builds both dev and prod |
| `--patch/--minor/--major` | Bumps version, builds both |

This prevents accidentally overwriting release artifacts.

## Publishing to Marketplace — 🔒 Tier 2 (partner approval)

Marketplace publish is a **Tier 2** action — it is public and effectively
irreversible. Get **explicit partner approval** before running any `vsce publish`
(see the [Release Trust Boundary](#release-trust-boundary-local-tier-1-vs-public-tier-2)).
Building and installing the VSIX locally (`just dist`,
`code --install-extension`) stays Tier 1 and needs no approval.

When approved for public release:

```bash
# Publish specific version
bunx @vscode/vsce publish --packagePath releases/command-central-1.2.4.vsix

# Or publish latest
bunx @vscode/vsce publish
```

Requirements:
- Azure DevOps Personal Access Token
- Publisher account on VS Code Marketplace
- **Explicit partner approval** for this Tier 2 action

## Rollback

If a release has issues:

```bash
# Revert to previous version
code --install-extension releases/command-central-1.2.3.vsix

# Fix issues and release new patch
just dist  # Creates 1.2.5
```

## Release Themes

For significant releases, consider a theme name:

| Version | Theme | Focus |
|---------|-------|-------|
| 1.1.0 | "Foundation" | Core infrastructure |
| 1.2.0 | "Quality" | Test coverage, bug fixes |
| 1.3.0 | "Integration" | New integrations |
| 2.0.0 | "Reimagined" | Major architecture changes |

Include in commit message and CHANGELOG.

## Metrics to Track

Each release should note:

- Test count and pass rate
- Bundle size (VSIX ~25KB production)
- Performance benchmarks
- Breaking changes (if any)

## Related Documentation

- [CHECKLIST.md](./CHECKLIST.md) - Pre-release checklist
- [CHANGELOG.md](../../CHANGELOG.md) - Version history
- [Launcher Sync](../launcher/ARCHITECTURE.md#sync-process) - Launcher sync process
