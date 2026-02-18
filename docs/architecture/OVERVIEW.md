# Architecture Overview - Command Central

**High-Level System Design**

Version: 0.0.35 | Last Updated: 2025-10-25

---

## Quick Summary

Command Central is a VS Code extension using **3-layer dependency injection** to provide:
- **Git Sort**: Time-based change tracking (Today, Yesterday, Last 7 days, etc.)
- **Multi-Workspace**: Up to 10 folders with isolated views
- **Extension Filtering**: Filter files by type across workspaces
- **Active File Tracking**: Auto-highlight current file

**Tech Stack**: TypeScript (strict), Bun, ESM, Observable effects testing

---

## High-Level Architecture

```
Extension Entry (src/extension.ts)
  ↓
Layer 1: Config Source (WorkspaceProjectSource)
  - Provides: List of projects from workspace folders
  ↓
Layer 2: Provider Factory (ProjectProviderFactory)
  - Creates: SortedGitChangesProvider instances
  - Shares: ExtensionFilterState, GitStatusCache, GroupingStateManager
  ↓
Layer 3: View Manager (ProjectViewManager)
  - Registers: TreeViews in Activity Bar + Panel
  - Routes: Commands to correct provider
  ↓
VS Code TreeViews (Activity Bar + Panel)
```

---

## Dependency Injection Pattern

**Composition Root** (`src/extension.ts:116-183`):

```typescript
// Layer 1: Config Source (WHERE projects come from)
const configSource = new WorkspaceProjectSource(mainLogger);

// Layer 2: Provider Factory (HOW providers are created)
const factory = new ProjectProviderFactory(
	context,
	gitSortLogger,
	extensionFilterState,     // Shared across providers
	groupingStateManager,     // Shared across providers
	gitStatusCache            // Shared across providers
);

// Layer 3: View Manager (ORCHESTRATION)
const viewManager = new ProjectViewManager(
	context,
	mainLogger,
	configSource,  // Abstraction!
	factory        // Abstraction!
);
```

**Benefits**:
- Testable (inject mocks)
- Flexible (swap implementations)
- Clear dependencies (no hidden coupling)

---

## Core Components

### Extension Entry (`src/extension.ts`)

**Purpose**: Bootstrap and composition root

**Responsibilities**:
- Create all services (loggers, security, git cache, state managers)
- Wire up dependency injection (3 layers)
- Register commands (lazy loaded)
- Activate git sort (if enabled)

**Key Pattern**: No business logic, only composition

### Config Source (`src/config/workspace-project-source.ts`)

**Purpose**: Provide list of projects

**Current Implementation**: Workspace folders (up to 10)

**Interface**:
```typescript
interface ProjectConfigSource {
	getProjectConfigs(): ProjectViewConfig[];
	readonly onDidChange: vscode.Event<void>;
}
```

**Future**: Could read from `.code-workspace`, config files, etc.

### Provider Factory (`src/factories/provider-factory.ts`)

**Purpose**: Create providers with shared state

**Pattern**: Factory with dependency sharing

```typescript
class ProjectProviderFactory {
	createProvider(config: ProjectViewConfig): SortedGitChangesProvider {
		// Create storage (per-provider)
		const storage = this.createStorageAdapter(config.workspaceFolder);

		// Create provider with shared state
		return new SortedGitChangesProvider(
			config.workspaceFolder,
			this.logger,
			this.sharedFilterState,      // SHARED
			this.sharedGroupingState,    // SHARED
			this.sharedGitCache,         // SHARED
			storage                       // PER-PROVIDER
		);
	}
}
```

**Shared vs Per-Provider**:
- **Shared**: ExtensionFilterState, GroupingStateManager, GitStatusCache
- **Per-Provider**: StorageAdapter (deleted file tracking)

### View Manager (`src/services/project-view-manager.ts`)

**Purpose**: Register views and route commands

**Responsibilities**:
- Register TreeViews (Activity Bar + Panel)
- Route commands to correct provider (by file URI)
- Handle workspace folder changes
- Coordinate active file tracking

**Command Routing**:
```typescript
getProviderForFile(uri: vscode.Uri): SortedGitChangesProvider | undefined {
	// 1. Find workspace folder containing file
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	// 2. Find provider for that folder
	return this.providers.get(folder.uri.toString());
}
```

### Provider (`src/git-sort/sorted-changes-provider.ts`)

**Purpose**: TreeView data provider for git changes

**VS Code Interface**:
```typescript
interface TreeDataProvider<T> {
	onDidChangeTreeData: Event<T | undefined>;
	getChildren(element?: T): T[];
	getTreeItem(element: T): TreeItem;
}
```

**Our Implementation**:
- Time-based grouping (Today, Yesterday, etc.)
- Deleted file tracking (persistent order)
- Extension filtering
- Sort order toggle (newest/oldest)
- Active file reveal

---

## Data Flow

### Initialization

```
1. Extension.activate()
2. Create services (Logger, Security, GitCache, States)
3. Create DI layers (Source → Factory → Manager)
4. Manager.registerAllProjects()
   ├─ Source.getProjectConfigs() → [config1, config2]
   ├─ Factory.createProvider(config1) → provider1
   ├─ Factory.createProvider(config2) → provider2
   ├─ Register TreeView(provider1) → Activity Bar
   └─ Register TreeView(provider2) → Activity Bar
5. Providers query git changes
6. TreeViews render
```

### Git Change Update

```
1. User modifies file
2. Git extension fires repository.state.onDidChange
3. GitStatusCache.invalidate(workspace)
4. GitStatusCache fires onDidChange
5. Provider listening to onDidChange
6. Provider.refresh()
7. Provider._onDidChangeTreeData.fire()
8. VS Code calls Provider.getChildren()
9. TreeView re-renders
```

### Command Execution

```
1. User clicks button in TreeView title
2. VS Code executes command("commandCentral.refresh", uri)
3. Extension's command handler
4. ViewManager.getProviderForFile(uri) → provider
5. Provider.refresh()
6. Provider fires _onDidChangeTreeData
7. TreeView updates
```

---

## Testing Strategy

**Observable Effects Pattern** (Google, Fowler, Beck):

```typescript
// ✅ Test observable effects
test("updateFilter persists state", async () => {
	await manager.updateFilter(new Set([".ts"]));

	// Verify observable effects
	expect(mockContext.globalState.update).toHaveBeenCalledWith("filter", [".ts"]);
	expect(vscode.commands.executeCommand).toHaveBeenCalledWith("setContext", "filter.active", true);
});

// ❌ Don't test internal state
test("filter stored in Map", () => {
	manager.updateFilter(new Set([".ts"]));
	expect(manager["_internalMap"].size).toBe(1); // Fragile!
});
```

**Benefits**:
- Tests survive refactoring
- Test behavior, not implementation
- No test-only methods

**See**: [TESTING_GUIDE.md](../development/TESTING_GUIDE.md)

---

## Performance Characteristics

**Activation**: ~200ms (target: < 500ms) ✅
- Service initialization: ~50ms
- Command registration: ~30ms
- View registration: ~80ms
- Git sort activation: ~40ms

**Git Sort**: Scales linearly
- 100 files: ~300ms
- 1000 files: ~1.5s
- Time grouping: O(n) single pass

**Memory**: ~18MB baseline, ~30MB peak (target: < 50MB) ✅

**Build**: ~1.1s dev, ~5s production ✅

**Tests**: 593 tests in ~7-8s (83.42% function coverage, 86.74% line coverage) ✅

**See**: [BENCHMARKS.md](../performance/BENCHMARKS.md)

---

## Key Design Principles

1. **Dependency Injection**: All dependencies explicit, testable
2. **Observable Effects**: Test behavior, not implementation
3. **Clean Separation**: Clear boundaries between layers
4. **Performance First**: Sub-second activation, optimized rendering
5. **Type Safety**: Full TypeScript strict mode
6. **Single Responsibility**: Each module does one thing

---

## Future Architecture

### Git Status Grouping (v0.1.x - 80% complete)

Add staged/unstaged grouping:
```
Today
  ├─ Staged (5)
  │  └─ file1.ts
  └─ Unstaged (3)
     └─ file2.ts
```

**Components**:
- ✅ GroupingStateManager (state management)
- ✅ GitStatusCache (git API integration)
- 🚧 TreeView integration (in progress)

### Unlimited Workspaces (v0.4.x)

Remove 10 folder limit:
- Virtual scrolling for large trees
- Lazy loading of folder contents
- Smart caching strategies

### Platform Expansion (v0.5.x)

- **VS Code for Web**: IndexedDB instead of SQLite
- **Remote-SSH**: Caching for network latency
- **Dev Containers**: Containerized workflows

**See**: [VISION.md](../roadmap/VISION.md)

---

## References

- **Full Architecture**: [ARCHITECTURE.md](../../ARCHITECTURE.md) (comprehensive 704-line doc)
- **API Guide**: [API_GUIDE.md](../development/API_GUIDE.md)
- **Testing Guide**: [TESTING_GUIDE.md](../development/TESTING_GUIDE.md)
- **Code Style**: [CODE_STYLE.md](../standards/CODE_STYLE.md)

---

*Last Updated: 2025-10-25 | Command Central v0.0.35*
