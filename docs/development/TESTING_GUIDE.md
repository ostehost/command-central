# Testing Guide - Command Central

**How to Write Tests That Survive Refactoring**

Version: 0.0.35 | Last Updated: 2025-10-25

---

## Table of Contents

1. [Testing Philosophy](#testing-philosophy)
2. [Writing Bun Tests](#writing-bun-tests)
3. [Observable Effects Pattern](#observable-effects-pattern)
4. [Testing TreeViews](#testing-treeviews)
5. [Common Pitfalls](#common-pitfalls)
6. [Quick Reference](#quick-reference)

---

## Testing Philosophy

### Core Principle: Test Behavior, Not Implementation

**Industry Standard** (Google, Fowler, Beck):
- Tests should verify **what** code does, not **how** it does it
- Tests should survive refactoring without changes
- Tests should focus on **observable effects**

```typescript
// ❌ BAD: Tests implementation
test("filter state stored in Map", () => {
	manager.updateFilter([".ts"]);
	expect(manager["_internalMap"].size).toBe(1); // Internal detail!
});

// ✅ GOOD: Tests observable behavior
test("filter updates VS Code context", async () => {
	await manager.updateFilter([".ts"]);
	// Verifies observable effect
	expect(executeCommandSpy).toHaveBeenCalledWith("setContext", "filter.active", true);
});
```

**Why This Matters**: Refactor the Map to a Set? First test breaks, second survives.

### No Test-Only Methods

**CRITICAL**: Never add methods just for testing.

```typescript
// ❌ BAD: Test-induced design damage
class FilterManager {
	private state: Set<string>;

	// This only exists for tests!
	getState(): Set<string> { return this.state; }
}

// ✅ GOOD: Test observable effects instead
class FilterManager {
	private state: Set<string>;

	updateFilter(extensions: Set<string>): void {
		this.state = extensions;
		// Observable effect: updates context
		vscode.commands.executeCommand("setContext", "filter.active", extensions.size > 0);
	}
}
```

**Test the observable effect** (context update), not the internal state.

---

## Writing Bun Tests

### Basic Structure

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("Feature Name", () => {
	let manager: FeatureManager;

	beforeEach(() => {
		mock.restore(); // Clean slate for each test
		manager = new FeatureManager();
	});

	test("does something observable", () => {
		const result = manager.doThing();
		expect(result).toBe(expected);
	});
});
```

### Running Tests

```bash
# All tests (includes format, lint, typecheck)
just test

# Specific file
just test test/services/project-view-manager.test.ts

# Watch mode (TDD)
just test-watch

# With coverage
just test-coverage
```

### Mocking VS Code API

**Always mock before importing:**

```typescript
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("MyFeature", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock(); // Must run BEFORE dynamic import
	});

	test("uses VS Code API", async () => {
		// Dynamic import AFTER mocking
		const { MyFeature } = await import("../../src/my-feature.js");
		const vscode = await import("vscode");

		const feature = new MyFeature();
		feature.doSomething();

		// Verify mock was called
		expect(vscode.window.showInformationMessage).toHaveBeenCalled();
	});
});
```

**Why dynamic imports?** Bun caches modules. Dynamic imports + `mock.restore()` give each test a clean slate.

---

## Observable Effects Pattern

### What Are Observable Effects?

**Observable effects** are changes visible outside the class:
- Calls to VS Code API (`vscode.commands.executeCommand`, `vscode.window.showInformationMessage`)
- Persistence (`context.globalState.update`, `context.workspaceState.update`)
- EventEmitter firing (`this._onDidChange.fire()`)
- File system operations
- Network requests
- Return values from public methods

### Example: Testing State Persistence

```typescript
// src/services/filter-state.ts
export class FilterStateManager {
	constructor(private context: vscode.ExtensionContext) {}

	async updateFilter(extensions: Set<string>): Promise<void> {
		// Observable effect 1: Persist to global state
		await this.context.globalState.update("filter", Array.from(extensions));

		// Observable effect 2: Update VS Code context
		await vscode.commands.executeCommand(
			"setContext",
			"commandCentral:filterActive",
			extensions.size > 0
		);
	}
}

// test/services/filter-state.test.ts
test("updateFilter persists state and updates context", async () => {
	const mockContext = {
		globalState: {
			update: mock(() => Promise.resolve()),
		},
	};

	const vscode = await import("vscode");
	const manager = new FilterStateManager(mockContext as any);

	await manager.updateFilter(new Set([".ts", ".tsx"]));

	// Verify observable effect 1: Persistence
	expect(mockContext.globalState.update).toHaveBeenCalledWith(
		"filter",
		[".ts", ".tsx"]
	);

	// Verify observable effect 2: Context update
	expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
		"setContext",
		"commandCentral:filterActive",
		true
	);
});
```

**No internal state inspection needed!**

### Example: Testing EventEmitter

```typescript
// src/providers/my-provider.ts
export class MyProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	refresh(): void {
		// Observable effect: Event fires
		this._onDidChange.fire();
	}
}

// test/providers/my-provider.test.ts
test("refresh fires onDidChange event", () => {
	const provider = new MyProvider();

	const spy = mock(() => {});
	provider.onDidChange(spy); // Subscribe to event

	provider.refresh();

	// Verify observable effect: Event was fired
	expect(spy).toHaveBeenCalled();
});
```

---

## Testing TreeViews

### The TreeView Pattern

**Command Central's TreeViews** follow VS Code's `TreeDataProvider` pattern:
- Provider implements `getChildren()` and `getTreeItem()`
- Provider fires `EventEmitter` to trigger refresh
- VS Code calls `getChildren()` to rebuild tree

**Key insight**: We never call `getChildren()` directly in production code. VS Code does.

### Testing TreeView Observable Effects

```typescript
// ✅ CORRECT: Test what VS Code sees
test("TreeView registration creates view with correct ID", () => {
	const vscode = await import("vscode");

	const manager = new ProjectViewManager(mockContext, ...deps);
	await manager.registerAllProjects();

	// Observable effect: createTreeView called
	expect(vscode.window.createTreeView).toHaveBeenCalledWith(
		"commandCentral.project.slot1",
		expect.objectContaining({
			treeDataProvider: expect.any(Object),
			showCollapseAll: true,
		})
	);
});

// ✅ CORRECT: Test TreeView added to subscriptions
test("TreeView registered for disposal", () => {
	const mockContext = { subscriptions: [] };

	new ProjectViewManager(mockContext, ...deps);

	// Observable effect: Added to subscriptions
	expect(mockContext.subscriptions.length).toBeGreaterThan(0);
});

// ✅ CORRECT: Test refresh triggers tree update
test("refresh fires onDidChangeTreeData", () => {
	const provider = new SortedGitChangesProvider(...deps);

	const refreshSpy = mock(() => {});
	provider.onDidChangeTreeData(refreshSpy); // Subscribe

	provider.refresh();

	// Observable effect: Event fired
	expect(refreshSpy).toHaveBeenCalled();
});

// ❌ WRONG: Don't test internal TreeView implementation
test("TreeView has correct visibility", () => {
	const manager = new Manager();
	// BAD: Accessing private TreeView
	expect(manager["_treeView"].visible).toBe(true);
});
```

### Testing TreeView Visibility

**Problem**: TreeView visibility is controlled by VS Code, not directly testable.

**Solution**: Test the observable effects that control visibility:

```typescript
// ✅ CORRECT: Test persistence and context (what controls visibility)
test("toggle hides TreeView by updating state", async () => {
	const mockContext = {
		globalState: {
			get: mock(() => true),
			update: mock(() => Promise.resolve()),
		},
	};

	const manager = new GroupingViewManager(mockContext, ...deps);
	await manager.toggle();

	// Observable effect 1: State persisted
	expect(mockContext.globalState.update).toHaveBeenCalledWith(
		"commandCentral.grouping.visible",
		false
	);

	// Observable effect 2: Context updated (controls "when" clause)
	const vscode = await import("vscode");
	expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
		"setContext",
		"commandCentral:groupingVisible",
		false
	);
});
```

**VS Code uses the context** (`commandCentral:groupingVisible`) in `package.json` "when" clauses to control visibility. We test the context update, not the visibility itself.

---

## Common Pitfalls

### 1. Testing Internal State

```typescript
// ❌ WRONG
test("filter stored correctly", () => {
	manager.setFilter([".ts"]);
	expect(manager["_filter"]).toEqual(new Set([".ts"])); // Private field!
});

// ✅ CORRECT
test("filter persisted to global state", async () => {
	await manager.setFilter([".ts"]);
	expect(mockContext.globalState.update).toHaveBeenCalledWith("filter", [".ts"]);
});
```

### 2. Testing Methods Instead of Behaviors

```typescript
// ❌ WRONG: One test per method
test("processTransaction does everything", async () => {
	await processor.processTransaction(100);
	expect(ui.message).toBe("Done");
	expect(email.sent).toBe(true);
	expect(db.balance).toBe(50);
});

// ✅ CORRECT: One test per behavior
test("processTransaction displays completion message", async () => {
	await processor.processTransaction(100);
	expect(ui.message).toBe("Done");
});

test("processTransaction sends low balance email when needed", async () => {
	await processor.processTransaction(95);
	expect(email.sent).toBe(true);
	expect(email.subject).toContain("Low Balance");
});
```

### 3. Not Cleaning Up Mocks

```typescript
// ❌ WRONG: Mocks leak between tests
test("test 1", () => {
	mock.module("vscode", () => ({ ... }));
	// No cleanup!
});

// ✅ CORRECT: Clean slate for each test
beforeEach(() => {
	mock.restore(); // Reset all mocks
	setupVSCodeMock();
});
```

### 4. Static Imports When Mocking

```typescript
// ❌ WRONG: Static import before mocking
import { MyFeature } from "../../src/my-feature.js";

beforeEach(() => {
	setupVSCodeMock(); // Too late! Module already loaded
});

// ✅ CORRECT: Dynamic import after mocking
beforeEach(() => {
	mock.restore();
	setupVSCodeMock();
});

test("feature works", async () => {
	const { MyFeature } = await import("../../src/my-feature.js");
	// ...
});
```

---

## Quick Reference

### Test Structure Template

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("FeatureName", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	test("specific behavior description", async () => {
		// Arrange: Set up test data
		const mockContext = { /* ... */ };
		const { Feature } = await import("../../src/feature.js");
		const feature = new Feature(mockContext);

		// Act: Trigger behavior
		await feature.doSomething();

		// Assert: Verify observable effects
		expect(mockContext.globalState.update).toHaveBeenCalled();
	});
});
```

### Observable Effects Checklist

When writing a test, verify **observable effects only**:

- ✅ Return values from public methods
- ✅ VS Code API calls (commands, messages, etc.)
- ✅ State persistence (globalState, workspaceState)
- ✅ EventEmitter fires
- ✅ File system changes
- ✅ Network requests
- ❌ Private field values
- ❌ Internal data structures
- ❌ Implementation details

### Common Assertions

```typescript
// Context updates
expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
	"setContext",
	"key",
	value
);

// State persistence
expect(mockContext.globalState.update).toHaveBeenCalledWith("key", value);

// User messages
expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("message");

// Event firing
const spy = mock(() => {});
provider.onDidChange(spy);
provider.refresh();
expect(spy).toHaveBeenCalled();

// TreeView creation
expect(vscode.window.createTreeView).toHaveBeenCalledWith(
	"viewId",
	expect.objectContaining({ treeDataProvider: expect.any(Object) })
);
```

---

## References

- **Test Design Philosophy**: [archive/handoffs/TEST_DESIGN_BEST_PRACTICES.md](../../archive/handoffs/TEST_DESIGN_BEST_PRACTICES.md)
- **Example Tests**: [test/ui/grouping-view-manager.test.ts](../../test/ui/grouping-view-manager.test.ts)
- **VS Code Mock**: [test/helpers/vscode-mock.ts](../../test/helpers/vscode-mock.ts)
- **Bun Testing**: [https://bun.sh/docs/cli/test](https://bun.sh/docs/cli/test)

**Industry Sources**:
- [Google Testing Blog: Test Behavior, Not Implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)
- [Martin Fowler: Unit Testing](https://martinfowler.com/bliki/UnitTest.html)
- [Kent Beck: Test-Driven Development](https://www.amazon.com/Test-Driven-Development-Kent-Beck/dp/0321146530)

---

*Last Updated: 2025-10-25 | Command Central v0.0.35*
