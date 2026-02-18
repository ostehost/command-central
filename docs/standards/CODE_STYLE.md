# Code Style Guide - Command Central

**Coding Conventions and Best Practices**

Version: 0.0.35 | Last Updated: 2025-10-25

---

## Table of Contents

1. [Overview](#overview)
2. [Formatting (Biome)](#formatting-biome)
3. [TypeScript Conventions](#typescript-conventions)
4. [Function Design](#function-design)
5. [Naming Conventions](#naming-conventions)
6. [Comments and Documentation](#comments-and-documentation)
7. [Architecture Patterns](#architecture-patterns)
8. [File Organization](#file-organization)
9. [Error Handling](#error-handling)
10. [Testing Conventions](#testing-conventions)

---

## Overview

Command Central follows **industry best practices** from Google, Martin Fowler, and Kent Beck, with a focus on:

- **Type Safety**: Full TypeScript strict mode, no `any` types
- **Observable Effects**: Test behavior, not implementation
- **Dependency Injection**: All dependencies explicit
- **Single Responsibility**: Each module does one thing well
- **Performance First**: Sub-second builds, sub-200ms activation

**Automated Enforcement**:
- Formatting: Biome (`just check`, `just fix`)
- Type Checking: TypeScript strict mode (`just test` includes `tsc --noEmit`)
- Linting: Biome rules (defined in `biome.json`)
- Dead Code: Knip (`just knip`)

---

## Formatting (Biome)

### Automated Formatting

**All code is automatically formatted by Biome.** You don't need to think about formatting - just write code and run:

```bash
# Check formatting (read-only)
just check

# Auto-fix formatting
just fix
```

### Biome Configuration

From `biome.json`:

```json
{
  "formatter": {
    "indentStyle": "tab",        // Use tabs, not spaces
    "indentWidth": 2,            // Tab width = 2
    "lineWidth": 80,             // Max 80 characters per line
    "lineEnding": "lf"           // Unix line endings
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double"     // Use "double quotes"
    }
  }
}
```

**Key Rules**:
- ✅ Tabs (not spaces) for indentation
- ✅ 80 character line width
- ✅ Double quotes for strings
- ✅ LF line endings (Unix)

### Example

```typescript
// ✅ CORRECT: Biome-compliant
export function activateGitSort(
	context: vscode.ExtensionContext,
	logger: LoggerService,
): Promise<void> {
	logger.info("Activating git sort feature");
	return Promise.resolve();
}

// ❌ WRONG: Spaces, single quotes, > 80 chars
export function activateGitSort(context: vscode.ExtensionContext, logger: LoggerService): Promise<void> {
  logger.info('Activating git sort feature');
  return Promise.resolve();
}
```

---

## TypeScript Conventions

### Strict Mode

**ALL code uses TypeScript strict mode.** No exceptions.

From `tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,               // Enable all strict checks
    "noEmit": true,               // Type check only (Bun builds)
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler"
  }
}
```

### Type Annotations

**Explicit types for all exported functions:**

```typescript
// ✅ CORRECT: Explicit return type
export function getWorkspaceFolders(): vscode.WorkspaceFolder[] {
	return vscode.workspace.workspaceFolders ?? [];
}

// ❌ WRONG: Inferred return type
export function getWorkspaceFolders() {
	return vscode.workspace.workspaceFolders ?? [];
}
```

**Explicit types for class properties:**

```typescript
// ✅ CORRECT: Explicit types
class ProjectViewManager {
	private registeredViews: Map<string, vscode.TreeView<unknown>>;
	private reloadInProgress: boolean = false;

	constructor(private logger: LoggerService) {}
}

// ❌ WRONG: Implicit types
class ProjectViewManager {
	private registeredViews;
	private reloadInProgress = false;
}
```

### No `any` Types

**Biome enforces `noExplicitAny: error`.** Use specific types or `unknown`:

```typescript
// ✅ CORRECT: Specific type
function processConfig(config: ProjectConfig): void {
	// ...
}

// ✅ CORRECT: Unknown when type is truly unknown
function processUnknown(data: unknown): void {
	if (isProjectConfig(data)) {
		// Type narrowing
	}
}

// ❌ WRONG: any type
function processConfig(config: any): void {
	// ...
}
```

**Exception**: Test files allow `any` for mocking (configured in `biome.json`).

### Import Types

**Use `import type` for type-only imports:**

```typescript
// ✅ CORRECT: Type-only import
import type { LoggerService } from "./logger-service.js";
import type { ProjectConfig } from "../types/project.js";

// ❌ WRONG: Regular import for types
import { LoggerService } from "./logger-service.js";
```

**Biome enforces this**: `useImportType: error`

### ESM Modules

**All imports must use `.js` extension** (even for `.ts` files):

```typescript
// ✅ CORRECT: .js extension
import { SortedGitChangesProvider } from "./sorted-changes-provider.js";

// ❌ WRONG: Missing extension
import { SortedGitChangesProvider } from "./sorted-changes-provider";

// ❌ WRONG: .ts extension
import { SortedGitChangesProvider } from "./sorted-changes-provider.ts";
```

---

## Function Design

### Maximum Length: 30 Lines

**Functions must be ≤ 30 lines.** Extract helpers if longer:

```typescript
// ✅ CORRECT: Small, focused function
async function registerProject(config: ProjectViewConfig): Promise<void> {
	const provider = await this.createProvider(config);
	const treeView = this.createTreeView(config, provider);
	this.registeredViews.set(config.id, treeView);
}

// ❌ WRONG: > 30 lines, doing too much
async function registerProject(config: ProjectViewConfig): Promise<void> {
	// 50+ lines of provider creation, tree view setup, event handlers, etc.
}
```

### Single Responsibility

**Each function does ONE thing:**

```typescript
// ✅ CORRECT: Clear single purpose
function getWorkspaceName(folder: vscode.WorkspaceFolder): string {
	return path.basename(folder.uri.fsPath);
}

// ❌ WRONG: Multiple responsibilities
function getWorkspaceNameAndIcon(folder: vscode.WorkspaceFolder): [string, string] {
	const name = path.basename(folder.uri.fsPath);
	const icon = folder.index < 6 ? ICONS[folder.index] : ICONS[0];
	return [name, icon];
}
```

### Maximum Nesting: 3 Levels

**No more than 3 levels of nesting.** Use early returns:

```typescript
// ✅ CORRECT: Early returns, max 2 levels
function processFile(uri: vscode.Uri): boolean {
	if (!uri) return false;
	if (!this.isTracked(uri)) return false;

	const provider = this.getProvider(uri);
	if (!provider) return false;

	provider.reveal(uri);
	return true;
}

// ❌ WRONG: 4 levels of nesting
function processFile(uri: vscode.Uri): boolean {
	if (uri) {
		if (this.isTracked(uri)) {
			const provider = this.getProvider(uri);
			if (provider) {
				provider.reveal(uri);
				return true;
			}
		}
	}
	return false;
}
```

### Explicit Return Types

**All functions must declare return types:**

```typescript
// ✅ CORRECT: Explicit return type
async function loadConfig(): Promise<ProjectConfig[]> {
	const configs = await this.readConfigFile();
	return configs;
}

// ❌ WRONG: Inferred return type
async function loadConfig() {
	const configs = await this.readConfigFile();
	return configs;
}
```

---

## Naming Conventions

### Classes and Interfaces

**PascalCase**:

```typescript
// ✅ CORRECT
class ProjectViewManager {}
interface ProjectConfig {}
type SortOrder = "newest" | "oldest";

// ❌ WRONG
class projectViewManager {}
interface project_config {}
```

### Functions and Variables

**camelCase**:

```typescript
// ✅ CORRECT
function getActiveFile(): vscode.Uri | undefined {}
const isEnabled = true;
let currentProvider: SortedGitChangesProvider;

// ❌ WRONG
function GetActiveFile() {}
const is_enabled = true;
```

### Constants

**UPPER_SNAKE_CASE** for true constants:

```typescript
// ✅ CORRECT
const MAX_WORKSPACE_FOLDERS = 10;
const DEFAULT_ICON = "📁";

// ❌ WRONG
const maxWorkspaceFolders = 10;
const defaultIcon = "📁";
```

### Private Class Members

**Prefix with underscore** ONLY for EventEmitter backing fields:

```typescript
// ✅ CORRECT: EventEmitter pattern
class Manager {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

	// Regular private fields - no underscore
	private cache = new Map<string, string>();
}

// ❌ WRONG: Underscore for regular private fields
class Manager {
	private _cache = new Map<string, string>();
}
```

### File Names

**kebab-case**:

```
✅ CORRECT:
src/services/project-view-manager.ts
src/git-sort/sorted-changes-provider.ts

❌ WRONG:
src/services/ProjectViewManager.ts
src/git-sort/SortedChangesProvider.ts
```

---

## Comments and Documentation

### Principle: Comment WHY, Not WHAT

```typescript
// ✅ CORRECT: Explains why
// Changed from WeakMap to Map to allow iteration for active file tracking
private treeViewProviders = new Map<TreeView, Provider>();

// ❌ WRONG: Explains what (code is self-documenting)
// This is a map that stores tree view providers
private treeViewProviders = new Map<TreeView, Provider>();
```

### JSDoc for Public APIs

**All exported classes/functions get JSDoc:**

```typescript
/**
 * Manages dynamic registration of project views
 *
 * Lifecycle:
 * 1. registerAllProjects() - Load config, create providers, register views
 * 2. dispose() - Clean up views (factory cleanup handled separately)
 *
 * Design Philosophy:
 * - Manager orchestrates, doesn't create
 * - All creation delegated to factories
 */
export class ProjectViewManager {
	// ...
}
```

### Requirements Traceability

**Link code to requirements in file headers:**

```typescript
/**
 * Project View Manager
 *
 * Requirements:
 * - REQ-AR-001: Manager pattern for view registration
 * - REQ-VR-002: Dynamic view activation
 * - REQ-DI-001: Dependency injection for abstractions
 *
 * Architecture:
 * - Depends on ProjectConfigSource (where projects come from)
 * - Depends on ProviderFactory (how providers are created)
 */
```

### TODO/FIXME Format

**Use standard format for tracking:**

```typescript
// TODO: Implement pagination for large file lists
// FIXME: Race condition when switching workspaces rapidly
// HACK: Workaround for VS Code API limitation (remove when #12345 fixed)
```

---

## Architecture Patterns

### Dependency Injection

**Constructor injection for all dependencies:**

```typescript
// ✅ CORRECT: Constructor injection
export class ProjectViewManager {
	constructor(
		private context: vscode.ExtensionContext,
		private logger: LoggerService,
		private configSource: ProjectConfigSource,
		private providerFactory: ProviderFactory,
	) {}
}

// ❌ WRONG: Global access, hardcoded dependencies
export class ProjectViewManager {
	constructor() {
		this.logger = getGlobalLogger();  // Tight coupling
		this.config = new FileConfigSource();  // Can't test
	}
}
```

### Observable Effects (No Test-Only Methods)

**CRITICAL**: Never add methods just for testing.

```typescript
// ✅ CORRECT: Test observable effects
class FilterStateManager {
	updateFilter(extensions: Set<string>): void {
		this.state = extensions;
		// Observable effect: updates context
		vscode.commands.executeCommand("setContext", "filter.active", extensions.size > 0);
	}
}

// Test: Verify context was set (observable)
await manager.updateFilter(new Set([".ts"]));
expect(executeCommandSpy).toHaveBeenCalledWith("setContext", "filter.active", true);

// ❌ WRONG: Test-induced design damage
class FilterStateManager {
	private state: Set<string>;

	// DON'T DO THIS - only exists for tests!
	getState(): Set<string> {
		return this.state;
	}
}

// Test: Inspects internal state (fragile)
await manager.updateFilter(new Set([".ts"]));
expect(manager.getState()).toEqual(new Set([".ts"]));
```

**See [TESTING_GUIDE.md](../development/TESTING_GUIDE.md) for more on observable effects testing.**

### Prefer Composition Over Inheritance

```typescript
// ✅ CORRECT: Composition
class ProjectViewManager {
	constructor(
		private logger: LoggerService,
		private factory: ProviderFactory,
	) {}
}

// ❌ WRONG: Inheritance (tight coupling)
class ProjectViewManager extends BaseManager {
	// Inherits logger, config, etc.
}
```

### Immutability Where Possible

```typescript
// ✅ CORRECT: Immutable operations
function addExtension(extensions: Set<string>, ext: string): Set<string> {
	return new Set([...extensions, ext]);
}

// ❌ WRONG: Mutation
function addExtension(extensions: Set<string>, ext: string): void {
	extensions.add(ext);
}
```

---

## File Organization

### Directory Structure

```
src/
├── commands/           # Command handlers
├── config/             # Configuration sources
├── factories/          # Provider factories
├── git-sort/           # Git sort feature
├── providers/          # TreeView providers
├── security/           # Security service
├── services/           # Business logic services
├── state/              # State managers
├── types/              # TypeScript types
├── ui/                 # UI components
├── utils/              # Utility functions
└── extension.ts        # Entry point

test/
├── commands/           # Command tests
├── git-sort/           # Git sort tests
├── helpers/            # Test helpers
├── integration/        # Integration tests
├── services/           # Service tests
└── ui/                 # UI tests
```

### File Naming

**Pattern**: `feature-name.ts` for implementation, `feature-name.test.ts` for tests

```
✅ CORRECT:
src/services/project-view-manager.ts
test/services/project-view-manager.test.ts

❌ WRONG:
src/services/ProjectViewManager.ts
test/services/project-view-manager-test.ts
```

### Imports Order

1. VS Code API
2. Node.js built-ins
3. Third-party packages
4. Local imports (relative paths)

```typescript
// ✅ CORRECT: Organized imports
import * as vscode from "vscode";
import * as path from "node:path";
import { watch } from "fs";
import type { LoggerService } from "./logger-service.js";
import { getWorkspaceFolders } from "../utils/workspace.js";

// ❌ WRONG: Random order
import { getWorkspaceFolders } from "../utils/workspace.js";
import * as vscode from "vscode";
import type { LoggerService } from "./logger-service.js";
```

---

## Error Handling

### Catch Specific Exceptions

```typescript
// ✅ CORRECT: Specific error handling
try {
	await this.loadConfig();
} catch (error) {
	if (error instanceof SyntaxError) {
		logger.error("Invalid JSON in config file", error);
	} else if (error instanceof Error) {
		logger.error("Failed to load config", error);
	} else {
		logger.error("Unknown error", { error });
	}
	throw error;
}

// ❌ WRONG: Generic catch-all
try {
	await this.loadConfig();
} catch (error) {
	console.log("Error");  // No context!
}
```

### Include Context in Error Messages

```typescript
// ✅ CORRECT: Helpful context
throw new Error(`Failed to create provider for workspace "${workspaceName}": ${error.message}`);

// ❌ WRONG: Vague error
throw new Error("Failed");
```

### User-Facing vs Internal Errors

```typescript
// ✅ CORRECT: User-facing error (friendly)
vscode.window.showErrorMessage("Could not load workspace. Please check your settings.");

// Internal logging (technical)
logger.error("Failed to parse workspace config", {
	path: configPath,
	error: error.message,
});

// ❌ WRONG: Technical error shown to user
vscode.window.showErrorMessage(`TypeError: Cannot read property 'uri' of undefined at line 42`);
```

---

## Testing Conventions

### Test File Location

**Mirror src/ structure:**

```
src/services/project-view-manager.ts
→ test/services/project-view-manager.test.ts

src/git-sort/sorted-changes-provider.ts
→ test/git-sort/sorted-changes-provider.test.ts
```

### Test Structure

**Use Bun's `describe` and `test`:**

```typescript
import { describe, test, expect, beforeEach } from "bun:test";

describe("ProjectViewManager", () => {
	let manager: ProjectViewManager;

	beforeEach(() => {
		manager = new ProjectViewManager(/* deps */);
	});

	test("registers all workspace folders", async () => {
		await manager.registerAllProjects();

		expect(manager.getRegisteredViewCount()).toBe(2);
	});
});
```

### Test Observable Effects, Not Implementation

**See [TESTING_GUIDE.md](../development/TESTING_GUIDE.md) for comprehensive guide.**

```typescript
// ✅ CORRECT: Test observable behavior
test("updates VS Code context when filter changes", async () => {
	await manager.updateFilter(new Set([".ts"]));

	// Verify observable effect
	expect(executeCommandSpy).toHaveBeenCalledWith(
		"setContext",
		"filter.active",
		true
	);
});

// ❌ WRONG: Test internal state
test("stores filter in private field", () => {
	manager.updateFilter(new Set([".ts"]));

	// Accessing private field = test-induced design damage
	expect(manager["_filter"]).toEqual(new Set([".ts"]));
});
```

---

## Quick Reference

### Before Committing

```bash
# 1. Format code
just fix

# 2. Check types and run tests
just test

# 3. Check for dead code
just knip
```

### Common Patterns

**Lazy Loading:**
```typescript
vscode.commands.registerCommand("cmd", async () => {
	const { execute } = await import("./commands/feature.js");
	await execute();
});
```

**EventEmitter Pattern:**
```typescript
private readonly _onDidChange = new vscode.EventEmitter<void>();
readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

// Trigger event
this._onDidChange.fire();
```

**Disposal:**
```typescript
async dispose(): Promise<void> {
	this.views.forEach(v => v.dispose());
	this.views.clear();
	await this.storage?.dispose();
}
```

---

## References

- **Biome Configuration**: [biome.json](../../biome.json)
- **TypeScript Config**: [tsconfig.json](../../tsconfig.json)
- **Bun Toolchain**: [CLAUDE.md](../../CLAUDE.md)
- **Testing Guide**: [docs/development/TESTING_GUIDE.md](../development/TESTING_GUIDE.md)
- **Architecture**: [ARCHITECTURE.md](../../ARCHITECTURE.md)

---

*Last Updated: 2025-10-25 | Command Central v0.0.35*
