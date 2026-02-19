# Command Central - Architecture Documentation

**AI-Powered Mission Control for VS Code**

Version: 0.1.7 | Last Updated: 2026-02-18

---

## Table of Contents

1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Core Components](#core-components)
4. [Feature Architecture](#feature-architecture)
5. [Data Flow](#data-flow)
6. [Testing Architecture](#testing-architecture)
7. [Performance Characteristics](#performance-characteristics)
8. [Future Architecture](#future-architecture)

---

## System Overview

Command Central is a sophisticated VS Code extension that provides intelligent git change tracking, multi-workspace support, and AI-powered workflow enhancements. Built with Bun for maximum performance, it demonstrates clean architecture with dependency injection, observable effects testing, and industry best practices.

### Core Capabilities

- **Git Sort**: Time-based change tracking with grouping
- **Multi-Workspace**: Up to 10 workspace folders with isolation
- **Extension Filtering**: Filter files by extension across workspaces
- **Active File Tracking**: Auto-highlight current file in tree
- **Git Status Grouping**: Staged/unstaged file organization (MVP)
- **Keyboard-Driven**: Fast, mouse-free workflow
- **Terminal Integration**: Custom terminal launcher support
- **Launcher System**: macOS dock launcher creation (Strategy pattern)

### Architecture Principles

1. **Dependency Injection** - All services injected through composition root
2. **Observable Effects Testing** - Tests verify behavior, not implementation
3. **Clean Separation** - Clear boundaries between layers
4. **Performance First** - Sub-second activation, optimized tree rendering
5. **Type Safety** - Full TypeScript with strict mode
6. **Industry Standards** - Follows Google, Fowler, Beck best practices

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Extension Entry (src/extension.ts)                    │   │
│  │  - Activation lifecycle                                │   │
│  │  - Composition root (DI)                               │   │
│  │  - Command registration                                │   │
│  └────────────────────┬───────────────────────────────────┘   │
│                       │                                         │
│  ┌────────────────────┴───────────────────────────────────┐   │
│  │  Layer 1: Configuration Source                         │   │
│  │  - WorkspaceProjectSource                              │   │
│  │  - Workspace folder auto-discovery                     │   │
│  └────────────────────┬───────────────────────────────────┘   │
│                       │                                         │
│  ┌────────────────────┴───────────────────────────────────┐   │
│  │  Layer 2: Provider Factory                             │   │
│  │  - ProjectProviderFactory                              │   │
│  │  - Per-workspace provider instances                    │   │
│  │  - Isolated storage (workspaceState per folder)                │   │
│  │  - Extension filter state                              │   │
│  │  - Git status cache                                    │   │
│  │  - Grouping state manager                              │   │
│  └────────────────────┬───────────────────────────────────┘   │
│                       │                                         │
│  ┌────────────────────┴───────────────────────────────────┐   │
│  │  Layer 3: View Manager                                 │   │
│  │  - ProjectViewManager                                  │   │
│  │  - TreeView registration (Activity Bar + Panel)        │   │
│  │  - View lifecycle management                           │   │
│  │  - Provider routing                                    │   │
│  └────────────────────┬───────────────────────────────────┘   │
│                       │                                         │
│  ┌────────────────────┴───────────────────────────────────┐   │
│  │  VS Code UI                                            │   │
│  │  - TreeView (Activity Bar)                             │   │
│  │  - TreeView (Panel)                                    │   │
│  │  - Commands (Palette + Context Menu)                   │   │
│  │  - Keybindings                                         │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Extension Entry Point (`src/extension.ts`)

**Responsibility:** Composition root for dependency injection

**Key Patterns:**
- **Lazy Loading**: Commands loaded on-demand
- **Service Initialization**: All services created in activate()
- **Cleanup**: Proper disposal in deactivate()
- **Performance Tracking**: Activation time monitoring

**Initialization Flow:**
```typescript
activate() {
  1. Create loggers (main, gitSort, terminal)
  2. Initialize Terminal Service (SecurityService + ProcessManager)
  3. Initialize Git Sorter
  4. Create DI layers:
     - Layer 1: WorkspaceProjectSource (config)
     - Layer 2: ProjectProviderFactory (providers)
     - Layer 3: ProjectViewManager (views)
  5. Register commands
  6. Activate git sort (if enabled)
}
```

**Reference:** src/extension.ts:54-183

---

### 2. Dependency Injection Layers

#### Layer 1: Configuration Source

**Component:** `WorkspaceProjectSource`

**Responsibilities:**
- Auto-discover workspace folders
- Provide configuration per folder
- React to workspace changes

**Key Methods:**
- `getProjects()` - List all workspace folders
- `getProjectConfig(path)` - Get folder-specific config

#### Layer 2: Provider Factory

**Component:** `ProjectProviderFactory`

**Responsibilities:**
- Create `SortedGitChangesProvider` instances
- Manage per-workspace storage (workspaceState)
- Share state across providers (extension filter, grouping)
- Handle provider disposal

**Injected Dependencies:**
```typescript
class ProjectProviderFactory {
  constructor(
    logger: LoggerService,
    context: ExtensionContext,
    extensionFilterState: ExtensionFilterState,  // Shared
    gitStatusCache: GitStatusCache,              // Shared
    groupingStateManager: GroupingStateManager,  // Shared
  )
}
```

**Key Innovation:** Each provider gets isolated storage, but shares filter/grouping state.

#### Layer 3: View Manager

**Component:** `ProjectViewManager`

**Responsibilities:**
- Register TreeViews (Activity Bar + Panel)
- Route commands to correct provider
- Handle workspace folder changes
- Manage view lifecycle

**Key Methods:**
- `registerAllProjects()` - Create all views
- `getProviderByViewId(id)` - Route commands
- `getProviderForFile(uri)` - Multi-workspace routing
- `reload()` - Handle workspace changes

**Reference:** src/services/project-view-manager.ts

---

### 3. Git Sort Architecture

#### Sorted Changes Provider

**Component:** `SortedGitChangesProvider`

**Responsibilities:**
- Track git changes in workspace
- Sort by modification time
- Group by time periods (Today, Yesterday, Last 7 days, etc.)
- Filter by file extensions
- Persist deleted file order

**Time Grouping:**
```typescript
enum TimeGroup {
  Today,
  Yesterday,
  Last7Days,
  Last30Days,
  ThisMonth,
  LastMonth,
  Older
}
```

**Storage:** VS Code workspaceState API (native, zero dependencies)

**Reference:** src/git-sort/sorted-changes-provider.ts

#### Deleted File Tracking

**Component:** `DeletedFileTracker`

**Innovation:** Maintains stable order for deleted files across sessions

**Storage Strategy:**
```
Path Hash (SHA-256) → Sequence Number
Persisted via VS Code workspaceState API
```

**Reference:** src/git-sort/deleted-file-tracker.ts

---

### 4. Multi-Workspace Support

**Key Challenge:** One extension instance, multiple workspace folders

**Solution:** Provider-per-folder architecture

**Routing Strategy:**
```typescript
// Command receives file URI
getProviderForFile(uri: vscode.Uri) {
  1. Find workspace folder containing file
  2. Find provider for that folder
  3. Execute command on correct provider
}
```

**View Naming:**
```
commandCentral.project.slot1      (Activity Bar)
commandCentral.project.slot1Panel (Panel)
commandCentral.project.slot2
commandCentral.project.slot2Panel
...
commandCentral.project.slot10
commandCentral.project.slot10Panel
```

**Limit:** 10 workspace folders (configurable in code)

**Reference:** src/services/project-view-manager.ts:300-450

---

### 5. Extension Filtering

**Components:**
- `ExtensionFilterState` - Shared state across workspaces
- `ExtensionFilterViewManager` - Checkbox TreeView
- `ExtensionFilterTreeProvider` - Tree data provider

**Architecture:**
```
User checks extension (.ts) in filter view
  ↓
ExtensionFilterState updates
  ↓
Event emitted
  ↓
All providers refresh
  ↓
Only .ts files shown in all workspace views
```

**Persistence Modes:**
- `workspace` - Per workspace (default)
- `global` - All workspaces
- `none` - Session only

**Reference:** src/services/extension-filter-state.ts

---

### 6. Git Status Grouping (MVP)

**Component:** `GroupingStateManager`

**Feature:** Group files by git status (staged/unstaged)

**Architecture:**
```
Grouping disabled (default):
  Today
    ↳ file1.ts (modified)
    ↳ file2.ts (added)

Grouping enabled:
  Today
    ↳ Staged (2)
      ↳ file1.ts
      ↳ file2.ts
    ↳ Unstaged (1)
      ↳ file3.ts
```

**State Management:**
```typescript
interface GroupingState {
  mode: 'none' | 'gitStatus';
  enabled: boolean;
}
```

**Reference:** src/services/grouping-state-manager.ts

---

### 7. Active File Tracking

**Feature:** Auto-highlight currently open file in tree

**Implementation:**
```typescript
vscode.window.onDidChangeActiveTextEditor(editor => {
  if (!editor) return;

  const provider = getProviderForFile(editor.document.uri);
  if (!provider) return;

  // Expand time groups containing file
  // Scroll to file
  // Highlight (VS Code native)
})
```

**Performance:** < 100ms latency, scales to 1000+ files

**Reference:** src/git-sort/sorted-changes-provider.ts:500-600

---

### 8. Launcher Subsystem (macOS)

**Feature:** Create macOS dock launchers for instant project terminal access

**Architecture:** Hybrid (TypeScript services + bundled shell script)

```
┌──────────────────────────────────────────────────────────┐
│  TypeScript Layer (src/services/launcher/)               │
│  • ILauncherStrategy interface                           │
│  • BundledLauncherStrategy (VSIX-packaged script)        │
│  • UserLauncherStrategy (user-configured path)           │
│  • TerminalLauncherService (orchestration)               │
└──────────────────────┬───────────────────────────────────┘
                       │ Bun.spawn()
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Shell Script (resources/bin/ghostty-launcher)           │
│  • .app bundle creation                                  │
│  • Icon generation (emoji → icns via sips/iconutil)      │
│  • Dock integration via osascript                        │
│  • LaunchServices registration                           │
└──────────────────────────────────────────────────────────┘
```

**Why Hybrid?** ~35% of launcher code uses macOS-specific APIs (sips, iconutil, osascript) with no Node.js equivalent. Full TypeScript port would require native bindings.

**Strategy Pattern:**
| Strategy | Use Case |
|----------|----------|
| BundledLauncherStrategy | Default: Uses packaged script |
| UserLauncherStrategy | Custom: User-configured path |
| (Future) SystemStrategy | System-installed command |

**Sync Process:** The shell script is developed separately and synced before releases:
```bash
just sync-launcher     # Sync from development repo
just dist              # Warns if out of sync
```

**Platform Behavior:**
| Platform | Behavior |
|----------|----------|
| macOS | Full functionality |
| Linux/Windows | Commands hidden, silent activation |

**Reference:**
- [docs/launcher/ARCHITECTURE.md](docs/launcher/ARCHITECTURE.md)
- [docs/launcher/QUICK_REFERENCE.md](docs/launcher/QUICK_REFERENCE.md)

---

## Feature Architecture

### Command Registration Pattern

**Standard Pattern:**
```typescript
vscode.commands.registerCommand(
  "commandCentral.feature.action",
  async (arg?: ItemType) => {
    // 1. Validate input
    if (!arg?.uri) return;

    // 2. Find correct provider
    const provider = projectViewManager?.getProviderForFile(arg.uri);
    if (!provider) {
      logger.error("No provider found");
      vscode.window.showErrorMessage("...");
      return;
    }

    // 3. Execute action
    await provider.performAction(arg);
  }
)
```

**Multi-Root Workspace Handling:**
All commands that accept file URIs use `getProviderForFile()` to ensure correct workspace context.

---

### TreeView Patterns

**Key Principle:** Observable effects testing (no test-only methods)

**TreeView Creation:**
```typescript
const treeView = vscode.window.createTreeView(viewId, {
  treeDataProvider: provider,
  showCollapseAll: true,
  canSelectMany: false,
});

// Track for disposal
context.subscriptions.push(treeView);
```

**Refresh Pattern:**
```typescript
class Provider implements vscode.TreeDataProvider<Item> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Item | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();  // Observable effect
  }
}
```

**Reference:** TEST_DESIGN_BEST_PRACTICES.md

---

## Data Flow

### Git Change Detection Flow

```
1. VS Code Git Extension detects change
   ↓
2. GitSorter listens to repository.state.onDidChange
   ↓
3. SortedGitChangesProvider.refresh() called
   ↓
4. Provider queries git API for changes
   ↓
5. Changes sorted by modification time
   ↓
6. Time grouping applied
   ↓
7. Extension filter applied (if active)
   ↓
8. Git status grouping applied (if enabled)
   ↓
9. TreeView refreshed (observable effect)
   ↓
10. User sees updated tree
```

### Extension Filter Flow

```
1. User checks extension in filter view
   ↓
2. ExtensionFilterTreeProvider updates state
   ↓
3. ExtensionFilterState.setExtensionEnabled()
   ↓
4. Event emitted: onDidChangeFilter
   ↓
5. All providers listening to event
   ↓
6. Each provider calls refresh()
   ↓
7. Providers filter files during getChildren()
   ↓
8. Only selected extensions shown
```

### Workspace Folder Changes

```
1. User adds/removes workspace folder
   ↓
2. vscode.workspace.onDidChangeWorkspaceFolders fires
   ↓
3. ProjectViewManager.reload() called (with 300ms debounce)
   ↓
4. WorkspaceProjectSource.getProjects() re-queries
   ↓
5. ProjectViewManager unregisters old views
   ↓
6. ProjectViewManager registers new views
   ↓
7. Users sees updated workspace views
```

---

## Testing Architecture

### Test Organization

```
test/
├── git-sort/            # Git sorting & tracking (12 files)
├── integration/         # Multi-component tests (6 files)
├── services/            # Business logic (8 files)
├── utils/               # Utility functions (4 files)
├── security/            # Security validation (2 files)
├── ui/                  # UI components (2 files)
├── builders/            # Test helpers (1 file)
└── helpers/             # Mocks & helpers (4 files)
```

**Total:** 537 tests across 51 files

### Testing Philosophy

**Industry Best Practices:**
- Google Testing Blog: "Test behavior, not implementation"
- Kent Beck: "Tests survive stable behavior"
- Martin Fowler: "Observable effects over state inspection"

**No Test-Only Methods:**
```typescript
// ❌ WRONG: Test-induced design damage
class Manager {
  private state: boolean;
  isEnabled(): boolean { return this.state; }  // Only for tests!
}

// ✅ CORRECT: Test observable effects
class Manager {
  private state: boolean;
  toggle(): void {
    this.state = !this.state;
    context.globalState.update('key', this.state);  // Observable!
    vscode.commands.executeCommand('setContext', 'key', this.state);  // Observable!
  }
}
```

**Reference:** TEST_DESIGN_BEST_PRACTICES.md, TEST_REFACTORING_COMPLETE.md

### Test Infrastructure

**Bun Test Framework:**
- Native mocking (`mock()`, `mock.module()`)
- Fast execution (~5s for 537 tests)
- Built-in coverage

**VS Code Mocking:**
```typescript
mock.module("vscode", () => ({
  window: {
    showInformationMessage: mock(),
    createTreeView: mock(),
  },
  workspace: {
    getConfiguration: mock(),
    workspaceFolders: [...],
  },
  ...
}));
```

**Reference:** test/helpers/vscode-mock.ts

---

## Performance Characteristics

### Activation Performance

```
Target: < 500ms
Actual: ~200ms (cold), ~150ms (warm)

Breakdown:
- Service initialization: ~50ms
- Command registration: ~30ms
- View registration: ~80ms
- Git sort activation: ~40ms
```

### Git Sort Performance

```
File Count | Sort Time | Target
-----------|-----------|--------
100        | ~300ms    | < 500ms  ✅
500        | ~800ms    | < 1.5s   ✅
1000       | ~1.5s     | < 3s     ✅
```

### Test Suite Performance

```
Operation           | Time    | Target
--------------------|---------|----------
Full suite          | ~5s     | < 10s    ✅
Unit tests only     | ~5s     | < 10s    ✅
Coverage generation | ~9s     | < 12s    ✅
```

### Build Performance

```
Operation     | Time   | Target
--------------|--------|----------
Dev build     | ~1.1s  | < 2s   ✅
Prod build    | ~1.3s  | < 3s   ✅
Type check    | ~2.5s  | < 5s   ✅
VSIX creation | ~1.2s  | < 2s   ✅
```

**Reference:** docs/performance/BENCHMARKS.md

---

## Future Architecture

### Planned Enhancements

**v0.1.x - Git Status Grouping (In Progress)**
- Complete staged/unstaged grouping MVP
- Performance optimization for large repos
- User testing and refinement

**v0.2.x - AI-Powered Features**
- Smart file suggestions based on context
- Predictive workflow automation
- Intelligent grouping strategies

**v0.3.x - Enhanced Multi-Workspace**
- Support > 10 workspace folders
- Custom naming for workspace views
- Cross-workspace search

**v0.4.x - Platform Expansion**
- VS Code for Web support (limited features)
- Remote-SSH optimizations
- Dev Container integration

### Architectural Considerations

**Scalability:**
- Current: 10 workspace folders max
- Target: Unlimited (dynamic rendering)
- Approach: Lazy loading, virtual scrolling

**Extensibility:**
- Plugin architecture for grouping strategies
- Custom sort algorithms
- User-defined time periods

**Performance:**
- Activation: Maintain < 500ms regardless of features
- Tree rendering: Virtual scrolling for 10,000+ files
- Memory: < 50MB per workspace

---

## References

### Key Documents

- **Architecture:** This document
- **Workflow:** WORKFLOW.md (development process)
- **Testing:** TEST_DESIGN_BEST_PRACTICES.md
- **API:** docs/development/API_GUIDE.md
- **Standards:** docs/standards/

### Code Organization

```
src/
├── extension.ts              # Entry point, DI composition root
├── commands/                 # Command handlers
├── config/                   # Configuration sources
├── factories/                # Provider factories
├── git-sort/                 # Git sorting & tracking
│   ├── sorted-changes-provider.ts
│   ├── deleted-file-tracker.ts
│   ├── git-timestamps.ts
│   ├── scm-sorter.ts
│   └── storage/              # Persistence layer
├── providers/                # TreeView providers
├── services/                 # Business logic
│   ├── project-view-manager.ts
│   ├── logger-service.ts
│   ├── terminal-launcher-service.ts
│   ├── extension-filter-state.ts
│   ├── grouping-state-manager.ts
│   └── launcher/             # Launcher strategies
│       ├── launcher-strategy.interface.ts
│       ├── bundled-launcher-strategy.ts
│       └── user-launcher-strategy.ts
├── state/                    # State management
├── types/                    # TypeScript types
├── ui/                       # UI components
└── utils/                    # Utilities
```

---

## Conclusion

Command Central demonstrates a clean, layered architecture with strong separation of concerns. The dependency injection pattern at the composition root (extension.ts) allows for testable, maintainable code. The multi-workspace support through provider-per-folder architecture enables isolation while sharing state where appropriate.

Key architectural strengths:
- **Testability:** 537 tests with observable effects testing
- **Performance:** Sub-second operations throughout
- **Maintainability:** Clear boundaries, explicit dependencies
- **Extensibility:** Plugin-ready architecture for future features
- **Industry Standards:** Follows Google, Fowler, Beck best practices

This architecture provides a solid foundation for continued growth while maintaining the high performance and code quality standards that define Command Central.

---

*Last Updated: 2026-02-17 | Command Central v0.1.3*
