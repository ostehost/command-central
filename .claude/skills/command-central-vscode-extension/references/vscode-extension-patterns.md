# VS Code Extension Patterns

Command Central-specific extension patterns and conventions.

## package.json Contributions

All VS Code integration points are declared in `package.json` under `contributes`:

### Commands

```json
{
  "contributes": {
    "commands": [
      {
        "command": "commandCentral.someCommand",
        "title": "Some Command",
        "category": "Command Central",
        "icon": "$(icon-name)"
      }
    ]
  }
}
```

- Every registered command must have a `contributes.commands` entry.
- Use the `Command Central` category for discoverability.
- Inline icons use VS Code codicon syntax: `$(icon-name)`.

### Views

```json
{
  "contributes": {
    "views": {
      "commandCentralView": [
        {
          "id": "commandCentral.agentStatus",
          "name": "Agent Status",
          "when": "commandCentral.someContextKey"
        }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        {
          "id": "commandCentralView",
          "title": "Command Central",
          "icon": "resources/icon.svg"
        }
      ]
    }
  }
}
```

### Configuration

```json
{
  "contributes": {
    "configuration": {
      "title": "Command Central",
      "properties": {
        "commandCentral.discovery.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable live agent discovery"
        }
      }
    }
  }
}
```

Configuration keys are accessed via `vscode.workspace.getConfiguration('commandCentral')`. Watch for changes with `vscode.workspace.onDidChangeConfiguration`.

### Menus

```json
{
  "contributes": {
    "menus": {
      "view/item/context": [
        {
          "command": "commandCentral.openDiff",
          "when": "viewItem == agentTask",
          "group": "inline"
        }
      ]
    }
  }
}
```

- `group: "inline"` renders as an icon button directly on the tree item.
- `when` clauses use context keys to control visibility.
- `viewItem` matches the `contextValue` set on `TreeItem`.

## src/extension.ts — Activation and Command Wiring

### Activation Pattern

```typescript
export async function activate(context: vscode.ExtensionContext) {
  // 1. Create services (singletons)
  const openclawTaskService = new OpenClawTaskService();
  const taskFlowService = new TaskFlowService();

  // 2. Create providers (depend on services)
  const agentStatusProvider = new AgentStatusTreeProvider(/* ... */);

  // 3. Register tree data providers
  vscode.window.registerTreeDataProvider('commandCentral.agentStatus', agentStatusProvider);

  // 4. Register commands with lazy handler imports
  context.subscriptions.push(
    vscode.commands.registerCommand('commandCentral.someCommand', async () => {
      const { handler } = await import('./commands/some-command.js');
      return handler(/* ... */);
    })
  );

  // 5. Set up file watchers
  // 6. Set initial context keys
}
```

Key principles:
- Services are created first, providers second (dependency order).
- Commands use dynamic `import()` to keep activation time fast.
- All disposables go into `context.subscriptions`.

### Deactivation

```typescript
export function deactivate() {
  // Dispose services, watchers, timers
}
```

Dispose watchers, intervals, and any resources not in `context.subscriptions`.

## Providers vs Services Split

### Providers (`src/providers/`)

Providers own the UI representation:

- **TreeDataProvider** — implements `vscode.TreeDataProvider<T>`. Owns tree node construction, icons, labels, and context values.
- **WebviewProvider** — implements `vscode.WebviewViewProvider`. Owns HTML rendering and message passing.
- Providers may read from multiple services but should not contain business logic.
- Providers own refresh semantics (debounce, partial refresh).

### Services (`src/services/`)

Services own data access and business logic:

- **OpenClawTaskService** — wraps `openclaw tasks list --json` with caching and debounce.
- **TaskFlowService** — wraps `openclaw tasks flow list --json`.
- **OpenClawConfigService** — reads `~/.openclaw/openclaw.json`.
- Services expose typed interfaces (e.g., `OpenClawTask`, `TaskFlow`).
- Services handle their own file watching and cache invalidation.
- Services are stateless or cache-with-TTL; they do not own UI state.

### Utils (`src/utils/`)

Stateless utility functions:

- **tasks-file-resolver.ts** — resolves the tasks.json path.
- **pending-review-probe.ts** — reads pending-review receipts.
- **review-queue-health.ts** — computes review queue state.
- Utils are pure or near-pure functions. No file watchers, no caching.

## Context Keys

Context keys control when clauses in `package.json`:

```typescript
// Setting a context key
vscode.commands.executeCommand('setContext', 'commandCentral.hasRunningTasks', true);

// Using in package.json
"when": "commandCentral.hasRunningTasks"
```

- Prefix all keys with `commandCentral.` to avoid collisions.
- Update context keys when the underlying state changes (e.g., on refresh).
- Boolean keys are most common; string keys work for multi-value conditions.

## Refresh and Reload Semantics

### Tree Refresh

The provider uses `EventEmitter<AgentNode | undefined | null>` and a coalescing scheduler:

```typescript
// Schedule a full tree rebuild
this.scheduleTreeRefresh();

// Schedule a targeted refresh of one node
this.scheduleTreeRefresh(specificAgentNode);
```

`scheduleTreeRefresh` does not fire immediately. It coalesces requests:
- A global refresh (no argument) clears any pending element-level refreshes.
- Element-level refreshes are keyed and deduplicated.
- The actual `_onDidChangeTreeData.fire()` dispatches via `setTimeout(0)`.

Never call `_onDidChangeTreeData.fire()` directly — always use `scheduleTreeRefresh`.

### Cache Invalidation

The provider maintains several caches:

- `_portCache` — per-task listening port detection
- `_promptCache` — per-file prompt summaries
- `_diffSummaryCache` — per-task diff summaries
- `_tmuxSessionHealthCache` — tmux health checks
- `_persistSessionHealthCache` — persist socket health

Clear relevant caches before scheduling a refresh when the underlying data source changes.

### clearCompletedAgents Command

The `commandCentral.clearCompletedAgents` command:
1. Reads tasks.json and counts entries with clearable statuses.
2. Prompts user for confirmation (modal warning).
3. Re-reads tasks.json (double-read to detect concurrent changes).
4. Calls `clearCompletedAgentEntries()` to remove clearable entries from the parsed registry.
5. Calls `writeRegistryWithBackup()` which creates a `.bak` copy before writing.
6. Calls `agentStatusProvider.reload()` which handles internal cache invalidation.

It does not directly clear the provider's caches — `reload()` handles that.

## File Watcher Patterns

### Workspace-Relative Watcher

```typescript
const watcher = vscode.workspace.createFileSystemWatcher('**/.ghostty-launcher/tasks.json');
watcher.onDidChange(() => debouncedRefresh());
watcher.onDidCreate(() => debouncedRefresh());
watcher.onDidDelete(() => debouncedRefresh());
context.subscriptions.push(watcher);
```

### Absolute Path Watcher

```typescript
import { watch } from 'fs';

const watcher = watch(absolutePath, { persistent: false }, (eventType) => {
  if (eventType === 'change') debouncedRefresh();
});
// Dispose in deactivate()
```

- Use `persistent: false` to avoid keeping the Node process alive.
- OpenClawTaskService uses `fs.watch` on the SQLite database directory with 150ms debounce.

## Integration-Test API Snapshots

Integration tests capture the extension's public API surface:

```typescript
// test/integration/installed-vsix-proof-suite.ts
const extension = vscode.extensions.getExtension('publisher.command-central');
const api = await extension.activate();
// Assert on exported API shape
```

When modifying the extension's public API or tree structure:
1. Run `just test-integration` to see if snapshots break.
2. Update snapshot expectations in the test files.
3. Verify the change is intentional, not accidental.

## Build Configuration

### Entry Point

`src/extension.ts` — ESM with top-level await.

### Build Tool

`Bun.build()` via `scripts-v2/lib/compiler.ts` (invoked by `scripts-v2/dist-simple.ts`). Output to `dist/`, ESM format.

### Critical External

`vscode` is always external — never bundled:

```typescript
external: ['vscode']
```

This is enforced because VS Code provides the `vscode` module at runtime. Bundling it causes runtime errors.

### Import Extensions

All import paths must use `.js` extensions (ESM requirement):

```typescript
import { something } from './utils/helper.js';  // Correct
import { something } from './utils/helper';      // Wrong — will fail at runtime
```
