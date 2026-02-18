# API Guide - Command Central

**Internal APIs and Extension Points**

Version: 0.0.35 | Last Updated: 2025-10-25

---

## Table of Contents

1. [Core Services](#core-services)
2. [TreeView Providers](#treeview-providers)
3. [State Management](#state-management)
4. [Extension Points](#extension-points)
5. [Adding Commands](#adding-commands)

---

## Core Services

### ProjectViewManager

**Purpose**: Orchestrates all workspace folder views and command routing.

**Location**: `src/services/project-view-manager.ts`

**Key Methods**:

```typescript
class ProjectViewManager {
	// Lifecycle
	async registerAllProjects(): Promise<void>
	async reload(): Promise<void>
	async dispose(): Promise<void>

	// Provider access
	getProviderForFile(uri: vscode.Uri): SortedGitChangesProvider | undefined
	getAllProviders(): SortedGitChangesProvider[]

	// View access
	getRegisteredViewCount(): number

	// Events
	readonly onProvidersReady: vscode.Event<void>
}
```

**Usage Example**:

```typescript
// Get provider for active file
const activeFile = vscode.window.activeTextEditor?.document.uri;
if (activeFile) {
	const provider = viewManager.getProviderForFile(activeFile);
	provider?.reveal(activeFile);
}

// Execute command on all providers
for (const provider of viewManager.getAllProviders()) {
	await provider.refresh();
}
```

**Dependency Injection**:

```typescript
// Composition root (src/extension.ts)
const viewManager = new ProjectViewManager(
	context,
	logger,
	configSource,      // Where projects come from
	providerFactory     // How providers are created
);
```

---

### LoggerService

**Purpose**: Centralized logging with output channels.

**Location**: `src/services/logger-service.ts`

**API**:

```typescript
class LoggerService {
	// Logging
	debug(message: string, data?: Record<string, unknown>): void
	info(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
	error(message: string, error?: Error | unknown): void

	// Configuration
	setLogLevel(level: LogLevel): void
	getLogLevel(): LogLevel

	// Output channel
	show(): void
	hide(): void
	clear(): void
}

enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}
```

**Usage Example**:

```typescript
// Basic logging
logger.info("Extension activated");
logger.debug("Loading config", { path: configPath });
logger.warn("Large file count detected");
logger.error("Failed to load config", error);

// Configure log level
logger.setLogLevel(LogLevel.DEBUG);

// Show output channel
logger.show();
```

**Creating Loggers**:

```typescript
// In composition root (src/extension.ts)
const mainLogger = new LoggerService("Command Central", LogLevel.INFO);
const gitSortLogger = new LoggerService("Command Central: Git Sort", LogLevel.INFO);
```

---

### GitStatusCache

**Purpose**: Caches Git API queries for performance.

**Location**: `src/services/git-status-cache.ts`

**API**:

```typescript
class GitStatusCache {
	// Get repository for workspace
	getRepository(workspaceFolder: vscode.WorkspaceFolder): Repository | undefined

	// Get all repositories
	getAllRepositories(): Repository[]

	// Query git status (cached)
	async getChanges(workspaceFolder: vscode.WorkspaceFolder): Promise<Change[]>

	// Cache invalidation
	invalidate(workspaceFolder?: vscode.WorkspaceFolder): void

	// Events
	readonly onDidChange: vscode.Event<vscode.WorkspaceFolder | undefined>
}
```

**Usage Example**:

```typescript
// Get changes for workspace
const changes = await gitCache.getChanges(workspaceFolder);

// Invalidate cache on git operations
await runGitCommand();
gitCache.invalidate(workspaceFolder);

// React to changes
gitCache.onDidChange((folder) => {
	logger.info(`Git status changed for ${folder?.name}`);
});
```

---

### SecurityService

**Purpose**: Validates and sanitizes user inputs for security.

**Location**: `src/security/security-service.ts`

**API**:

```typescript
class SecurityService {
	// Path validation
	async validateTerminalPath(path: string): Promise<boolean>

	// Workspace trust
	isWorkspaceTrusted(): boolean
}
```

**Usage Example**:

```typescript
// Validate terminal path before execution
const terminalPath = config.get<string>("terminal.app");
if (terminalPath && await securityService.validateTerminalPath(terminalPath)) {
	await launchTerminal(terminalPath);
} else {
	vscode.window.showErrorMessage("Invalid terminal path");
}

// Check workspace trust
if (!securityService.isWorkspaceTrusted()) {
	vscode.window.showWarningMessage("This operation requires workspace trust");
	return;
}
```

---

## TreeView Providers

### SortedGitChangesProvider

**Purpose**: TreeView provider for sorted git changes.

**Location**: `src/git-sort/sorted-changes-provider.ts`

**VS Code Interface**:

```typescript
class SortedGitChangesProvider implements vscode.TreeDataProvider<TreeElement> {
	// VS Code TreeDataProvider interface
	readonly onDidChangeTreeData: vscode.Event<TreeElement | undefined>
	getChildren(element?: TreeElement): Promise<TreeElement[]>
	getTreeItem(element: TreeElement): vscode.TreeItem

	// Lifecycle
	async dispose(): Promise<void>

	// User actions
	refresh(): void
	toggleSortOrder(): Promise<void>
	changeFileFilter(): Promise<void>

	// TreeView registration
	registerTreeView(
		treeView: vscode.TreeView<TreeElement>,
		location: "activityBar" | "panel"
	): void

	// Active file tracking
	reveal(uri: vscode.Uri): Promise<void>

	// Title management
	updateTitle(newTitle: string): void
}
```

**Type Definitions**:

```typescript
// Tree element types
type TreeElement = GitStatusGroup | TimeGroup | GitChangeItem;

interface GitChangeItem {
	type?: "gitChangeItem"; // Type discriminant
	uri: vscode.Uri;
	status: string;
	isStaged: boolean;
	timestamp?: number;
	order?: number; // For deleted files
	parentType?: "staged" | "unstaged"; // Parent context for unique tree IDs
	contextValue?: string; // For menu visibility
}

interface TimeGroup {
	type: "timeGroup";
	label: string;
	timePeriod: "today" | "yesterday" | "last7days" | ...;
	children: GitChangeItem[];
}

interface GitStatusGroup {
	type: "statusGroup";
	status: "staged" | "unstaged";
	children: TimeGroup[];
}
```

**Usage Example**:

```typescript
// Create provider
const provider = new SortedGitChangesProvider(
	workspaceFolder,
	logger,
	extensionFilterState,
	groupingStateManager,
	gitStatusCache,
	storageAdapter
);

// Register TreeView
const treeView = vscode.window.createTreeView("myView", {
	treeDataProvider: provider,
	showCollapseAll: true,
});
provider.registerTreeView(treeView, "activityBar");

// Trigger refresh
provider.refresh();

// Reveal active file
const activeUri = vscode.window.activeTextEditor?.document.uri;
if (activeUri) {
	await provider.reveal(activeUri);
}
```

---

## State Management

### ExtensionFilterState

**Purpose**: Manages file extension filtering across workspaces.

**Location**: `src/services/extension-filter-state.ts`

**API**:

```typescript
class ExtensionFilterState {
	// Get/set active extensions
	getActiveExtensions(workspaceId: string): Set<string>
	async setActiveExtensions(
		workspaceId: string,
		extensions: Set<string>
	): Promise<void>

	// Clear filters
	async clearFilter(workspaceId: string): Promise<void>
	async clearAllFilters(): Promise<void>

	// Events
	readonly onDidChangeFilter: vscode.Event<{
		workspaceId: string;
		extensions: Set<string>;
	}>
}
```

**Usage Example**:

```typescript
// Set filter for workspace
await filterState.setActiveExtensions("workspace-1", new Set([".ts", ".tsx"]));

// Get current filter
const active = filterState.getActiveExtensions("workspace-1");
console.log(active); // Set([".ts", ".tsx"])

// Clear filter
await filterState.clearFilter("workspace-1");

// React to changes
filterState.onDidChangeFilter(({ workspaceId, extensions }) => {
	logger.info(`Filter changed for ${workspaceId}`, { extensions: Array.from(extensions) });
});
```

---

### GroupingStateManager

**Purpose**: Manages git status grouping (staged/unstaged) state.

**Location**: `src/services/grouping-state-manager.ts`

**API**:

```typescript
class GroupingStateManager {
	// Enable/disable grouping
	async enableGrouping(): Promise<void>
	async disableGrouping(): Promise<void>

	// Query state
	isGroupingEnabled(): boolean

	// Events
	readonly onDidChangeGrouping: vscode.Event<boolean>
}
```

**Usage Example**:

```typescript
// Enable grouping
await groupingManager.enableGrouping();

// Check state
if (groupingManager.isGroupingEnabled()) {
	// Render with git status groups
}

// React to changes
groupingManager.onDidChangeGrouping((enabled) => {
	provider.refresh();
});
```

---

## Extension Points

### Adding a Provider

**1. Create Provider Class**:

```typescript
// src/providers/my-feature-provider.ts
export class MyFeatureProvider implements vscode.TreeDataProvider<MyElement> {
	private _onDidChangeTreeData = new vscode.EventEmitter<MyElement | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private logger: LoggerService,
		private config: MyConfig
	) {}

	getChildren(element?: MyElement): Promise<MyElement[]> {
		// Return tree structure
	}

	getTreeItem(element: MyElement): vscode.TreeItem {
		// Convert to TreeItem
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
```

**2. Register in package.json**:

```json
{
	"contributes": {
		"views": {
			"commandCentral": [
				{
					"id": "commandCentral.myFeature",
					"name": "My Feature"
				}
			]
		}
	}
}
```

**3. Create TreeView in extension.ts**:

```typescript
// src/extension.ts
const myProvider = new MyFeatureProvider(logger, config);
const myTreeView = vscode.window.createTreeView("commandCentral.myFeature", {
	treeDataProvider: myProvider,
	showCollapseAll: true,
});
context.subscriptions.push(myTreeView);
```

---

### Adding a Service

**1. Create Service Class**:

```typescript
// src/services/my-service.ts
export class MyService {
	constructor(
		private logger: LoggerService,
		private context: vscode.ExtensionContext
	) {}

	async doSomething(): Promise<void> {
		this.logger.info("Doing something");
		// Implementation
	}

	async dispose(): Promise<void> {
		// Cleanup
	}
}
```

**2. Add to Composition Root**:

```typescript
// src/extension.ts
export async function activate(context: vscode.ExtensionContext) {
	const logger = new LoggerService("My Service");
	const myService = new MyService(logger, context);

	// Use service
	await myService.doSomething();

	// Register for disposal
	context.subscriptions.push({ dispose: () => myService.dispose() });
}
```

---

## Adding Commands

### Command Registration Pattern

**1. Create Command File**:

```typescript
// src/commands/my-command.ts
import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";

export async function execute(
	logger: LoggerService,
	arg?: unknown
): Promise<void> {
	logger.info("Command executed", { arg });
	vscode.window.showInformationMessage("Command executed!");
}
```

**2. Register in package.json**:

```json
{
	"contributes": {
		"commands": [
			{
				"command": "commandCentral.myCommand",
				"title": "Command Central: My Command",
				"icon": "$(symbol-event)"
			}
		],
		"menus": {
			"view/title": [
				{
					"command": "commandCentral.myCommand",
					"when": "view == commandCentral.project.slot1",
					"group": "navigation"
				}
			]
		}
	}
}
```

**3. Register in extension.ts**:

```typescript
// src/extension.ts
context.subscriptions.push(
	vscode.commands.registerCommand(
		"commandCentral.myCommand",
		async (arg?: unknown) => {
			const { execute } = await import("./commands/my-command.js");
			await execute(logger, arg);
		}
	)
);
```

**Benefits**:
- Lazy loading (command imported only when executed)
- Type safety
- Dependency injection
- Testable

---

### Command with Provider Context

**When command needs workspace-specific provider**:

```typescript
// src/commands/refresh-view.ts
import type { ProjectViewManager } from "../services/project-view-manager.js";

export async function execute(
	viewManager: ProjectViewManager,
	uri?: vscode.Uri
): Promise<void> {
	// Get provider for file
	const provider = uri
		? viewManager.getProviderForFile(uri)
		: viewManager.getAllProviders()[0];

	if (provider) {
		provider.refresh();
	}
}

// Register
vscode.commands.registerCommand(
	"commandCentral.refreshView",
	async (uri?: vscode.Uri) => {
		const { execute } = await import("./commands/refresh-view.js");
		await execute(viewManager, uri);
	}
);
```

---

## Quick Reference

### Common Patterns

**EventEmitter**:
```typescript
private _onDidChange = new vscode.EventEmitter<T>();
readonly onDidChange = this._onDidChange.event;

// Fire event
this._onDidChange.fire(value);
```

**Lazy Loading Commands**:
```typescript
vscode.commands.registerCommand("cmd", async () => {
	const { execute } = await import("./commands/feature.js");
	await execute();
});
```

**Disposal**:
```typescript
async dispose(): Promise<void> {
	this.views.forEach(v => v.dispose());
	this.views.clear();
	await this.storage?.dispose();
}
```

**Context Updates**:
```typescript
await vscode.commands.executeCommand("setContext", "key", value);
```

**State Persistence**:
```typescript
await context.globalState.update("key", value);
const value = context.globalState.get<T>("key", defaultValue);
```

---

## References

- **Architecture**: [ARCHITECTURE.md](../../ARCHITECTURE.md)
- **Code Style**: [docs/standards/CODE_STYLE.md](../standards/CODE_STYLE.md)
- **Testing**: [docs/development/TESTING_GUIDE.md](./TESTING_GUIDE.md)
- **VS Code API**: [https://code.visualstudio.com/api](https://code.visualstudio.com/api)

---

*Last Updated: 2025-10-25 | Command Central v0.0.35*
