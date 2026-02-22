# Developer Onboarding - Command Central

**Get up and running in 5 minutes**

Welcome to Command Central! This guide will get you from zero to productive contributor in minimal time.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [First Build (5 Minutes)](#first-build-5-minutes)
3. [Your First Change](#your-first-change)
4. [Key Files to Know](#key-files-to-know)
5. [Common Workflows](#common-workflows)
6. [Getting Help](#getting-help)

---

## Prerequisites

### Required Software

- **Bun 1.3+** - Our build tool and test runner
  ```bash
  # Install Bun
  curl -fsSL https://bun.sh/install | bash

  # Verify
  bun --version  # Should be 1.3.0 or higher
  ```

- **VS Code 1.105+** - The platform we extend
  ```bash
  code --version  # Should be 1.105.0 or higher
  ```

- **Git** - Version control (already installed on macOS/Linux)
  ```bash
  git --version
  ```

### Optional but Recommended

- **just** - Command runner (makes life easier)
  ```bash
  # macOS
  brew install just

  # Verify
  just --version
  ```

---

## First Build (5 Minutes)

### Step 1: Clone and Install (2 minutes)

```bash
# 1. Clone the repository
git clone https://github.com/command-central/vscode-extension.git
cd vscode-extension

# 2. Install dependencies from lock file
just install
# Or: bun install

# Expected output:
# 📦 Installing dependencies...
# ✅ Dependencies installed from bun.lock
```

**What just happened?**
- Bun read `bun.lock` to install exact versions
- All dependencies installed in ~1-2 seconds
- You're ready to build!

### Step 2: First Build (1 minute)

```bash
# Build the extension
just dev

# Expected output:
# 🚀 Starting development server...
#    • Opening with last workspace
#    • Auto-rebuild on save
#    • Press Cmd+R in Extension Host to reload
#    • Debug port: 9229
```

**What just happened?**
- Extension compiled (~1.1s)
- VS Code Extension Development Host opened
- File watcher started
- You're now in development mode!

### Step 3: Verify It Works (2 minutes)

In the **Extension Development Host** window that just opened:

1. **Open Command Palette**: `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. **Type**: "Command Central"
3. **You should see**: Multiple Command Central commands
4. **Try**: "Command Central: Enable Git Sort"
5. **Check**: Activity bar (left side) for Command Central icon

**Success Indicators:**
- ✅ Extension Development Host window opened
- ✅ Command Central commands appear in palette
- ✅ Activity bar shows Command Central icon
- ✅ No errors in Output panel (View → Output → "Command Central")

**If something went wrong:**
- See [Troubleshooting](#troubleshooting) below
- Check Output panel for errors
- Verify prerequisites are installed

---

## Your First Change

Let's make a simple change to prove the hot reload workflow works.

### Change 1: Update Welcome Message

**File**: `src/extension.ts`

**Find this** (around line 85):
```typescript
mainLogger.info(`Extension starting... (v${version})`);
mainLogger.info(`Command Central v${version}`);
```

**Change to**:
```typescript
mainLogger.info(`Extension starting... (v${version})`);
mainLogger.info(`🎉 Command Central v${version} - YOUR_NAME's build`);
```

**Replace `YOUR_NAME`** with your actual name.

### See Your Change

1. **Save the file** (`Cmd+S` / `Ctrl+S`)
2. **Watch the terminal** running `just dev`:
   ```
   📝 Changed: extension.ts
   ✅ Rebuild successful
   ```
3. **Reload Extension Host**: `Cmd+R` (Mac) or `Ctrl+R` (Windows/Linux)
4. **Check Output**: View → Output → Select "Command Central"
5. **You should see**: Your custom message!

**Congratulations!** You just made your first change. The workflow is:
1. Edit → 2. Save → 3. Wait for rebuild → 4. Cmd+R → 5. Test

---

## Key Files to Know

### 1. Entry Point

**`src/extension.ts`** - Where everything starts
- `activate()` function runs when extension loads
- Sets up dependency injection (lines 54-183)
- Registers all commands
- **Read this first** to understand the architecture

### 2. Core Services

**`src/services/project-view-manager.ts`** - The orchestrator
- Manages all workspace folder views
- Routes commands to correct provider
- Handles workspace changes
- **Most command logic flows through here**

**`src/git-sort/sorted-changes-provider.ts`** - Git change tracking
- Sorts files by modification time
- Handles time grouping (Today, Yesterday, etc.)
- Implements TreeView data provider
- **The heart of Git Sort feature**

### 3. Configuration

**`src/config/workspace-project-source.ts`** - Auto-discovery
- Finds all workspace folders
- Provides per-folder configuration
- Reacts to workspace changes

**`src/factories/provider-factory.ts`** - Provider creation
- Creates `SortedGitChangesProvider` instances
- Manages per-workspace storage
- Shares state across providers

### 4. Testing

**`test/README.md`** - Testing guide
- How tests are organized
- How to run specific tests
- Testing patterns we use

**`test/helpers/vscode-mock.ts`** - VS Code mocking
- Mocks the VS Code API
- Required for unit tests
- Study this to understand test setup

### 5. Documentation

**`ARCHITECTURE.md`** - System architecture
- High-level design
- Component interactions
- Data flow
- **Read this to understand "why"**

**`WORKFLOW.md`** - Development commands
- All `just` commands explained
- Testing strategies
- Distribution process
- **Your command reference**

---

## Common Workflows

### Running Tests

```bash
# Run all tests (auto-fixes code quality first)
just test

# Run specific test file
just test test/git-sort/sorted-changes-provider.test.ts

# Run tests for specific area
just test git-sort        # All git sort tests
just test services        # All service tests

# Watch mode (TDD)
just test-watch

# With coverage
just test-coverage
```

**Expected**: 461 tests pass, ~7 seconds

### Code Quality

```bash
# Check code quality (read-only)
just check

# Auto-fix issues
just fix

# Find dead code
just knip
```

### Adding a Command

**1. Create command file**: `src/commands/my-feature-command.ts`
```typescript
import * as vscode from "vscode";

export async function execute(): Promise<void> {
  vscode.window.showInformationMessage("My feature works!");
}
```

**2. Register in** `src/extension.ts`:
```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(
    "commandCentral.myFeature",
    async () => {
      const { execute } = await import("./commands/my-feature-command.js");
      await execute();
    }
  )
);
```

**3. Add to** `package.json`:
```json
{
  "contributes": {
    "commands": [
      {
        "command": "commandCentral.myFeature",
        "title": "Command Central: My Feature"
      }
    ]
  }
}
```

**4. Test it**:
- Save all files
- Touch `src/extension.ts` to trigger rebuild (package.json not watched)
- Cmd+R to reload
- Command Palette → "Command Central: My Feature"

### Adding a Test

**1. Create test file**: `test/commands/my-feature-command.test.ts`
```typescript
import { describe, test, expect, mock } from "bun:test";
import * as myFeature from "../../src/commands/my-feature-command.js";

// Mock VS Code API
mock.module("vscode", () => ({
  window: {
    showInformationMessage: mock(),
  },
}));

describe("My Feature Command", () => {
  test("shows success message", async () => {
    await myFeature.execute();

    const vscode = await import("vscode");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "My feature works!"
    );
  });
});
```

**2. Run it**:
```bash
just test test/commands/my-feature-command.test.ts
```

### Building for Distribution

```bash
# Build both dev and production (if new version)
just dist

# Or bump version and build
just dist --patch   # 0.0.1 → 0.0.2
just dist --minor   # 0.1.0 → 0.2.0
just dist --major   # 1.0.0 → 2.0.0

# Preview what would happen
just dist --dry-run
```

**Output**: `releases/command-central-X.X.X.vsix`

### Local Preview (Icons, Assets, UI Changes)

See [LOCAL_PREVIEW.md](LOCAL_PREVIEW.md) for the full workflow: package → install → reload → get feedback. Oste automates this end-to-end including VS Code reload via AppleScript.

---

## Common Tasks

### Task: Debug Extension Activation

**Problem**: Extension not loading

**Solution**:
1. Open Output panel: View → Output
2. Select "Command Central" from dropdown
3. Look for activation errors
4. Check activation time: Should be ~200ms

**Common Issues**:
- Missing dependency: Run `just install`
- Type error: Run `just check`
- Build error: Check terminal running `just dev`

### Task: Debug Git Sort Not Working

**Problem**: Files not appearing in tree

**Solution**:
1. Enable git sort: Command Palette → "Enable Git Sort"
2. Check configuration: `commandCentral.gitSort.enabled` should be `true`
3. Check Output panel: View → Output → "Command Central: Git Sort"
4. Verify git repository exists: `git status` in terminal
5. Make a change to a file and save

**Common Issues**:
- Not a git repository
- No changes to show
- Git extension not enabled

### Task: Add Logging to Debug Issue

**Add logging**:
```typescript
// In any service file
logger.debug("Detailed debug info", { data: someVariable });
logger.info("General information");
logger.warn("Warning message");
logger.error("Error occurred", error);
```

**Enable debug logging**:
```bash
# In terminal
DEBUG_FILTER=1 just dev

# Or use
just debug-filter
```

**View logs**: View → Output → Select appropriate output channel

---

## Getting Help

### Documentation Resources

- **This Guide**: You are here
- **Architecture**: See [ARCHITECTURE.md](../../ARCHITECTURE.md)
- **Workflow**: See [WORKFLOW.md](../../WORKFLOW.md)
- **Testing**: See [TEST_DESIGN_BEST_PRACTICES.md](../../archive/handoffs/TEST_DESIGN_BEST_PRACTICES.md)
- **API Guide**: See [docs/development/API_GUIDE.md](./API_GUIDE.md) (when created)

### Code Navigation

**Find where something is used**:
```bash
# Search code
grep -r "SortedGitChangesProvider" src/

# Find files
find src -name "*provider*"

# Search in specific directory
grep -r "getProviderForFile" src/services/
```

**Use VS Code features**:
- `Cmd+Click` (Mac) or `Ctrl+Click` (Windows) - Go to definition
- `F12` - Go to definition
- `Shift+F12` - Find all references
- `Cmd+P` - Quick file open

### Troubleshooting

#### Build Errors

```bash
# Clean and rebuild
just clean
just dev
```

#### Test Failures

```bash
# Run specific failing test
just test path/to/failing.test.ts

# Check for type errors
just check

# Auto-fix code quality
just fix
```

#### Extension Won't Load

1. Check VS Code version: `code --version` (must be 1.105+)
2. Check Bun version: `bun --version` (must be 1.3+)
3. Check Output panel for errors
4. Try clean rebuild: `just clean && just dev`

#### Hot Reload Not Working

1. Verify `just dev` is still running
2. Check for build errors in terminal
3. Make sure you pressed `Cmd+R` / `Ctrl+R`
4. For package.json changes: Touch a source file to trigger rebuild

---

## Next Steps

Now that you're set up:

1. **Read ARCHITECTURE.md** - Understand the system design
2. **Explore the code** - Start with `src/extension.ts`
3. **Run the tests** - See how we test: `just test`
4. **Make a change** - Pick a small improvement
5. **Read CONTRIBUTING.md** - How to submit your change

### Recommended Reading Order

**For understanding the codebase:**
1. This guide (you are here)
2. [ARCHITECTURE.md](../../ARCHITECTURE.md) - System overview
3. [WORKFLOW.md](../../WORKFLOW.md) - Daily commands
4. [docs/README.md](../README.md) - All documentation

**For contributing:**
1. [CONTRIBUTING.md](../../CONTRIBUTING.md) - Contribution process
2. [docs/standards/CODE_STYLE.md](../standards/CODE_STYLE.md) - Our style
3. [TEST_DESIGN_BEST_PRACTICES.md](../../archive/handoffs/TEST_DESIGN_BEST_PRACTICES.md) - Testing philosophy

---

## Quick Reference Card

```bash
# Daily Development
just dev              # Start dev server (once per session)
# Edit files → Save → Cmd+R → Test
just test             # Before committing
just dist --patch     # Create release

# Code Quality
just check            # Validate (read-only)
just fix              # Auto-fix issues
just knip             # Find dead code

# Testing
just test             # All tests (~7s)
just test-watch       # TDD mode
just test <file>      # Specific test
just test-coverage    # With coverage

# Help
just                  # List all commands
just workflow         # Open WORKFLOW.md
```

---

**Welcome aboard! You're ready to contribute to Command Central.** 🚀

If you have questions or run into issues, check the [docs/](../README.md) or reach out to the team.

---

*Last Updated: 2025-10-24 | Command Central v0.0.35*
