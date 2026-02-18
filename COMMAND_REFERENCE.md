# Command Reference

## Overview

This document provides a complete reference for all npm scripts in the Command Central VS Code extension.

## Primary Commands

These are the main commands you should use:

| Command | Purpose | Time | Use Case |
|---------|---------|------|----------|
| `bun run dev` | Start development with hot reload | < 2s | Active development |
| `bun run test` | Run all tests (partitioned) | < 3s | Verify changes |
| `bun run check` | Run all quality checks | < 1s | Pre-commit validation |
| `bun run build` | Production build with validation | < 4s | Create optimized build |
| `bun run dist` | Create/install VSIX package | < 10s | Testing & distribution |

## Complete Command Reference

### Core Development Commands
```bash
bun run dev          # Start development mode with hot reload
bun run test         # Run all tests (partitioned)
bun run check        # Run quality checks (format, lint, typecheck)
bun run build        # Production build with minification
bun run dist         # Quick install to local VS Code (default)
bun run dist --production --keep-vsix  # Create production VSIX for team
```

### Code Quality Commands
```bash
bun run format       # Check formatting
bun run format:fix   # Auto-fix formatting
bun run lint         # Check linting
bun run lint:fix     # Auto-fix linting
bun run typecheck    # TypeScript checking
bun run check:fix    # Fix all auto-fixable issues
```

### Test Commands
```bash
bun run test         # Run all tests (partitioned)
bun run test:git1    # Git sort integration tests
bun run test:git2    # Git sort provider tests
bun run test:git3    # Git timestamps tests
bun run test:git4    # Circuit breaker & SCM tests
bun run test:core    # Core services and utilities
bun run test:watch   # Watch mode for tests
bun run test:security # Security-specific tests
```

### Utility Commands
```bash
bun run package      # Create VSIX package
bun run precommit    # Auto-fix and test before commit
```

## Package.json Organization

The scripts section is organized in priority order:

1. **Primary Commands** (lines 224-228): Core development and distribution commands
2. **Code Quality** (lines 230-236): Formatting, linting, type checking  
3. **Test Commands** (lines 237-242): Partitioned tests for mock isolation
4. **Packaging** (lines 242-243): VSIX creation and pre-package hooks

## Best Practices

1. **Run checks before committing**: `bun run precommit`
2. **Use partitioned tests**: Always `bun run test`, never `bun test`
3. **Quick iteration**: `bun run dev` for development
4. **Fast distribution**: `bun run dist` for local testing
5. **Quality first**: `bun run check` before pushing

## Architecture

The extension uses the V2 build architecture (`scripts-v2/`) which provides:
- **Fast builds**: < 4s production builds
- **Comprehensive validation**: Pre-flight checks
- **Modular design**: Separated concerns in `scripts-v2/lib/`
- **Beautiful CLI**: Professional output with progress indicators
- **Hot reload**: Sub-2 second development startup