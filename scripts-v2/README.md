# Scripts Architecture V2 🚀

## Overview

This is the **modular, composable build system** for VS Code extension development. It delivers:
- ⚡ **Sub-second rebuilds** in development
- 📦 **< 10s distribution** to local VS Code
- 🎯 **Clear single-purpose modules**
- 🔥 **Beautiful developer experience**

## Quick Start

```bash
# Development with hot reload
just dev

# Run quality checks and tests
just test

# Build and distribute
just dist
```

**Note**: V2 scripts are now the default via justfile. Use `just` commands for the best experience.

## Architecture

```
scripts-v2/
├── lib/                    # Composable modules
│   ├── compiler.ts        # TypeScript compilation
│   ├── vsix-builder.ts    # VSIX packaging
│   ├── validator.ts       # Pre-flight checks
│   ├── launcher.ts        # VS Code launching
│   ├── logger.ts          # Beautiful output
│   └── config.ts          # Central configuration
│
├── dev.ts                 # Development workflow
├── test-all.ts            # Unified quality + tests
├── dist-simple.ts         # Smart distribution (v6)
└── archive/               # Legacy scripts
    ├── compile.ts         # (replaced by inline builds)
    └── distribute-old-complex.ts  # (replaced by dist-simple.ts)
```

## Commands

### 🔥 Development Mode
```bash
bun run dev:v2 [options]

Options:
  --skip-validate    Skip validation for faster startup
  --no-typecheck     Skip TypeScript type checking
  --inspect=PORT     Set debugger port (default: 9229)
  --verbose          Show detailed output
```

**Features:**
- Launches in < 2 seconds
- Auto-rebuilds on file changes
- Inline source maps for debugging
- Extension Host with inspector

### 📦 Production Compilation
```bash
bun run compile:v2 [options]

Options:
  --skip-tests       Skip test execution
  --skip-validate    Skip validation checks
  --create-vsix      Also create VSIX package
  --verbose          Show detailed output
```

**Features:**
- Full validation and testing
- Minified production bundle
- External source maps
- Bundle size analysis

### 🚀 Quick Distribution
```bash
bun run dist:v2 [options]

Options:
  --keep-vsix        Keep VSIX file after installation
  --production       Use production build
  --no-install       Create VSIX without installing
  --verbose          Show detailed output
```

**Features:**
- < 10 second deployment
- Auto-installs to VS Code
- Temporary VSIX cleanup
- Reload instructions

## Library Modules

### `lib/compiler.ts`
Handles TypeScript compilation with Bun.build
- Development & production modes
- Source map generation
- Watch mode support
- Bundle size tracking

### `lib/vsix-builder.ts`
VSIX package creation and management
- Creates extension packages
- Installs to VS Code
- Verifies package contents
- Cleanup utilities

### `lib/validator.ts`
Pre-flight validation checks
- Syntax validation
- Type checking
- Linting
- Test execution
- Manifest validation

### `lib/launcher.ts`
VS Code Extension Host management
- Launches development host
- Debug port configuration
- Platform-specific commands
- Development tips

### `lib/logger.ts`
Beautiful console output
- Colored output with ANSI codes
- Progress spinners
- Tables and boxes
- Performance timing
- Error formatting

### `lib/config.ts`
Central configuration management
- Default settings
- Path resolution
- Environment detection
- Package metadata

## Performance Benchmarks

| Operation | V2 Time | V1 Time | Improvement |
|-----------|---------|---------|-------------|
| Dev startup | < 2s | ~5s | 2.5x faster |
| Hot rebuild | < 500ms | ~2s | 4x faster |
| Distribution | < 10s | ~20s | 2x faster |
| Production build | < 5s | ~10s | 2x faster |

## Configuration

Add custom configuration to `package.json`:

```json
{
  "scripts-v2": {
    "paths": {
      "entry": "./src/extension.ts",
      "dist": "./dist"
    },
    "development": {
      "sourcemap": "inline",
      "typecheck": true
    },
    "production": {
      "minify": true,
      "runTests": true
    }
  }
}
```

## Migration from V1

The V2 scripts run in parallel with V1 scripts:

```bash
# V1 (existing)
bun run dev
bun run build
bun run install

# V2 (new)
bun run dev:v2
bun run compile:v2
bun run dist:v2
```

## Why V2?

### 🎯 Single Responsibility
Each module does ONE thing well. No more 500-line scripts with mixed concerns.

### ⚡ Performance First
- Bun-native for maximum speed
- Smart caching and incremental builds
- Parallel operations where possible

### 💝 Developer Experience
- Beautiful console output
- Clear error messages
- Progress indicators
- Performance metrics

### 🔧 Composability
- Mix and match modules
- Easy to extend
- Simple to test
- Clean dependencies

## Tips & Tricks

### Fast Development Iteration
```bash
# Skip all checks for maximum speed
bun run dev:v2 --skip-validate --no-typecheck
```

### Production-like Testing
```bash
# Build and distribute with production optimizations
bun run dist:v2 --production
```

### CI/CD Integration
```bash
# Full validation and testing
bun run compile:v2 --create-vsix
```

### Debugging
```bash
# Custom debug port
bun run dev:v2 --inspect=5858 --verbose
```

## Troubleshooting

### "VS Code command not found"
Ensure VS Code is in your PATH:
```bash
# macOS/Linux
code --version

# Windows
code.cmd --version
```

### "VSIX creation failed"
Check that @vscode/vsce is installed:
```bash
bunx @vscode/vsce --version
```

### "Type checking fails"
Ensure TypeScript is configured:
```bash
bunx tsc --version
```

## Contributing

The V2 architecture is designed for extensibility:

1. **Add new lib modules** for shared functionality
2. **Create new user scripts** for workflows
3. **Follow the patterns** established in existing modules
4. **Keep it simple** - one module, one purpose

## Future Enhancements

- [ ] Incremental compilation
- [ ] Bundle splitting for web extensions
- [ ] Performance profiling
- [ ] Remote development support
- [ ] Multi-target builds

---

Built with ❤️ using Bun for lightning-fast VS Code extension development.