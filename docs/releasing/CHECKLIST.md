# Pre-Release Checklist

Use this checklist before running `just dist`.

## Code Quality

- [ ] `just check` passes (Biome CI + TypeScript + Knip)
- [ ] `just test` passes (all 624+ tests)
- [ ] `just test-quality` passes (no type assertions, no skipped tests)
- [ ] No console warnings or errors in Extension Host

## Launcher Sync

- [ ] `just sync-launcher` run (syncs from development repo)
- [ ] `diff resources/bin/ghostty-launcher ~/ghostty-dock-launcher-v1/ghostty` shows no differences
- [ ] `.launcher-version` file updated

## Documentation

- [ ] CHANGELOG.md updated with version and date
- [ ] Breaking changes documented
- [ ] New features documented in README if user-facing
- [ ] Migration notes if needed

## Testing

- [ ] Extension activates without errors
- [ ] Core commands work in Command Palette
- [ ] Settings validate correctly
- [ ] Platform detection works (macOS vs others)

## Bundle

- [ ] `just dist --dry-run` shows expected version
- [ ] Bundle size reasonable (~25KB production)
- [ ] No sensitive files included (check .vscodeignore)

## Post-Build

- [ ] Extension loads in VS Code
- [ ] Commands appear in Command Palette
- [ ] No errors in Extension Host console
- [ ] Quick smoke test of key features

## Release

- [ ] Version committed
- [ ] Tag created (for significant releases)
- [ ] CHANGELOG reflects actual changes

---

## Quick Commands

```bash
# Validation sequence
just check && just test

# Sync launcher
just sync-launcher

# Preview release
just dist --dry-run

# Build release
just dist            # patch (default)
just dist --minor    # minor version
just dist --major    # major version
```

## Common Issues

### Knip warnings blocking
```bash
# Development mode (warnings only)
just check

# CI mode (strict)
just check-strict
```

### Launcher out of sync
```bash
just sync-launcher
git diff resources/bin/  # Review changes
```

### Tests failing
```bash
bun test --watch  # Fix in watch mode
just test-quality # Check for anti-patterns
```

### Bundle too large
Check `.vscodeignore` excludes:
- `src/**` (only dist included)
- `test/**`
- `*.md` (except README)
- `node_modules/**`
