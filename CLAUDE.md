# CLAUDE.md — Command Central

> This file helps AI coding assistants understand and contribute to this project.
> It follows the [CLAUDE.md convention](https://docs.anthropic.com/en/docs/claude-code/memory#claudemd) for providing project context to AI tools.

## Overview

**Command Central** is a VS Code extension built with **Bun** as the exclusive toolchain. This approach delivers significantly faster builds, tests, and packaging compared to traditional webpack/npm setups.

```yaml
---
globs: "*.ts, *.tsx, *.js, *.jsx, package.json, tsconfig.json, bunfig.toml, .vscode/*.json"
alwaysApply: true
---
```

## Quick Start

```bash
# Prerequisites
code --version    # ≥1.100.0 (ESM support)
bun --version     # ≥1.3.0

# Install dependencies
bun install

# Core workflow
bun dev           # Development with hot reload
bun test          # Typecheck + all tests
bun dist          # Smart version-aware distribution
```

## Project Structure

```
src/
  commands/       # VS Code command implementations
  providers/      # Webview and tree providers
  services/       # Core services (ProcessManager, Logger, etc.)
  utils/          # Shared utilities
  types/          # TypeScript type definitions
  webview/        # Webview UI code
  test/           # Unit tests
scripts/          # Build, dev, and distribution scripts
resources/        # Static assets
dist/             # Build output (gitignored)
releases/         # VSIX packages
.vscode/          # Editor configuration
```

## Five Commandments

These are **non-negotiable** for this project:

1. **ALWAYS use `--extensionDevelopmentPath`** — never symlink or copy into `~/.vscode/extensions/`
2. **ALWAYS use Bun exclusively** — no npm, yarn, or webpack
3. **ALWAYS package as VSIX** — `bunx @vscode/vsce package`
4. **NEVER bundle the `vscode` module** — it must stay in `external: ['vscode']`
5. **NEVER skip type checking** — `tsc --noEmit` runs before every build

## Commands Reference

```bash
# Development
bun dev                              # Dev server with hot reload
bun run build                        # Production build
bun run typecheck                    # TypeScript type checking

# Testing
bun test                             # Run all tests

# Code Quality
bun run check                        # Biome lint + format check
bun run check:fix                    # Auto-fix lint + format issues
bun run lint                         # Lint only
bun run format                       # Format only

# Distribution
bun dist                             # Build (skips prod if version exists)
bun dist --patch                     # Bump patch version and build
bun dist --minor                     # Bump minor version and build
bun dist --major                     # Bump major version and build
bun dist --dry-run                   # Preview without building

# Installing locally
code --install-extension releases/command-central-X.X.X.vsix
```

## Architecture & Conventions

### Build System
- **Entry point:** `src/extension.ts` (ESM with top-level await)
- **Build tool:** `Bun.build()` via `scripts/build.ts`
- **Output:** `dist/` directory, ESM format, targeting Node
- **External:** `vscode` is always external — never bundled

### Code Style
- **Biome** for linting and formatting (configured in `biome.json`)
- **Strict TypeScript** — `strict: true` in tsconfig
- **ESM only** — use `import`, never `require()`
- **`.js` extensions** in import paths (ESM requirement)

### Testing
- **Bun's built-in test runner** (`bun:test`)
- Mock the `vscode` module in unit tests via `mock.module("vscode", ...)`
- Integration tests use `--extensionDevelopmentPath` with VS Code test runner

### Key Patterns
- **Lazy loading:** Commands use dynamic `import()` for fast activation
- **Webview CSP:** Always use nonces for Content Security Policy
- **AbortController:** For timeout handling and cancellation
- **Exponential backoff:** For retry logic on transient failures

### Distribution
The `bun dist` command implements smart version management:
1. Checks `package.json` version (source of truth)
2. Detects existing releases to avoid duplicate builds
3. Manages release archive (keeps last 3 by default)
4. Wraps `npm version` for standards-compliant bumping

## Contributing with AI Tools

This project is designed to work well with AI coding assistants. Here's how:

1. **Read this file first** — it gives you the full project context
2. **Run `bun test` before and after changes** — it catches type errors and test failures
3. **Run `bun run check` for style** — Biome enforces consistent formatting
4. **Follow the Five Commandments** — they exist because the alternatives break things
5. **Check `package.json`** for the full list of available scripts

### Pre-Flight Checklist

Before submitting changes:

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun run check` passes (no lint/format issues)
- [ ] Build succeeds: `bun run build`
- [ ] All imports use `.js` extension
- [ ] `external: ['vscode']` preserved in build config
- [ ] Bundle size reasonable (VSIX should be < 100KB)

## Troubleshooting

| Problem | Check |
|---------|-------|
| Extension won't load | Is VS Code launched with `--extensionDevelopmentPath`? |
| Type errors | Does `@types/vscode` match `engines.vscode`? |
| Build failures | Is `external: ['vscode']` set? |
| Test failures | Do mocks match the VS Code API surface? |
| Import errors | Are `.js` extensions on all import paths? |

## CI

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run typecheck
      - run: bun test
      - run: bun run build
      - run: bun run package
```
