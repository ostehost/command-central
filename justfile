# VS Code Extension - Command Central
# Core workflow commands for development
# Run 'just' to see all available commands

# Show available commands (default)
default:
    @echo "╭──────────────────────────────────────────────────╮"
    @echo "│         Command Central - Core Workflow         │"
    @echo "╰──────────────────────────────────────────────────╯"
    @echo ""
    @echo "Essential Commands:"
    @echo "  just install     Install dependencies from bun.lock (first time)"
    @echo "  just add         Add new package (e.g., just add zod)"
    @echo "  just update      Update dependencies interactively (Bun 1.3+)"
    @echo "  just info        Show package information (e.g., just info zod)"
    @echo "  just dev         Start development with hot reload"
    @echo "  just pre-commit  Developer workflow (fix + verify) - recommended!"
    @echo "  just dist        Build distribution (smart version-aware builds)"
    @echo "  just prerelease  Run prerelease gate + build prerelease artifact"
    @echo ""
    @echo "Code Quality (Cross-Project Pattern):"
    @echo "  just check       Comprehensive validation (Biome CI + tsc + knip)"
    @echo "  just fix         Auto-fix formatting and linting issues"
    @echo "  just test        Run all tests (pure testing, no side effects)"
    @echo "  just verify      Complete validation + tests (CI workflow)"
    @echo "  just pre-commit  Fix → verify (one-command workflow)"
    @echo ""
    @echo "Testing (Enterprise-Grade):"
    @echo "  just test                Run all tests (593 tests, ~7-8s)"
    @echo "  just test-quality        Check for test anti-patterns (CI gate)"
    @echo "  just test-validate       Prevent orphaned tests"
    @echo "  just test-unit           Fast unit tests only"
    @echo "  just test-integration    Integration tests only"
    @echo "  just test-coverage       With coverage report"
    @echo "  just test-watch          TDD watch mode"
    @echo "  just test list           Show test organization"
    @echo ""
    @echo "Dead Code Detection:"
    @echo "  just knip        Find unused files, exports, dependencies"
    @echo ""
    @echo "Site Workflow (Landing Page):"
    @echo "  just site            Start local dev server with live reload"
    @echo "  just site-check      Validate HTML, links, and metadata"
    @echo "  just site-screenshot Capture screenshot for comparison"
    @echo ""
    @echo "Debugging:"
    @echo "  just debug-filter  Debug extension filter with verbose logging"
    @echo ""
    @echo "Utilities:"
    @echo "  just clean           Remove build artifacts"
    @echo "  just workflow        Open workflow documentation"
    @echo ""
    @echo "Resource Sync (required before release):"
    @echo "  just sync-launcher   Sync launcher script from dev repo"
    @echo "  just sync-terminal   Sync terminal app from dev repo"
    @echo "  just sync-all        Sync all external resources"
    @echo ""
    @echo "Distribution Options:"
    @echo "  just dist           Auto-bump patch version and build (default)"
    @echo "  just dist --minor   Bump minor version and build"
    @echo "  just dist --major   Bump major version and build"
    @echo "  just dist --current Use current version (no bump)"
    @echo ""

# Open workflow documentation
workflow:
    @echo "📖 Opening WORKFLOW.md..."
    @code WORKFLOW.md 2>/dev/null || open WORKFLOW.md 2>/dev/null || cat WORKFLOW.md

# Install dependencies from bun.lock (first time setup)
# Also creates Ghostty dock launcher for instant terminal access
install: ghostty
    @echo "📦 Installing dependencies..."
    @bun install
    @echo "✅ Dependencies installed from bun.lock"

# Add a new dependency
add *package:
    @if [ -z "{{package}}" ]; then \
        echo "Usage: just add <package-name>"; \
        echo "Example: just add zod"; \
        exit 1; \
    fi
    @echo "➕ Adding package: {{package}}"
    @bun add {{package}}
    @echo "✅ Package added and bun.lock updated"

# Update dependencies interactively (Bun 1.3+)
update:
    @echo "🔄 Interactive dependency updates (Bun 1.3)"
    @echo "   • Select dependencies to update"
    @echo "   • Preview changes before applying"
    @echo "   • Control breaking changes"
    @echo ""
    @bun update -i

# Show package information (Bun 1.3+)
info *package:
    @if [ -z "{{package}}" ]; then \
        echo "Usage: just info <package-name>"; \
        echo "Example: just info @biomejs/biome"; \
        exit 1; \
    fi
    @echo "📦 Package information: {{package}}"
    @echo ""
    @bun info {{package}}

# Create/update Ghostty dock launcher for this project
# Transparently creates a dock-launchable terminal that opens in this project
ghostty:
    @if [ -x "$HOME/projects/ghostty-launcher/launcher" ]; then \
        "$HOME/projects/ghostty-launcher/launcher" "$(pwd)" 2>/dev/null || true; \
    elif [ -x "$HOME/ghostty-dock-launcher-v1/ghostty" ]; then \
        "$HOME/ghostty-dock-launcher-v1/ghostty" "$(pwd)" 2>/dev/null || true; \
    elif command -v ghostty-launcher >/dev/null 2>&1; then \
        ghostty-launcher "$(pwd)" 2>/dev/null || true; \
    fi

# Start development with hot reload & file watching
# Usage: just dev [path]
#   just dev            - Open with last used workspace
#   just dev .          - Open in current directory
#   just dev ~/project  - Open in specific project
# Note: Auto-creates Ghostty dock launcher for instant project access
dev *path="": ghostty
    @if [ "{{path}}" = "--help" ]; then \
        bun run scripts-v2/dev.ts --help; \
    else \
        echo "🚀 Starting development server..."; \
        if [ -n "{{path}}" ]; then \
            echo "   • Opening in: {{path}}"; \
        else \
            echo "   • Opening with last workspace"; \
        fi; \
        echo "   • Auto-rebuild on save"; \
        echo "   • Press Cmd+R in Extension Host to reload"; \
        echo "   • Debug port: 9229"; \
        echo ""; \
        if [ -n "{{path}}" ]; then \
            echo "⚠️  Note: Extension Development Host always opens a new window"; \
            echo "   If {{path}} is already open, you'll have two windows"; \
            echo ""; \
        fi; \
        bun run scripts-v2/dev.ts {{path}}; \
    fi

# ──────────────────────────────────────────────────────────
# CROSS-PROJECT WORKFLOW COMMANDS
# Pattern: check → fix → test → verify
# Works identically across TypeScript, Python, Rust, etc.
# ──────────────────────────────────────────────────────────

# Run comprehensive validation (development-friendly)
# Pattern: Language-agnostic validation
#   - Code quality (format + lint)
#   - Type checking (if applicable)
#   - Dead code detection (warnings only)
# Note: Knip warnings are informational. Use 'just ci' for strict mode.
check:
    @echo "🔍 Running comprehensive validation..."
    @echo "   • Code quality (Biome CI - read-only)"
    @echo "   • Type checking"
    @echo "   • Dead code detection (Knip)"
    @echo ""
    @bunx @biomejs/biome ci ./src ./test ./scripts-v2
    @bunx tsc --noEmit
    @bunx knip --no-exit-code || true
    @echo ""
    @echo "✅ Checks complete!"
    @echo "💡 Knip warnings are informational. Run 'just ci' for strict validation."

# Auto-fix code quality issues (format + lint)
# Pattern: Language-agnostic auto-fix
#   - Format code
#   - Fix linting issues (safe fixes only)
#   - Note: Manual review may be needed for complex issues
fix:
    @echo "🔧 Auto-fixing code quality issues..."
    @echo "   • Formatting and linting (src, test, scripts-v2)..."
    @echo ""
    @bunx @biomejs/biome check --write ./src ./test ./scripts-v2
    @echo ""
    @echo "✅ All fixable issues resolved!"
    @echo "💡 Run 'just check' to verify remaining issues"

# Strict validation (for CI - zero tolerance)
# Pattern: CI-optimized validation
#   - All checks from 'check' command
#   - Knip failures WILL block
#   - Exit 1 on any issues
check-strict:
    @echo "🔍 Running strict validation (CI mode)..."
    @echo "   • Code quality (Biome CI - read-only)"
    @echo "   • Type checking"
    @echo "   • Dead code detection (Knip - strict)"
    @echo ""
    @bunx @biomejs/biome ci ./src ./test ./scripts-v2
    @bunx tsc --noEmit
    @bunx knip
    @echo ""
    @echo "✅ All strict checks passed!"

# Complete validation + testing (local development)
# Pattern: Language-agnostic verification
#   - Run all validation checks (check)
#   - Run all tests (test)
#   - Development-friendly (warnings don't block)
verify:
    @echo "✨ Running complete verification..."
    @echo ""
    @just check && just test
    @echo ""
    @echo "✅ All checks passed, ready to commit!"

# Developer pre-commit workflow (fix → verify)
# Pattern: Language-agnostic pre-commit
#   - Auto-fix issues (fix)
#   - Validate everything (verify)
#   - One command for complete pre-commit workflow
pre-commit:
    @echo "🚀 Pre-commit workflow..."
    @echo ""
    @just fix
    @echo ""
    @just verify

# CI/CD workflow (strict validation + tests)
# Pattern: Explicit CI command for pipelines
#   - Clear intent: CI runs 'just ci'
#   - Uses strict mode (Knip failures block)
#   - Runs comprehensive validation + tests
ci:
    @echo "🚀 CI/CD Pipeline..."
    @echo ""
    @just check-strict && just test
    @echo ""
    @echo "✅ CI checks passed!"

# ──────────────────────────────────────────────────────────
# ENTERPRISE-GRADE TEST COMMANDS
# ──────────────────────────────────────────────────────────

# Usage: just test [command|filter|list]
#   just test                - Run all tests (pure testing)
#   just test-validate       - Ensure all tests are in partitions
#   just test-unit           - Fast unit tests only (~2s)
#   just test-integration    - Integration tests only
#   just test-coverage       - Run with coverage report
#   just test-watch          - Watch mode for TDD
#   just test list           - Show test files and commands
#   just test <filter>       - Run filtered tests (e.g., 'git-sort')

# Run tests with integrated quality checks
# Pattern: Quality by default
#   - Run all tests (or filtered subset)
#   - Automatically enforce quality gates (when running full suite)
#   - No auto-fixing (tests should test, not modify)
# Usage:
#   just test              # Run all tests + quality checks
#   just test list         # Show test organization
#   just test <filter>     # Run filtered tests (skip quality checks)
test *args="":
    @if [ "{{args}}" = "list" ]; then \
        just test-list; \
    elif [ -z "{{args}}" ]; then \
        echo "🧪 Running test suite..."; \
        echo ""; \
        bun test test/commands/ test/config/ test/discovery/ test/events/ test/git-sort/ test/helpers/ test/mocks/ test/package-json/ test/ghostty/ test/integration/ test/providers/ test/scripts-v2/ test/services/ test/state/ test/tree-view/ test/types/ test/ui/ test/utils/; \
        echo ""; \
        echo "🧪 Running isolated mock tests..."; \
        bun test test/discovery-e2e/; \
        echo ""; \
        just test-quality; \
    else \
        echo "🧪 Running filtered tests: {{args}}"; \
        echo ""; \
        bun test {{args}}; \
    fi

# Check test quality (no type assertions, no skipped tests)
# Pattern: Prevent test anti-patterns
#   - Fail on 'as any' type assertions (bypass type safety)
#   - Fail on reflection tests (private member access)
#   - Fail on skipped tests (test.skip, describe.skip)
#   - Quality gate for CI/CD pipeline
test-quality:
    @echo "🔍 Test quality checks..."
    @echo ""

    @# Check active tests only (exclude _deleted and .legacy)
    @# Phase 1.3 achievement: Zero violations (all type assertions eliminated)
    @VIOLATIONS=`grep -r "as any" test --include="*.test.ts" --exclude-dir="_deleted" --exclude-dir=".legacy" 2>/dev/null | wc -l | tr -d ' '`; \
    if [ $$VIOLATIONS -gt 0 ]; then \
        echo "❌ Found 'as any' type assertions (current: $$VIOLATIONS, baseline: 0)"; \
        echo ""; \
        grep -r "as any" test --include="*.test.ts" --exclude-dir="_deleted" --exclude-dir=".legacy" -l | sed 's/^/  - /'; \
        echo ""; \
        echo "💡 All 'as any' must have INTENTIONAL comment explaining why"; \
        exit 1; \
    else \
        echo "✅ Zero 'as any' type assertions (Phase 1.3 achievement maintained)"; \
    fi

    @# Check for reflection testing (private member access - excluding INTENTIONAL comments)
    @REFLECT=`grep -rE "\\(.*as any\\)\\." test --include="*.test.ts" --exclude-dir="_deleted" --exclude-dir=".legacy" 2>/dev/null | grep -v "INTENTIONAL" | wc -l | tr -d ' '`; \
    if [ $$REFLECT -gt 0 ]; then \
        echo "❌ Found $$REFLECT reflection tests (private member access without INTENTIONAL comment)"; \
        echo ""; \
        grep -rE "\\(.*as any\\)\\." test --include="*.test.ts" --exclude-dir="_deleted" --exclude-dir=".legacy" | grep -v "INTENTIONAL" | head -5 | sed 's/^/  - /'; \
        echo ""; \
        echo "💡 Test public API behavior instead of implementation details"; \
        echo "💡 Or add INTENTIONAL comment if truly necessary"; \
        exit 1; \
    fi

    @# Check for skipped tests
    @if grep -r "test\.skip\|describe\.skip" test --include="*.test.ts" --exclude-dir="_deleted" --exclude-dir=".legacy" >/dev/null 2>&1; then \
        echo "⚠️  Found skipped tests"; \
        echo ""; \
        echo "Skipped tests:"; \
        grep -r "test\.skip\|describe\.skip" test --include="*.test.ts" --exclude-dir="_deleted" --exclude-dir=".legacy" --with-filename --line-number | sed 's/^/  - /'; \
        echo ""; \
        echo "💡 Implement or remove skipped tests"; \
        exit 1; \
    fi

    @echo "✅ Quality checks passed!"
    @echo "   • Zero 'as any' assertions in active tests"
    @echo "   • Zero reflection tests (private access)"
    @echo "   • Zero skipped tests"


# Backup: Partitioned test runner (use if bun test has issues)
test-backup:
    @echo "🧪 Running partitioned test suite (backup method)..."
    @echo "   • Validating test partitions"
    @echo "   • Auto-fixing code quality"
    @echo "   • Type checking"
    @echo "   • Running partitioned tests"
    @echo ""
    @bun run scripts-v2/test-validate.ts && bun run scripts-v2/test-all.ts

# Validate all tests are properly partitioned (prevents orphaned tests)
test-validate:
    @echo "🔍 Validating test coverage..."
    @echo "   • Discovering all test files"
    @echo "   • Checking partition assignments"
    @echo "   • Detecting orphaned tests"
    @echo ""
    @bun run scripts-v2/test-validate.ts

# Run only fast unit tests (no integration)
test-unit:
    @echo "⚡ Running unit tests (fast feedback)..."
    @echo "   • Git Sort tests"
    @echo "   • Core services"
    @echo "   • Utilities"
    @echo ""
    @bun run _test:git2 && \
     bun run _test:git4 && \
     bun run _test:git5 && \
     bun run _test:core && \
     bun run _test:mocks

# Run integration tests only
test-integration:
    @echo "🔗 Running integration tests..."
    @echo "   • Multi-workspace scenarios"
    @echo "   • Tree view patterns"
    @echo ""
    @bun run _test:integration && \
     bun run _test:tree-view-patterns

# Run tests with coverage report
test-coverage:
    @echo "📊 Running tests with coverage..."
    @echo ""
    @bun test --coverage

# Watch mode for TDD (Test-Driven Development)
test-watch:
    @echo "👀 Watch mode enabled - tests will re-run on file changes"
    @echo "   Press Ctrl+C to stop"
    @echo ""
    @bun test --watch

# Show test organization and available commands
test-list:
    @if ! command -v tree > /dev/null 2>&1; then \
        echo "❌ Error: 'tree' command not found"; \
        echo ""; \
        echo "Install with:"; \
        echo "  brew install tree    # macOS"; \
        echo "  apt install tree     # Ubuntu/Debian"; \
        echo "  yum install tree     # RHEL/CentOS"; \
        false; \
    fi; \
    echo "╭────────────────────────────────────────────────╮"; \
    echo "│           Test Suite Organization              │"; \
    echo "╰────────────────────────────────────────────────╯"; \
    echo ""; \
    echo "📋 Test Files (46 total):"; \
    echo ""; \
    tree test -P "*.test.ts" --prune -I "node_modules" -L 2; \
    echo ""; \
    echo "──────────────────────────────────────────────────"; \
    echo "📦 Available Commands:"; \
    echo ""; \
    echo "  just test                - Full suite (quality + tests)"; \
    echo "  just test-validate       - Ensure no orphaned tests"; \
    echo "  just test-unit           - Fast unit tests (~7-8s)"; \
    echo "  just test-integration    - Integration tests only"; \
    echo "  just test-coverage       - Coverage report"; \
    echo "  just test-watch          - Watch mode for TDD"; \
    echo ""; \
    echo "──────────────────────────────────────────────────"; \
    echo "🎯 Run specific directories:"; \
    echo ""; \
    for dir in test/*/; do \
        if [ -d "$dir" ]; then \
            dirname=$(basename "$dir"); \
            count=$(find "$dir" -name "*.test.ts" 2>/dev/null | wc -l | tr -d ' '); \
            if [ "$count" -gt 0 ]; then \
                if [ "$count" -eq 1 ]; then \
                    printf "  just test %-18s # %d test\n" "$dirname" "$count"; \
                else \
                    printf "  just test %-18s # %d tests\n" "$dirname" "$count"; \
                fi; \
            fi; \
        fi; \
    done; \
    echo ""; \
    echo "💡 Run specific file:"; \
    echo "  just test ./test/path/to/file.test.ts"; \
    echo ""

# ──────────────────────────────────────────────────────────
# RESOURCE SYNC
# ──────────────────────────────────────────────────────────

# Sync launcher script from development repo
sync-launcher:
    @echo "🔄 Syncing launcher from development repo..."
    @bun run scripts-v2/sync-launcher.ts
    @echo ""
    @echo "💡 Run 'git diff' to review changes."

# Sync terminal app from development repo
sync-terminal:
    @echo "🔄 Syncing terminal app from development repo..."
    @bun run scripts-v2/sync-terminal.ts
    @echo ""
    @echo "💡 Terminal app synced (not committed to git)."

# Sync all external resources (REQUIRED before release)
sync-all: sync-launcher sync-terminal
    @echo ""
    @echo "✅ All resources synced!"
    @echo "   • Launcher script: resources/bin/ghostty-launcher"
    @echo "   • Terminal app: resources/app/CommandCentral.app"

# Check if launcher needs sync (internal, called before dist)
_check-launcher-sync:
    @if [ -f ~/projects/ghostty-launcher/launcher ]; then \
        if ! diff -q resources/bin/ghostty-launcher ~/projects/ghostty-launcher/launcher >/dev/null 2>&1; then \
            echo ""; \
            echo "⚠️  WARNING: Bundled launcher differs from source!"; \
            echo "   Run 'just sync-launcher' before distribution."; \
            echo ""; \
        fi; \
    fi

# Check if terminal needs sync (internal, called before dist)
_check-terminal-sync:
    @if [ -d ~/ghostty-fork/zig-out/Ghostty.app ]; then \
        bun run scripts-v2/sync-terminal.ts --check 2>/dev/null || \
        (echo "" && echo "⚠️  WARNING: Bundled terminal differs from source!" && \
         echo "   Run 'just sync-terminal' before distribution." && echo ""); \
    fi

# ──────────────────────────────────────────────────────────
# DISTRIBUTION
# ──────────────────────────────────────────────────────────

# Build and distribute (auto-bumps patch version by default)
dist *args="--patch": _check-launcher-sync _check-terminal-sync
    @echo "📦 Building distribution..."
    @if [ "{{args}}" = "--patch" ]; then \
        echo "   • Auto-bumping patch version"; \
    elif [ "{{args}}" = "--minor" ]; then \
        echo "   • Bumping minor version"; \
    elif [ "{{args}}" = "--major" ]; then \
        echo "   • Bumping major version"; \
    elif [ "{{args}}" = "--current" ]; then \
        echo "   • Using current version (no bump)"; \
    elif echo "{{args}}" | grep -q -- "--dry-run"; then \
        echo "   • Preview mode (no changes)"; \
    elif echo "{{args}}" | grep -q -- "--prerelease"; then \
        echo "   • Creating prerelease version"; \
    elif echo "{{args}}" | grep -q -- "--help"; then \
        echo "   • Showing help"; \
    else \
        echo "   • Options: {{args}}"; \
    fi
    @echo ""
    bun run scripts-v2/dist-simple.ts {{args}}

# Hard-fail prerelease integration gate (cross-repo)
prerelease-gate *args="":
    @echo "🚧 Running prerelease gate..."
    @echo "   • Command Central validation (just verify)"
    @echo "   • Ghostty Launcher validation (just check)"
    @echo "   • Cross-repo launcher contract checks"
    @echo "   • Provenance artifact (CC + launcher SHAs)"
    @echo ""
    bun run scripts-v2/prerelease-gate.ts {{args}}

# Build prerelease artifact only after gate passes
prerelease *args="--prerelease":
    @just prerelease-gate
    @just dist "{{args}}"

# Clean build artifacts
clean:
    @echo "🧹 Cleaning build artifacts..."
    @rm -rf dist/
    @rm -rf *.vsix
    @rm -rf releases/*.vsix.dev
    @echo "✅ Clean complete"

# Debug extension filter with verbose logging
debug-filter:
    @echo "🔍 Starting extension with DEBUG logging for filter..."
    @echo "   • All filter operations will be logged in detail"
    @echo "   • Discovery process fully traced"
    @echo "   • Checkbox events captured"
    @echo "   • State changes monitored"
    @echo ""
    @echo "📋 Check output in VS Code:"
    @echo "   1. View → Output"
    @echo "   2. Select 'Command Central: Terminal' from dropdown"
    @echo "   3. Look for DEBUG messages with filter details"
    @echo ""
    @echo "🎯 What to verify:"
    @echo "   • Which extensions are discovered"
    @echo "   • Which extensions are in active filter"
    @echo "   • If checkbox clicks fire events"
    @echo "   • If providers refresh on state change"
    @echo ""
    DEBUG_FILTER=1 bun run scripts-v2/dev.ts

# ──────────────────────────────────────────────────────────
# DEAD CODE DETECTION (KNIP)
# ──────────────────────────────────────────────────────────

# Find unused files, exports, and dependencies
knip:
    @echo "🔍 Detecting dead code..."
    @echo "   • Unused files"
    @echo "   • Unused exports"
    @echo "   • Unused dependencies"
    @echo ""
    bunx knip

# Detailed analysis with full output
knip-verbose:
    @echo "🔍 Detailed dead code analysis..."
    @echo ""
    bunx knip --reporter verbose

# Auto-fix safe issues (review with git diff after)
knip-fix:
    @echo "🔧 Auto-fixing safe dead code issues..."
    @echo ""
    bunx knip --fix
    @echo ""
    @echo "⚠️  Review changes with: git diff"

# Find unused files only
knip-files:
    @echo "📁 Finding unused files..."
    @echo ""
    bunx knip --include files

# Find unused dependencies only
knip-deps:
    @echo "📦 Finding unused dependencies..."
    @echo ""
    bunx knip --include dependencies

# Find unused exports only
knip-exports:
    @echo "📤 Finding unused exports..."
    @echo ""
    bunx knip --include exports

# ──────────────────────────────────────────────────────────
# SITE WORKFLOW (LANDING PAGE)
# ──────────────────────────────────────────────────────────

# Start local dev server with live reload for the landing page
site:
    @echo "🌐 Starting site development server..."
    @echo "   • Live reload enabled"
    @echo "   • Open: http://localhost:3000"
    @echo "   • Press Ctrl+C to stop"
    @echo ""
    @if command -v bun >/dev/null 2>&1; then \
        cd site && bun --bun x live-server --port=3000 --open=/; \
    elif command -v python3 >/dev/null 2>&1; then \
        echo "💡 Using Python fallback (no live reload)"; \
        cd site && python3 -m http.server 3000; \
    else \
        echo "❌ No server available. Install bun or use python3"; \
        exit 1; \
    fi

# Validate site content (HTML, links, metadata)
site-check:
    @echo "🔍 Validating site..."
    @echo "   • Test count synchronization"
    @echo "   • Link validation"
    @echo "   • Asset verification"
    @echo "   • Metadata checks"
    @echo ""
    @bash scripts/site-check.sh

# Capture screenshot for visual comparison
site-screenshot:
    @echo "📸 Capturing site screenshot..."
    @echo "   • Starting headless server"
    @echo "   • Taking screenshot"
    @echo "   • Saving to screenshots/site-preview.png"
    @echo ""
    @mkdir -p screenshots
    @if command -v bun >/dev/null 2>&1; then \
        (cd site && timeout 10 bun --bun x live-server --port=3001 --no-browser > /dev/null 2>&1 &); \
        sleep 2; \
        bun x playwright screenshot --wait-for-selector="body" http://localhost:3001 screenshots/site-preview.png; \
        pkill -f "live-server.*3001" || true; \
    else \
        echo "❌ Requires bun for Playwright integration"; \
        exit 1; \
    fi
    @echo "✅ Screenshot saved: screenshots/site-preview.png"
