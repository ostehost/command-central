# Command Central × Claude Spend Dashboard — Integration Design

**Status:** Research & Design (no code changes)
**Date:** 2026-03-05
**Scope:** Surfacing OpenClaw usage/spend data inside VS Code via Command Central

---

## 1. Executive Summary

The claude-spend-dashboard already has a working live HTTP API (`/api/usage`) that parses
`~/.openclaw/agents/*/sessions/*.jsonl` on demand. Command Central already follows a
file-watcher + TreeDataProvider pattern (see `AgentStatusTreeProvider`). The cleanest
integration path is:

1. Extract the shared JSONL parser into a standalone module (`@partnerai/usage-parser`)
2. Add a `ClaudeUsageTreeProvider` to Command Central that polls/watches the data
3. Add a persistent status bar item showing today's spend
4. (Phase 3) Add a webview panel that embeds a lightweight version of the dashboard

The data layer is already proven — we just need to bring it into VS Code's UI model.

---

## 2. Architecture Overview

```
~/.openclaw/agents/
  <agent-name>/
    sessions/
      <session-id>.jsonl          ← raw data source
      <session-id>.jsonl.deleted
      <session-id>.jsonl.reset

         │
         │ (parsed by)
         ▼

┌─────────────────────────────┐
│   @partnerai/usage-parser   │  ← NEW shared module
│   (pure TypeScript, no deps)│
│                             │
│  parseOpenClawDir(path)     │
│  aggregateByDay(sessions)   │
│  aggregateByModel(sessions) │
│  getTodayStats(sessions)    │
│  calculateCacheRate(...)    │
└──────────┬──────────────────┘
           │
     ┌─────┴────────────────────────────────────┐
     │                                          │
     ▼                                          ▼
┌──────────────────────┐          ┌──────────────────────────┐
│  Command Central     │          │  claude-spend-dashboard  │
│  (VS Code extension) │          │  (server.ts / React app) │
│                      │          │                          │
│  • TreeDataProvider  │          │  • /api/usage endpoint   │
│  • StatusBarItem     │          │  • public/data.json      │
│  • WebviewPanel      │          │  • React + recharts UI   │
└──────────────────────┘          └──────────────────────────┘
```

### Data Flow (VS Code extension)

```
Extension Activate
  └─► ClaudeUsageService.start()
        ├─► Read ~/.openclaw/agents dir
        ├─► Parse JSONL via @partnerai/usage-parser
        ├─► Cache aggregated UsageSnapshot
        ├─► Emit onDidUpdate event
        │
        ├─► ClaudeUsageTreeProvider.refresh()     → sidebar tree
        ├─► ClaudeUsageStatusBarItem.update()     → bottom bar
        └─► ClaudeUsageWebviewPanel.postMessage() → webview (if open)

File Watcher (vscode.workspace.createFileSystemWatcher)
  ~/.openclaw/agents/*/sessions/*.jsonl
  → debounce 500ms → ClaudeUsageService.refresh()
```

---

## 3. Shared Data Module: `@partnerai/usage-parser`

### Why Extract

The JSONL parsing logic is **duplicated** between `generate-data.ts` and `server.ts` in
claude-spend-dashboard. Both files implement the same `aggregateData()` function. Extracting
it removes the duplication and gives Command Central a tested, typed interface.

### Package Structure

```
packages/usage-parser/
  src/
    types.ts          ← shared TypeScript interfaces
    parser.ts         ← core JSONL parsing
    aggregations.ts   ← daily/model/agent aggregation
    index.ts          ← public API
  package.json        ← name: "@partnerai/usage-parser"
  tsconfig.json
```

### TypeScript Interfaces

```typescript
// types.ts

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionRecord {
  sessionId: string;
  agent: string;
  source: "openclaw";
  cost: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  messages: number;
  models: string[];
  start: string | null;        // ISO 8601
  deleted: boolean;
}

export interface DailyAggregate {
  date: string;                // YYYY-MM-DD
  cost: number;
  messages: number;
  cumulative: number;
}

export interface ModelAggregate {
  model: string;
  cost: number;
}

export interface AgentAggregate {
  agent: string;
  cost: number;
  sessionCount: number;
}

export interface CacheStats {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitRate: number;        // cacheRead / (input + cacheRead), 0-1
  savings: number;             // estimated cost savings from cache hits
}

export interface UsageSnapshot {
  generatedAt: string;         // ISO 8601
  sessions: SessionRecord[];
  byDay: DailyAggregate[];
  byModel: ModelAggregate[];
  byAgent: AgentAggregate[];
  cacheStats: CacheStats;
  todayCost: number;
  todaySessions: number;
  totalCost: number;
  totalSessions: number;
}
```

### Public API

```typescript
// index.ts — public API surface

/**
 * Parse all OpenClaw session JSONL files from the agents directory.
 * @param agentsDir  Path to ~/.openclaw/agents  (default: auto-detected)
 */
export function parseOpenClawDir(agentsDir?: string): SessionRecord[];

/**
 * Aggregate sessions by calendar day, including cumulative spend.
 */
export function aggregateByDay(sessions: SessionRecord[]): DailyAggregate[];

/**
 * Aggregate sessions by model name.
 */
export function aggregateByModel(sessions: SessionRecord[]): ModelAggregate[];

/**
 * Aggregate sessions by agent name.
 */
export function aggregateByAgent(sessions: SessionRecord[]): AgentAggregate[];

/**
 * Calculate cache efficiency metrics.
 */
export function calculateCacheStats(sessions: SessionRecord[]): CacheStats;

/**
 * Build a complete UsageSnapshot in one call.
 * This is the main entry point for both apps.
 */
export function buildSnapshot(agentsDir?: string): UsageSnapshot;

/**
 * Filter sessions to today only (local timezone).
 */
export function filterToday(sessions: SessionRecord[]): SessionRecord[];
```

### Implementation Notes

- **Pure Node.js** — only `node:fs`, `node:path`, `node:os`. No Bun-specific APIs.
- **No external deps** — avoids version conflicts between projects.
- **Synchronous** — VS Code extension needs sync reads for the file watcher callback.
  Provide async variants (`buildSnapshotAsync`) for server use.
- **Schema versioning** — version field in a manifest file (if OpenClaw adds one).
  Currently: detect via file naming conventions (`.deleted`, `.reset`, `.lock`).

---

## 4. Command Central Integration Points

### 4a. Sidebar Tree View — "Claude Usage" Panel

**Registration** (in `package.json` `contributes.views.commandCentral`):

```json
{
  "id": "commandCentral.claudeUsage",
  "name": "Claude Usage",
  "type": "tree",
  "when": "commandCentral.claudeUsage.available"
}
```

**Tree Structure:**

```
Claude Usage
  ├─ Today: $12.34  (4 sessions)
  │    ├─ claude-opus-4-6          $9.12
  │    ├─ claude-sonnet-4-6        $3.22
  │    └─ Cache hit rate           87.3%
  │
  ├─ This Week: $67.80
  │    ├─ Mon Feb 27               $8.10
  │    ├─ Tue Feb 28               $14.30
  │    └─ ... (expandable)
  │
  ├─ By Agent
  │    ├─ main-agent               $41.20  (12 sessions)
  │    ├─ review-agent             $19.40  (6 sessions)
  │    └─ ...
  │
  └─ All Time: $1,234.56  (89 sessions)
```

**Provider class sketch:**

```typescript
// src/providers/claude-usage-tree-provider.ts

export class ClaudeUsageTreeProvider
  implements vscode.TreeDataProvider<UsageNode>, vscode.Disposable {

  private snapshot: UsageSnapshot | null = null;
  private _onDidChangeTreeData = new vscode.EventEmitter<UsageNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Uses same debounced file-watcher pattern as AgentStatusTreeProvider
  // Watches: ~/.openclaw/agents/*/sessions/*.jsonl
  // Debounce: 500ms (session files write frequently)

  refresh(): void {
    this.snapshot = buildSnapshot();      // from @partnerai/usage-parser
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: UsageNode): vscode.TreeItem { ... }
  getChildren(element?: UsageNode): UsageNode[] { ... }
}
```

**File Watcher Caveat:** Watching `~/.openclaw/agents/*/sessions/*.jsonl` is a glob across
many directories. VS Code's `createFileSystemWatcher` accepts a `GlobPattern`, so:

```typescript
const pattern = new vscode.RelativePattern(
  vscode.Uri.file(agentsDir),
  "*/sessions/*.jsonl"
);
vscode.workspace.createFileSystemWatcher(pattern);
```

This should work, but if the agents directory doesn't exist yet at activation time, the
watcher must be set up lazily (same pattern as `AgentStatusTreeProvider.setupFileWatch()`).

### 4b. Status Bar Item

A persistent status bar item showing today's spend. Click opens the webview panel.

**Placement:** Left side of status bar (priority ~50), showing:
```
◆ $12.34 today
```

On hover (tooltip):
```
Claude Usage Today
4 sessions · 187 API calls
Cache hit rate: 87.3%
Click to open full dashboard
```

**Implementation:**

```typescript
// src/services/claude-usage-status-bar.ts

export class ClaudeUsageStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.item.command = "commandCentral.claudeUsage.openDashboard";
  }

  update(snapshot: UsageSnapshot): void {
    const cost = snapshot.todayCost;
    this.item.text = `$(graph) $${cost.toFixed(2)} today`;
    this.item.tooltip = new vscode.MarkdownString([
      `**Claude Usage Today**`,
      `${snapshot.todaySessions} sessions · ${todayMessages} API calls`,
      `Cache hit rate: ${(snapshot.cacheStats.cacheHitRate * 100).toFixed(1)}%`,
      `*Click to open full dashboard*`,
    ].join('\n\n'));
    this.item.show();
  }
}
```

**Icon:** Use a built-in codicon — `$(graph)` or `$(pulse)` work well here.

### 4c. Webview Panel — Embedded Dashboard

A full webview panel that embeds a VS Code-themed version of the React dashboard.

**Two implementation strategies:**

**Option A — Proxy to local server (simpler)**
```typescript
// If claude-spend-dashboard server is running on :3001
// Webview iframes it directly
const panel = vscode.window.createWebviewPanel(
  "commandCentral.claudeUsage",
  "Claude Usage",
  vscode.ViewColumn.One,
  { enableScripts: true }
);
panel.webview.html = `
  <iframe src="http://localhost:3001" style="width:100%;height:100vh;border:0;" />
`;
```
**Risk:** iframe CSP in VS Code webviews is strict. This may not work without CSP overrides.

**Option B — Native webview with VS Code theming (recommended)**
```typescript
// Bundle a lightweight version of the React dashboard
// Replace hardcoded GitHub dark colors with VS Code CSS variables:
//   #0d1117  → var(--vscode-editor-background)
//   #161b22  → var(--vscode-sideBar-background)
//   #30363d  → var(--vscode-panel-border)
//   #e6edf3  → var(--vscode-editor-foreground)
//   #7d8590  → var(--vscode-descriptionForeground)
```

The webview receives data via `panel.webview.postMessage(snapshot)` — same data
the tree provider uses. No separate HTTP server required.

**Message protocol:**

```typescript
// Extension → Webview
{ type: "data", payload: UsageSnapshot }
{ type: "refresh" }

// Webview → Extension
{ type: "ready" }
{ type: "requestRefresh" }
{ type: "openSession", sessionId: string }
```

**Registration:**

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(
    "commandCentral.claudeUsage.openDashboard",
    () => ClaudeUsageWebviewPanel.createOrShow(context, usageService)
  )
);
```

---

## 5. Service Layer Design

A shared `ClaudeUsageService` coordinates data loading and notifies all consumers:

```typescript
// src/services/claude-usage-service.ts

export class ClaudeUsageService implements vscode.Disposable {
  private snapshot: UsageSnapshot | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  // All consumers subscribe to this single event
  readonly onDidUpdate = this._emitter.event;

  constructor(private readonly logger: LoggerService) {}

  start(): void {
    this.loadSnapshot();
    this.setupWatcher();
  }

  getSnapshot(): UsageSnapshot | null {
    return this.snapshot;
  }

  private loadSnapshot(): void {
    try {
      // Synchronous — same pattern as AgentStatusTreeProvider.readRegistry()
      this.snapshot = buildSnapshot();   // from @partnerai/usage-parser
      this._emitter.fire(this.snapshot);
    } catch (err) {
      this.logger.error("Failed to load usage snapshot", err as Error);
    }
  }

  private setupWatcher(): void {
    const agentsDir = join(homedir(), ".openclaw", "agents");
    if (!existsSync(agentsDir)) return;

    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(agentsDir),
      "*/sessions/*.jsonl"
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const debouncedRefresh = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.loadSnapshot(), 500);
    };

    this.watcher.onDidChange(debouncedRefresh);
    this.watcher.onDidCreate(debouncedRefresh);
    this.watcher.onDidDelete(debouncedRefresh);
  }
}
```

**Wiring in `extension.ts`:**

```typescript
const usageService = new ClaudeUsageService(mainLogger);
usageService.start();
context.subscriptions.push(usageService);

const usageTreeProvider = new ClaudeUsageTreeProvider(usageService);
const usageStatusBar = new ClaudeUsageStatusBar();

usageService.onDidUpdate((snapshot) => {
  usageTreeProvider.refresh();
  usageStatusBar.update(snapshot);
  // webview gets update via postMessage if open
});
```

---

## 6. Data Schema — `UsageSnapshot` in full

```typescript
interface UsageSnapshot {
  // Metadata
  generatedAt: string;           // ISO 8601 timestamp

  // Today (local timezone)
  todayCost: number;             // dollars, e.g. 12.34
  todaySessions: number;         // integer
  todayMessages: number;         // integer
  todayModels: ModelAggregate[]; // models used today

  // All time
  totalCost: number;
  totalSessions: number;
  totalMessages: number;

  // Breakdowns
  byDay: DailyAggregate[];       // sorted ascending by date, includes cumulative
  byModel: ModelAggregate[];     // sorted descending by cost
  byAgent: AgentAggregate[];     // sorted descending by cost

  // Token economics
  cacheStats: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number;        // 0.0 – 1.0
    totalTokens: number;
  };

  // Raw sessions (top 200 by cost, for webview detail view)
  sessions: SessionRecord[];
}
```

---

## 7. Configuration

New settings in `package.json` `contributes.configuration`:

```json
"commandCentral.claudeUsage.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Show Claude usage data in sidebar and status bar"
},
"commandCentral.claudeUsage.openClawDir": {
  "type": "string",
  "default": "",
  "description": "Path to OpenClaw data dir (default: ~/.openclaw)"
},
"commandCentral.claudeUsage.statusBar": {
  "type": "boolean",
  "default": true,
  "description": "Show today's spend in the status bar"
},
"commandCentral.claudeUsage.refreshInterval": {
  "type": "number",
  "default": 0,
  "description": "Polling interval in seconds (0 = file-watcher only)"
}
```

---

## 8. Implementation Phases

### Phase 1 — Shared Parser Module (1-2 days)
**Goal:** Extract duplicated code, establish shared types.

- Create `packages/usage-parser/` as a local package (or monorepo member)
- Move JSONL parsing from `server.ts` into `usage-parser/src/parser.ts`
- Export typed API: `buildSnapshot`, `filterToday`, etc.
- Update both `server.ts` and `generate-data.ts` to import from `@partnerai/usage-parser`
- Write unit tests (Bun test runner)

**Why first:** Validates the data model and catches edge cases before building UI on top.

### Phase 2 — Status Bar + Tree View (2-3 days)
**Goal:** Usage data visible in VS Code without opening anything.

- Add `ClaudeUsageService` class (file watcher + data loading)
- Add `ClaudeUsageStatusBar` (shows today's spend, click opens dashboard)
- Add `ClaudeUsageTreeProvider` (Today / This Week / By Agent tree)
- Register in `extension.ts`, wire `onDidUpdate` events
- Add package.json view and command contributions
- Guard with `commandCentral.claudeUsage.enabled` setting

**Deliverable:** `◆ $12.34 today` in status bar, usage tree in sidebar.

### Phase 3 — Webview Dashboard (3-5 days)
**Goal:** Full dashboard embedded in VS Code.

- Extract React components from `src/App.tsx` into shareable form
- Create VS Code webview build target (Vite/Bun build, VS Code CSP-compatible)
- Implement `ClaudeUsageWebviewPanel` with message-passing protocol
- Theme using VS Code CSS variables
- Click "today" row in tree → opens webview scrolled to that day

**Deliverable:** Full interactive dashboard inside VS Code, themed to match the editor.

### Phase 4 — Intelligence Features (future)
- Workspace cost attribution (match current workspace folder to agent sessions)
- Spend alerts via VS Code notifications when daily limit crossed
- Cost trend sparkline inline in the tree view
- Export/share usage report from webview

---

## 9. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| File watcher glob for `*/sessions/*.jsonl` is too broad — fires on every session write | Medium | Debounce to 500ms (agents write frequently during active sessions) |
| `~/.openclaw` doesn't exist (no OpenClaw install) | Low | Check on startup, hide UI elements if dir absent; set `commandCentral.claudeUsage.available` context key to false |
| Large numbers of sessions slow synchronous parse | Medium | Parse is O(n) over JSONL lines. With 200+ sessions this may take 50-200ms. Offload to worker thread or async IO in Phase 2 if needed |
| VS Code CSP blocks inline styles in webview | Low | Use `nonce`-based CSP (already the extension pattern per CLAUDE.md); pre-compile styles |
| OpenClaw JSONL schema changes | Low | Parser reads duck-typed fields with `?.` fallbacks; version detection can be added to `@partnerai/usage-parser` |
| React dashboard not VS Code themed | Medium | Replace hardcoded hex colors with CSS variables in Phase 3 webview build |
| Monorepo setup complexity | Low | Use local `file:` npm path or `bun link` instead of publishing to npm initially |

---

## 10. Alternative: HTTP Polling vs File Watching

Instead of parsing JSONL directly, Command Central could poll the spend dashboard server:

```
GET http://localhost:3001/api/usage  →  UsageSnapshot JSON
```

**Pros:**
- No JSONL parsing code in Command Central at all
- Server handles all aggregation
- Works immediately (server already exists)

**Cons:**
- Requires claude-spend-dashboard server to be running (port 3001)
- Network dependency on localhost — fragile if port conflicts
- No live updates (polling only, not file-watching)
- User must manually start the server

**Verdict:** HTTP polling is a good **interim approach** to unblock Phase 2 without waiting
for Phase 1. Use the API if the server is available, fall back to direct JSONL parsing.

```typescript
async function fetchUsageSnapshot(): Promise<UsageSnapshot> {
  try {
    const res = await fetch("http://localhost:3001/api/usage", { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json() as UsageSnapshot;
  } catch {
    // server not running — fall through to direct parse
  }
  return buildSnapshot();  // direct JSONL parse
}
```

---

## 11. Files to Create in Command Central

```
src/
  providers/
    claude-usage-tree-provider.ts   ← TreeDataProvider for usage tree
  services/
    claude-usage-service.ts         ← data loading + file watcher
    claude-usage-status-bar.ts      ← status bar item
  webview/
    claude-usage/
      panel.ts                      ← WebviewPanel wrapper
      index.tsx                     ← React entry point
      components/
        DailyChart.tsx
        ModelBreakdown.tsx
        SessionTable.tsx
  types/
    usage-types.ts                  ← re-export from @partnerai/usage-parser
```

---

## 12. Package.json Additions (Command Central)

```json
// contributes.viewsContainers → already exists (commandCentral activity bar)
// Add to contributes.views.commandCentral:
{
  "id": "commandCentral.claudeUsage",
  "name": "Claude Usage",
  "type": "tree",
  "when": "commandCentral.claudeUsage.available"
}

// Add to contributes.commands:
{
  "command": "commandCentral.claudeUsage.openDashboard",
  "title": "Open Claude Usage Dashboard",
  "category": "Command Central"
},
{
  "command": "commandCentral.claudeUsage.refresh",
  "title": "Refresh Claude Usage",
  "category": "Command Central",
  "icon": "$(refresh)"
}

// Add to contributes.menus:
{
  "view/title": [
    {
      "command": "commandCentral.claudeUsage.refresh",
      "when": "view == commandCentral.claudeUsage",
      "group": "navigation"
    }
  ]
}
```

---

## 13. Summary Recommendation

**Build in this order:**

1. **Extract `@partnerai/usage-parser`** — eliminates code duplication, establishes typed schema
2. **Status bar + tree view** — immediately useful, follows proven CC patterns (like `AgentStatusTreeProvider`)
3. **Webview dashboard** — high value but more effort; VS Code theming is the main complexity

The `AgentStatusTreeProvider` in Command Central is the perfect architectural reference for
the usage tree. Same pattern: config-driven path, `createFileSystemWatcher`, debounced reload,
typed tree nodes, `contextValue` for right-click menus.

The spend dashboard's `server.ts` is the perfect reference for the data aggregation logic —
it's already clean and correct. Extract it into `@partnerai/usage-parser` and both apps win.
