# Development Workflow

**The Authoritative Guide** - All other workflow documents have been archived.

## The Essential Commands

```bash
# Setup & Development
just install    # First time: Install dependencies from bun.lock
just add        # Add new package (e.g., just add zod)
just dev        # Development with hot reload & file watching

# Code Quality (Cross-Project Pattern)
just check        # Comprehensive validation (warnings don't block)
just check-strict # Strict validation (for CI - warnings block)
just fix          # Auto-fix formatting and linting issues
just test         # Run all tests + quality gates (593 tests, ~7-8s)
just verify       # Complete validation + tests (check + test)
just ci           # CI/CD workflow (check-strict + test)
just pre-commit   # Developer workflow (fix + verify)

# Distribution
just dist       # Build distribution (smart version-aware builds)
```

**Note:** Run `just` to see all available commands. The above shows the most commonly used.

**First time?** Run `just install` once to install dependencies.

**Cross-Project Pattern**: The `check → fix → test → verify` workflow works identically across TypeScript, Python, and other language projects.

---

## First Time Setup

**New to this project? Follow these steps:**

```bash
# 1. Clone the repository
git clone <repo-url>
cd vs-code-extension-bun

# 2. Install dependencies
just install
# Installs packages from bun.lock (committed to version control)

# 3. Start developing
just dev
```

**When to reinstall:**
- ✅ After `git pull` if `bun.lock` changed
- ✅ If you see "module not found" errors
- ✅ After switching branches with different dependencies

**Adding dependencies:**
```bash
just add <package-name>    # Adds and updates bun.lock
```

**Updating dependencies (Bun 1.3+):**
```bash
just update                # Interactive updates with preview
just info <package-name>   # Show package information
```

**Lock file:**
- `bun.lock` is committed to git (ensures team uses same versions)
- Never delete it (Bun uses it to guarantee reproducible installs)

---

## Quick Start

```bash
# 1. Start developing (once per session)
just dev
# Make changes → Save → Auto-rebuild → Press Cmd+R to reload → Test

# 2. Before committing (NEW: improved workflow)
just pre-commit
# Auto-fixes → Validates → Tests → Ready!

# Alternative: Manual control
just fix        # Auto-fix issues
just verify     # Validate + test

# 3. Share with team (creates new release if version changed)
just dist
# Or bump version and release in one command:
just dist --patch
```

---

## Code Quality Commands

**Cross-Project Pattern**: These commands follow a standard pattern that works identically across TypeScript, Python, Rust, and other languages. Same names, same purposes, consistent behavior.

### `just check` - Development-Friendly Validation
Read-only validation that shows warnings but doesn't block:

```bash
just check
# Output:
# 🔍 Running comprehensive validation...
#    • Code quality (Biome CI - read-only)
#    • Type checking
#    • Dead code detection (Knip)
# Unused exports (1)
# SortedGitChangesProviderImpl  src/git-sort/sorted-changes-provider.ts:2416:37
# ✅ Checks complete!
# 💡 Knip warnings are informational. Run 'just ci' for strict validation.
```

**What it does:**
- **Code quality**: Format and lint checks (using `biome ci` for CI optimization)
- **Type checking**: TypeScript validation (BLOCKS on errors)
- **Dead code**: Detects unused files, exports, and dependencies (WARNS only)

**Philosophy:**
- **Warnings don't block**: Knip can have false positives (e.g., re-exports under different names)
- **Errors block**: Real issues (type errors, syntax errors) fail immediately
- **Developer-friendly**: Shows issues without disrupting flow

**Use cases:**
- Local development workflow
- Pre-commit validation (informational)
- Pre-commit validation
- Preview issues before fixing

### `just fix` - Auto-Fix Issues
Automatically fix formatting and linting issues:

```bash
just fix
# Output:
# 🔧 Auto-fixing code quality issues...
#    • Formatting and linting (src, test, scripts)...
# ✅ All fixable issues resolved!
# 💡 Run 'just check' to verify remaining issues
```

**What it does:**
- Auto-format code (Biome)
- Fix safe linting issues (Biome)
- Does NOT include `knip --fix` (requires manual review)

**Use cases:**
- Fix code style before committing
- Clean up after refactoring
- Prepare code for review

### `just check-strict` - Strict Validation (CI Mode)
Zero-tolerance validation for CI/CD pipelines:

```bash
just check-strict
# Output:
# 🔍 Running strict validation (CI mode)...
#    • Code quality (Biome CI - read-only)
#    • Type checking
#    • Dead code detection (Knip - strict)
# error: Unused exports (1)
# SortedGitChangesProviderImpl  src/git-sort/sorted-changes-provider.ts:2416:37
# [EXIT CODE 1]
```

**What it does:**
- Same as `just check` but Knip warnings BLOCK (exit 1)
- Use in CI/CD to enforce zero dead code
- Catches real issues before merge

**Use cases:**
- CI/CD pipelines (strict enforcement)
- Pre-release validation
- When you want to enforce zero warnings

### `just ci` - CI/CD Workflow
Complete CI/CD workflow with strict validation:

```bash
just ci
# Output:
# 🚀 CI/CD Pipeline...
# [runs check-strict]
# [runs test]
# ✅ CI checks passed!
```

**What it does:**
- Runs `just check-strict` (strict validation)
- Runs `just test` (all tests)
- Blocks on ANY issue (warnings or errors)

**Use cases:**
- CI/CD pipelines (.github/workflows/ci.yml)
- Pre-merge validation
- Release gates

### `just verify` - Complete Validation + Testing
Development-friendly validation and tests:

```bash
just verify
# Output:
# ✨ Running complete verification...
# [runs check]
# [runs test]
# ✅ All checks passed, ready to commit!
```

**What it does:**
- Runs `just check` (warnings don't block)
- Runs `just test` (all tests)
- Developer-friendly pre-commit check

**Use cases:**
- Local pre-commit validation
- Final check before push
- Quick verification during development

### `just pre-commit` - NEW: Developer Workflow
One-command pre-commit workflow:

```bash
just pre-commit
# Output:
# 🚀 Pre-commit workflow...
# [runs fix]
# [runs verify]
```

**What it does:**
- Runs `just fix` (auto-fix issues)
- Runs `just verify` (validate + test)
- Complete workflow in one command

**Use cases:**
- Quick pre-commit workflow
- Daily development
- Before creating PRs

### `just knip` - Dead Code Detection

Find unused files, exports, and dependencies:

```bash
# Quick analysis (finds unused files, exports, dependencies)
just knip

# Detailed report with full paths and line numbers
just knip-verbose

# Focus on specific categories
just knip-files      # Only unused files
just knip-deps       # Only unused dependencies
just knip-exports    # Only unused exports

# Auto-fix safe issues (review with git diff after)
just knip-fix
```

**What it detects:**
- **Unused files** - Entire source files with no imports
- **Unused exports** - Functions/classes exported but never imported
- **Unused dependencies** - Packages in package.json not used in code
- **Duplicate exports** - Same name exported multiple times
- **Unresolved imports** - Broken import statements (bugs!)

**Use cases:**
- Before major refactors - identify cleanup opportunities
- Weekly maintenance - keep codebase lean
- Before releases - reduce bundle size
- Dependency audits - remove unused packages

**Example output:**
```
Unused files (5)
src/security/constants.ts
src/utils/performance.ts

Unused exports (4)
SharedProviderFactory  class  src/factories/provider-factory.ts:76:14

Unused dependencies (1)
old-package
```

**How to use findings:**
1. **Unresolved imports** → Fix immediately (these are bugs)
2. **Unused dependencies** → Safe to remove with `bun remove <pkg>`
3. **Unused exports** → Verify not part of API, then remove export keyword
4. **Unused files** → Check git history before deleting

**Configuration:**
- Config file: `knip.config.ts`
- Initial findings: `knip-initial-findings.txt`
- Ignores: archive/, scripts/, test fixtures

**Known limitations:**
- May flag dynamic imports as unused
- Template-based patterns (slot1-slot10) may appear unused
- SQLite adapters may appear unused (dynamically loaded)

---

## Cleanup & Safety

### `just clean` - The Safe Reset

The single source of truth for all destructive operations. **All `rm` commands must live here.**

```bash
just clean
# Output:
# 🧹 Cleaning build artifacts...
# ✅ Clean complete
```

**What it removes:**
- `dist/` - Build output
- `*.vsix` - Development packages
- `releases/*.vsix.dev` - Development releases

**Why this matters:**

1. **Safety** - Destructive operations are isolated and explicit
2. **Discoverability** - One command to clean everything
3. **Consistency** - Works identically across all projects (Python, TypeScript, etc.)
4. **Prevention** - No scattered `rm` commands in scripts that could cause accidents

**When to use:**
- ✅ After failed builds to clear corrupted artifacts
- ✅ Before fresh builds when debugging build issues
- ✅ To free up disk space
- ✅ When switching between major feature branches

**The Rule:** If a script needs to delete something, it should tell the user to run `just clean` instead. No direct `rm` commands in build scripts.

---

## 1. Development Mode (`just dev`)

### What It Does
- Builds the extension
- Launches VS Code Extension Development Host  
- Watches for file changes
- Auto-rebuilds on save
- Opens debug port 9229

### File Watching Details

| Location | File Types | Auto-Rebuild | Notes |
|----------|------------|--------------|-------|
| `./src` | `*.ts` | ✅ Automatic | Save triggers rebuild |
| `./package.json` | - | ⚠️ Manual | Touch any `src/*.ts` to trigger |
| `./scripts` | `*.ts` | ❌ No | Restart dev server |

### How to Use

```bash
# Start once per session
just dev

# Edit src/extension.ts
# Terminal shows: 📝 Changed: extension.ts
# Terminal shows: ✅ Rebuild successful
# Press Cmd+R in Extension Development Host
# Test your changes
```

### Package.json Changes

Since package.json isn't watched automatically:

1. Edit package.json
2. Save the file
3. Trigger rebuild: `touch src/extension.ts`
4. Wait for "✅ Rebuild successful"
5. Press Cmd+R to reload
6. Test changes

### ⚠️ CRITICAL: Never Do This

```bash
# ❌ NEVER run this manually while bun dev is active
code --extensionDevelopmentPath=/path/to/extension

# Why: It breaks the dev server connection, loses file watching,
# and creates an isolated instance without dev tooling
```

### Reload Strategies

| Method | Time | When to Use |
|--------|------|-------------|
| **Cmd+R** | 2-3s | Most changes (commands, config, code) |
| **Restart dev** | 10-15s | Activation events, major changes |
| **Full restart** | 20-30s | VS Code API changes |

### Debugging

- Console logs appear in Debug Console
- Breakpoints work via Chrome DevTools on port 9229
- Output panel shows extension logs

---

## 2. Testing (`just test`) - Pure Testing

### What It Does
1. **Runs all tests** with Bun (~7-8 seconds, 593 tests)
2. **Enforces quality gates** (zero-tolerance: 0 type violations, 0 skipped tests)
3. **NO auto-fixing** (tests should test, not modify)
4. **NO validation** (use `just verify` for check + test)

**Why the change?** Following industry best practices (cargo, pytest, ruff):
- Tests should only test
- Validation belongs in `just check`
- Auto-fixing belongs in `just fix`
- Use `just verify` or `just pre-commit` for complete workflows

### Quick Reference

```bash
# Run all tests
just test                    # Pure testing (593 tests)

# Coverage analysis
just test-coverage           # See what's tested

# Watch mode for TDD
just test-watch              # Re-run on file changes

# Specific test file
just test path/to/file.test.ts   # Run one file

# Complete workflow
just verify                  # Validation + tests
just pre-commit              # Fix + verify
```

### Test Organization

All 207 test files organized by category:

```
test/
├── git-sort/            # Git change sorting
├── integration/         # Multi-component tests
├── services/            # Business logic
├── utils/               # Utility functions
├── security/            # Security validation
├── mocks/               # Mock helpers
└── tree-view/           # TreeView patterns
```

See `test/README.md` for complete documentation.

### Quality Enforcement

Command Central enforces **zero-tolerance for type safety violations**:

**Quality Gates (run automatically with `just test`):**
- ✅ Type assertions: 0 violations (100% type safety)
- ✅ Reflection tests: 0 violations
- ✅ Skipped tests: 0 violations

**Implementation:** `scripts/test-quality.ts` runs after all tests pass.

This ensures all future code maintains the same high quality standards.
See `TYPE_SAFETY_ZERO_TOLERANCE_COMPLETE.md` for details.

---

## 3. Distribution (`just dist`)

### Smart Version Management
The dist command respects your package.json version and only builds production when needed:

```bash
# Build current version (skips production if already exists)
just dist

# Bump version and build new release
just dist --patch      # 0.0.1 → 0.0.2
just dist --minor      # 0.0.1 → 0.1.0
just dist --major      # 0.0.1 → 1.0.0
```

### Dry-Run Mode (Preview Changes)

Test what would happen without making any changes:

```bash
# Preview current version build
just dist --dry-run

# Preview version bumps (use quotes for multiple flags)
just dist "--dry-run --patch"   # Shows: Would bump to 0.0.2
just dist "--dry-run --minor"   # Shows: Would bump to 0.1.0
just dist "--dry-run --major"   # Shows: Would bump to 1.0.0
```

**What dry-run shows:**
- Current version and what new version would be
- What npm version command would run
- Whether dev and/or production builds would happen
- Whether it would install to VS Code
- **NO actual changes are made to any files**

### Other Options

```bash
just dist --no-install  # Build but don't install to VS Code
just dist --help        # Show all available options
```

### What It Does
1. **Checks if version exists** in releases/
2. If exists: Builds dev only (for local testing)
3. If new: Builds both dev & production
4. **Auto-manages releases** (keeps last 3 by default)
5. **Installs** dev version to VS Code
6. Completes in ~1.1s

### Output Examples

**Existing version** (daily development):
```
✅ Version 0.0.3 already released
   → Skipping production build
   → Building development version only

💡 To create a new release:
   • Run: bun dist --patch  (or --minor, --major)
```

**New version** (after version bump):
```
🆕 New version 0.0.3 detected
   → Will build both dev and production versions

📦 Production VSIX saved: releases/command-central-0.0.3.vsix
   → Share: code --install-extension releases/command-central-0.0.3.vsix
```

### Philosophy
- **Version is truth**: Package.json version determines what gets built
- **No accidental releases**: Won't create duplicate production builds
- **One command convenience**: `bun dist --patch` bumps AND builds
- **Standard tooling**: Uses `npm version` under the hood

---

## Complete Daily Workflow

### Morning Start
```bash
# Start dev server for the day
just dev
# Keep this terminal open
```

### During Development
1. Edit files in VS Code
2. Save → Auto-rebuild happens
3. Press Cmd+R in Extension Development Host
4. Test immediately

### Before Committing

**Quick workflow** (recommended):
```bash
just pre-commit
# Auto-fixes → Validates → Tests → Ready!
```

**Manual workflow** (more control):
```bash
# 1. Fix code quality issues
just fix

# 2. Validate everything + run tests
just verify

# 3. Review changes (optional)
git diff
```

**Old workflow migration**:
```bash
# OLD (auto-fixed in test):
just test

# NEW (equivalent):
just pre-commit
# Or manually: just fix && just verify
```

**Why the change?** Separation of concerns following industry best practices:
- Tests should only test
- Validation should be explicit
- Auto-fixing should be separate
- Better CI/CD compatibility

### End of Day
```bash
# Daily development (reuses existing version)
just dist

# Or create new release when ready
just dist --patch
# Share releases/command-central-0.0.X.vsix with team
```

---

## Troubleshooting

### Changes Not Appearing
1. Check terminal for rebuild status
2. Did you press Cmd+R after rebuild?
3. For package.json: Did you touch a source file?
4. Check for build errors in terminal

### Dev Server Already Running?
```bash
# Check if running
ps aux | grep "bun run dev" | grep -v grep
lsof -i :9229

# Stop if needed
# Method 1: Close Extension Development Host window
# Method 2: Ctrl+C in original terminal
# Method 3: Kill by port
lsof -ti:9229 | xargs kill
```

### Test Failures
- Use `just test` to run tests (or `bun test` directly for quick runs)
- Check for validation errors: run `just check`
- Fix code quality issues: run `just fix`
- Complete workflow: run `just pre-commit`
- Verify all files were saved

### Distribution Issues
- Check package.json has all required fields
- Ensure VS Code is in PATH
- Verify no VSIX corruption with `unzip -l *.vsix`

---

## CI/CD Integration

### GitHub Actions Example

Our `.github/workflows/ci.yml` demonstrates best practices with parallel execution and fail-fast validation:

```yaml
jobs:
  # Fast validation (parallel with tests)
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: extractions/setup-just@v2
      - run: just check  # Biome CI + TypeScript + Knip

  # Unit tests (parallel with validation)
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: extractions/setup-just@v2
      - run: just test   # Pure testing

  # Integration tests (only after validation + tests pass)
  integration:
    needs: [validate, test]
    steps:
      - run: just test-integration

  # Package (only after all tests pass)
  package:
    needs: [validate, test, integration]
    steps:
      - run: bun run package
```

**Benefits**:
- **Parallel execution**: Validation and tests run simultaneously
- **Fail fast**: Validation catches issues before expensive integration tests
- **Clear dependencies**: `needs:` ensures proper ordering
- **Uses unified commands**: Same `just` commands locally and in CI

### Pre-commit Hooks

Install pre-commit hooks for automatic validation before commits:

```bash
# Install pre-commit (one-time setup)
pip install pre-commit

# Install hooks for this repo
pre-commit install

# Test manually
pre-commit run --all-files
```

**What it does**:
- Runs `just check` automatically before each commit
- Catches issues before they reach CI
- Optional auto-fix mode available (uncomment in `.pre-commit-config.yaml`)
- Follows 2025 best practices for multi-language projects

**Configuration** (`.pre-commit-config.yaml`):
```yaml
repos:
  - repo: local
    hooks:
      - id: quality-check
        name: Code Quality (Biome CI + TypeScript + Knip)
        entry: just check
        language: system
        pass_filenames: false
```

---

## Advanced Features

### Prerelease Versions

For beta testing and release candidates, you can create prerelease versions:

```bash
# Standard prerelease (increments prerelease number)
just dist --prerelease    # 0.0.1 → 0.0.2-0
just dist --prerelease    # 0.0.2-0 → 0.0.2-1
just dist --prerelease    # 0.0.2-1 → 0.0.2-2

# Named prereleases (use quotes for multiple flags)
just dist "--preid=beta --prerelease"   # 0.0.1 → 0.0.2-beta.0
just dist "--preid=alpha --prerelease"  # 0.0.1 → 0.0.2-alpha.0
just dist "--preid=rc --prerelease"     # 0.0.1 → 0.0.2-rc.0

# Continue named prerelease sequence
just dist --prerelease    # 0.0.2-beta.0 → 0.0.2-beta.1
```

**Use cases:**
- **Beta testing**: Share beta.0, beta.1, beta.2 with testers
- **Release candidates**: Create rc.0, rc.1 before major release
- **Internal testing**: Use numbered prereleases for CI builds

**Note**: For daily development, use the standard version bumps (--patch, --minor, --major) instead.

---

## Type Safety Standards

### The Philosophy: Never Bypass Type Safety

This project enforces **strict TypeScript configuration** with `noUncheckedIndexedAccess: true` and other advanced strictness flags. This creates a "pedantic" but robust type system that catches real bugs before runtime.

**Principle**: Never bypass TypeScript's type safety with non-null assertions (`!`) or `as any`.

**Pattern**: When strict TypeScript flags code as unsafe:
1. First try: Type guards or optional chaining
2. If unavoidable: Create shared utility with proper typing
3. Only add utilities when ACTUALLY USED (not speculatively)

### Example: Date Formatting

**❌ WRONG** (Anti-pattern - using non-null assertion):
```typescript
const dateStr = new Date().toISOString().split("T")[0]!;
```
This bypasses type safety without solving the underlying problem.

**✅ CORRECT** (Type-safe utility):
```typescript
import { getUTCDateString } from "@/utils/formatters.ts";

const dateStr = getUTCDateString(new Date());
```

**Why this approach**:
- ✅ Type-safe: No non-null assertions
- ✅ Performant: Memoized Intl.DateTimeFormat (created once, reused forever)
- ✅ Native-first: Leverages Bun's optimized ECMA-402 support
- ✅ Centralized: Single source of truth for date formatting
- ✅ Documented: Clear architectural intent

**Location**: `src/utils/formatters.ts`
- `getUTCDateString(date)` - UTC dates (matching toISOString() behavior)

**When to Add Utilities**: Only when the same pattern appears 2+ times in actual code (not "might need it").

**Lesson Learned**: This project initially added `getLocalDateString()` and `formatDateWithLocale()` speculatively ("might need them"). They were never used and became dead code. The cleanup removed them.

**Rule**: Add utilities only when actually needed (2+ real usages), not "in case we need it later." This follows the YAGNI principle (You Aren't Gonna Need It).

### When You Need a Different Date Format

**DO**: Add it to `src/utils/formatters.ts`
```typescript
const customFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function getFormattedDate(date: Date): string {
  return customFormatter.format(date);
}
```

**DON'T**: Use string slicing, regex, or other brittle patterns
- They fail on edge cases (extended-year ISO format, locale changes, etc.)
- They bypass type safety
- They duplicate logic across the codebase

---

## Performance Metrics

| Operation | Time | Command |
|-----------|------|---------|
| Dev startup | < 2s | `bun dev` |
| Rebuild on save | ~0.8s | Automatic |
| Reload window | ~0.5s | Cmd+R |
| Run tests | ~7-8s | `bun test` |
| Distribution | ~1.1s | `bun dist` |
| Test coverage | 82.78% | Coverage report |

**Total iteration time**: < 3 seconds from code change to testing

---

## Complete Command Reference

| Command | Purpose | Modifies Files | When to Use |
|---------|---------|---------------|-------------|
| **Core Workflow (Cross-Project Pattern)** ||||
| `just install` | Install dependencies from bun.lock | No | First time setup, after pulling changes |
| `just add <pkg>` | Add new package | Yes | Adding dependencies |
| `just update` | Update dependencies interactively | Yes | Updating packages safely (Bun 1.3+) |
| `just info <pkg>` | Show package information | No | Inspecting dependencies (Bun 1.3+) |
| `just dev` | Start development with hot reload | No | Beginning of coding session |
| `just check` | Comprehensive validation (Biome CI + tsc + knip) | No | CI/CD pipelines, local validation |
| `just fix` | Auto-fix formatting and linting | Yes | Fix code style before committing |
| `just test` | Run all tests (pure testing) | No | Verify correctness (593 tests) |
| `just verify` | Complete validation + tests (check + test) | No | CI workflow, pre-commit validation |
| `just pre-commit` | Developer workflow (fix + verify) | Yes | Quick pre-commit workflow |
| `just ci` | CI/CD workflow (alias for verify) | No | Explicit CI command for pipelines |
| `just test-coverage` | Run with coverage report | No | Analyze test coverage |
| `just test-watch` | Watch mode for TDD | No | Continuous testing |
| `just test <filter>` | Run filtered tests | No | Test specific areas |
| `just dist` | Build current version | No* | Daily builds, testing |
| **Version Bumping** ||||
| `just dist --patch` | Bug fix release (0.0.1 → 0.0.2) | Yes | After fixing bugs |
| `just dist --minor` | Feature release (0.1.0 → 0.2.0) | Yes | New features added |
| `just dist --major` | Breaking release (1.0.0 → 2.0.0) | Yes | Breaking changes |
| **Prerelease Versions** ||||
| `just dist --prerelease` | Create prerelease (0.0.1 → 0.0.2-0) | Yes | Testing versions |
| `just dist "--preid=beta --prerelease"` | Beta release | Yes | Beta testing |
| `just dist "--preid=rc --prerelease"` | Release candidate | Yes | Final testing |
| **Preview & Utilities** ||||
| `just dist --dry-run` | Preview without changes | No | Test commands |
| `just dist "--dry-run --patch"` | Preview version bump | No | See what would happen |
| `just knip` | Find dead code (quick analysis) | No | Weekly maintenance, before refactors |
| `just knip-verbose` | Detailed dead code report | No | Deep analysis, debugging |
| `just knip-files` | Find unused files only | No | File cleanup |
| `just knip-deps` | Find unused dependencies | No | Dependency audit |
| `just knip-exports` | Find unused exports | No | API cleanup |
| `just knip-fix` | Auto-fix safe dead code | Yes | After review, quick cleanup |
| `just clean` | Safe reset - removes all build artifacts | Yes*** | Failed builds, debugging, branch switches |
| `just workflow` | Open this document | No | Reference |

*Only modifies package.json when using version flags
**SAFETY: Single source of truth for all rm commands. Only removes generated files (dist/, *.vsix, releases/*.vsix.dev)

**Cross-Project Pattern Notes:**
- `check` → `fix` → `test` → `verify` workflow works identically across TypeScript, Python, Rust, etc.
- Same command names, same purposes, consistent behavior across all projects
- CI should use: `just verify` (or `just check && just test`)
- Developers should use: `just pre-commit` before committing

---

## Extension Features

### Multi-Workspace Support

**Status:** ✅ Production-ready (v0.0.31+)

Command Central fully supports multi-workspace environments with per-workspace isolation:

- **Automatic workspace detection** - Each workspace folder gets its own view
- **Isolated git tracking** - Each workspace shows its own repository changes
- **Smart file opening** - Click files in any workspace view to open them correctly
- **Nested workspace support** - Handles nested folders with longest-match resolution

**Detailed Documentation:**
- Architecture & implementation: `WORKSPACE_IMPLEMENTATION_GUIDE.md`
- File opening fix: `HANDOFF_MULTI_WORKSPACE_FILE_OPENING.md`

---

### Keyboard-Driven Workflow

**Status:** ✅ Production-ready (v0.0.31+)

Command Central supports keyboard shortcuts for a fast, mouse-free workflow:

**Global Shortcuts:**
- `Cmd+Shift+C` (Mac) / `Ctrl+Shift+C` (Win/Linux) - Focus Command Central from anywhere

**View-Scoped Shortcuts** (only work when Command Central focused):
- `f` - Filter files by type (code, config, docs, images, tests, custom)

**Quick workflow:**
```bash
Cmd+Shift+C → f → [select filter] → Done!
```

Press `Cmd+Shift+C` to open Command Central, then `f` to instantly access file filtering.

See README for complete keyboard shortcut reference.

---

### Git Sort - Intelligent Change Tracking

The extension includes advanced Git change sorting with powerful features:

**Core Capabilities:**
- **Time-based grouping** - Changes organized by Today, Yesterday, Last 7 days, Last 30 days, This Month, Last Month, Older
- **Deleted file tracking** - Maintains stable, sequential ordering of deleted files across sessions
  - Persistent storage via SQLite (desktop only)
  - Trash icon (🗑️) indicators in sorted changes view
  - Order preserved across file restore/delete cycles
  - Survives VS Code restarts
- **File type filtering** - Filter by code, config, docs, images, tests, or custom extensions
- **Sort order toggle** - Switch between newest-first (▼) and oldest-first (▲)

**Visual Indicators:**
- Trash icon for deleted files
- Time-based grouping for easy navigation
- Relative time labels (e.g., "2 hours ago", "3 days ago")
- File count in view title

**Commands:**
- `commandCentral.gitSort.enable` - Enable Git Sort
- `commandCentral.gitSort.disable` - Disable Git Sort
- `commandCentral.gitSort.changeSortOrder` - Toggle newest/oldest first
- `commandCentral.gitSort.changeFileFilter` - Change file type filter
- `commandCentral.gitSort.refreshView` - Force refresh view

**Known Limitations:**
- Deleted file persistence: Desktop only (macOS, Windows, Linux)
- Not available in Remote-SSH, Dev Containers, or VS Code for Web (graceful in-memory fallback)
- Large deletions (1000+) not performance-tested

**Technical Details:**
See `DELETED_FILE_TRACKING.md` for complete architecture and implementation details.

---

## Architecture Notes

### Why These Commands?

1. **`just dev`** - Based on DEVELOPMENT_WORKFLOW.md standard
2. **`just check`** - Comprehensive validation using `biome ci` (CI-optimized), includes knip for dead code
3. **`just fix`** - Auto-fix safe issues, keeps validation separate
4. **`just test`** - Pure testing (no side effects), follows industry standards (cargo, pytest, ruff)
5. **`just verify`** - CI workflow (check + test), explicit validation
6. **`just pre-commit`** - Developer convenience (fix + verify), one-command workflow
7. **`just dist`** - Smart version-aware builds with optional bumping via industry-standard `npm version`

**Design Philosophy**: Separation of concerns
- Validation is read-only (`check`)
- Fixing modifies files (`fix`)
- Testing just tests (`test`)
- Convenience commands compose primitives (`verify`, `pre-commit`)

### Deprecated Commands

We removed 17+ redundant commands and improved separation of concerns:
- `build`, `format`, `lint` (use `just fix` for auto-fix, `just check` for validation)
- `package`, old `precommit` (use `just pre-commit` - new improved version)
- Individual test commands (internal only)

**Breaking Change** (October 2025):
- `just test` no longer auto-fixes code (following industry best practices)
- Use `just pre-commit` for equivalent workflow (fix + verify)
- Or manually: `just fix && just verify`

### File Organization
```
scripts-v2/
├── dev.ts          # Development with hot reload
├── test-all.ts     # Unified quality + tests
├── dist-simple.ts  # Smart distribution with version management (v6)
└── lib/            # Supporting libraries
```

---

## Key Principles

1. **One Workflow** - Not multiple competing approaches
2. **Separation of Concerns** - Commands have single, clear responsibilities
3. **Cross-Project Consistency** - Same workflow across TypeScript, Python, Rust, etc.
4. **Smart Defaults** - Commands do the right thing, with optional enhancements
5. **Fast Iteration** - Under 3 seconds for most changes
6. **Industry Standards** - Follows cargo, pytest, ruff patterns; uses npm version
7. **CI/CD Optimized** - Uses `biome ci` for better CI integration
8. **Developer Focus** - Tooling gets out of the way

---

## Summary

The entire VS Code extension development workflow:

```bash
# Daily development
just dev              # Start coding with hot reload
just pre-commit       # Before committing (fix + verify)

# Or manual control
just fix              # Auto-fix code quality issues
just check            # Comprehensive validation (CI-optimized)
just test             # Run all tests (pure testing)
just verify           # Complete validation + tests

# Maintenance (weekly)
just knip             # Find dead code

# Distribution
just dist             # Build for testing
just dist --patch     # Release new version
```

**Cross-Project Pattern**: The `check → fix → test → verify` workflow works identically across TypeScript, Python, Rust, and other languages.

Simple defaults. Smart options when needed. Pure productivity.

**Pro tip**: Use `just` (no arguments) to see all available commands.

---

*This is the authoritative workflow document. Previous versions have been archived in the `archive/` folder for reference.*