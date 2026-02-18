# Release Process

## Overview

This document describes the release workflow for Command Central VS Code extension.

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
# Run complete validation
just verify

# Expected output:
# ✅ Biome CI passed
# ✅ TypeScript compiled
# ✅ 624 tests passed
# ✅ No test quality issues
```

### Step 2: Build Distribution

```bash
# Build with patch version bump (default)
just dist

# Or specify version type
just dist --minor
```

The dist command:
1. Checks launcher sync status (warns if needed)
2. Runs validation (check + test)
3. Bumps version via npm version
4. Builds production VSIX
5. Installs in VS Code for testing
6. Archives release

### Step 3: Test Installation

After `just dist`, VS Code should have the new version:
- Open Command Palette
- Run extension commands
- Verify key functionality

### Step 4: Commit

```bash
# Stage changes (package.json, CHANGELOG.md, etc.)
git add -p

# Commit with version
git commit -m "Release v1.2.4: Brief description"
```

### Step 5: Tag (Optional)

For significant releases:
```bash
git tag -a v1.2.4 -m "v1.2.4: Release theme"
git push origin v1.2.4
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

## Publishing to Marketplace

When ready for public release:

```bash
# Publish specific version
bunx @vscode/vsce publish --packagePath releases/command-central-1.2.4.vsix

# Or publish latest
bunx @vscode/vsce publish
```

Requirements:
- Azure DevOps Personal Access Token
- Publisher account on VS Code Marketplace

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
