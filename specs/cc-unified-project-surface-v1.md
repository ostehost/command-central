# Command Central: Unified Project Surface — Spec v1

## Problem Statement

Command Central has grown organically into several independent views:

- **Grouping Options** — toggle git status grouping (staged/unstaged)
- **Extension Filter** — hierarchical checkbox tree to filter by file type
- **Project Slots (slot1–slot10)** — per-workspace `SortedGitChangesProvider` views showing time-sorted git changes
- **Cron Jobs** — scheduled agent tree
- **Agent Status** — `AgentStatusTreeProvider` showing launcher tasks, discovered agents, TaskFlows, OpenClaw tasks

Each view has its own data pipeline, its own filter/sort state, and its own relationship to "project." The result is powerful but fragmented — a user monitoring 3 projects sees 3 Git Sort slots, 1 Agent Status tree (with project groups inside), 2 filter panels, and no unified concept of "I'm working on project X right now."

This spec defines the incremental path toward a **project-centric sidebar** where Git Sort and Agent Status feel like two facets of the same project surface, sharing context, filters, and metadata.

---

## 1. UX Vision

### What It Should Feel Like

The sidebar should feel like **one control tower per project**, not a bag of unrelated views. When you click on a project in the sidebar, you should see its file changes AND its agents, with consistent filtering and a shared sense of "current project."

### Target Layout (Activity Bar)

```
COMMAND CENTRAL
  ┌─ Grouping Options          (collapsible, toggle panel)
  ├─ Extension Filter           (collapsible, checkbox tree)
  │
  ├─ 🚀 GHOSTTY-LAUNCHER ▼ (19)    ← Git Sort slot
  │    📅 Today (5 files)
  │    📅 Yesterday (8 files)
  │    📅 Last 7 Days (6 files)
  │
  ├─ 🔲 COMMAND-CENTRAL ▼ (42)     ← Git Sort slot
  │    📅 Today (12 files)
  │    ...
  │
  ├─ Cron Jobs
  │
  ├─ AGENT STATUS                   ← Agent Status tree
  │    ▶ Running (2)
  │      🚀 ghostty-launcher
  │        task-abc · running · 12m
  │      🔲 command-central
  │        task-xyz · running · 3m
  │    ▶ Completed (45)
  │      ...
  └─
```

### Future Vision (Phase 5 — not this spec)

```
  ├─ 🚀 GHOSTTY-LAUNCHER
  │    📁 File Changes ▼ (19)      ← Git Sort embedded
  │    🤖 Agents (3)               ← Agent Status embedded
  │    🔧 Cron Jobs (1)            ← Cron embedded
```

That requires a single merged TreeDataProvider per project — a significant rewrite. This spec does NOT propose that. Instead, it defines the incremental steps that make the current multi-view architecture feel unified without merging providers.

---

## 2. Information Architecture

### Current Data Flow

```
WorkspaceFolderConfigSource         tasks.json / process scanner
        │                                    │
  ProjectViewConfig[]                  AgentTask[] + DiscoveredAgent[]
        │                                    │
  ProjectProviderFactory            AgentStatusTreeProvider
        │                                    │
  SortedGitChangesProvider ×N        Single TreeView
        │                            (project groups inside)
  N TreeViews (slot1..slotN)
        │
  ExtensionFilterState (per-workspace)
  GroupingStateManager (global)
```

### Problem: No Shared Project Identity

- Git Sort knows projects by `slotId` → workspace folder path
- Agent Status knows projects by `project_dir` / `project_name` from tasks.json
- Extension Filter knows projects by `slotId` (workspace index)
- There is no canonical `ProjectId` that crosses view boundaries

### Solution: `ProjectContext` — Shared Identity Layer

Introduce a lightweight `ProjectContext` type that both views can reference:

```typescript
// src/types/project-context.ts
export interface ProjectContext {
  /** Canonical identifier — the absolute path to the project root */
  projectDir: string;
  /** Human-readable name (folder basename or user override) */
  displayName: string;
  /** User-configured emoji icon (from commandCentral.project.icon) */
  icon?: string;
  /** The Git Sort slot ID, if this project has a workspace folder */
  slotId?: string;
  /** Whether this project has agents in the registry */
  hasAgents: boolean;
}
```

This is NOT a service class — it's a plain data type. A new `ProjectContextResolver` service builds it from both sources.

---

## 3. Shared Cache Model

### Current Duplication

| Data | Git Sort | Agent Status |
|------|----------|-------------|
| Project list | `WorkspaceFolderConfigSource.loadProjects()` | Derived from `tasks.json` keys |
| Project icon | `commandCentral.project.icon` setting → `ProjectIconManager` | Same `ProjectIconManager` instance |
| File activity | `getGitAwareTimestamps()` per workspace | `git diff` for per-task file changes |
| Filter state | `ExtensionFilterState` per workspace | `_projectFilter` (project dir string) |
| Time grouping | `groupByTimePeriod()` | `groupByTimePeriod()` (same util) |

### Proposed: `ProjectMetadataCache`

A single cache that both views read from, avoiding redundant I/O:

```typescript
// src/services/project-metadata-cache.ts
export class ProjectMetadataCache implements vscode.Disposable {
  private contexts = new Map<string, ProjectContext>(); // projectDir → context
  private _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this._onDidChange.event;

  /** Rebuild from workspace folders + agent registry */
  rebuild(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    agentTasks: AgentTask[],
    discoveredAgents: DiscoveredAgent[],
    iconManager: ProjectIconManager,
  ): void { ... }

  /** Get context by project dir (canonical lookup) */
  get(projectDir: string): ProjectContext | undefined { ... }

  /** Get all known projects */
  getAll(): ProjectContext[] { ... }

  /** Find project context matching a file URI */
  findForFile(uri: vscode.Uri): ProjectContext | undefined { ... }
}
```

**Key properties:**
- Rebuilt on workspace folder changes and agent registry reloads (debounced)
- Both `ProjectViewManager` and `AgentStatusTreeProvider` subscribe to `onDidChange`
- Lightweight — only identity/metadata, not file listings or git data
- Replaces the ad-hoc project name resolution in both providers

### What Stays Separate

Git-level data (timestamps, diffs, status) stays in each provider. The cache only shares **project identity and metadata** — the expensive per-provider work (git operations, file watching) remains independent because their access patterns differ fundamentally.

---

## 4. Current-Project Mode

### Concept

"Show me only the project I'm working in right now." This reduces overload in multi-project workspaces.

### Current State

Agent Status already has `_projectFilter: string | null` and `filterToProject()`. Git Sort has no equivalent — all slots are always visible (controlled by `when` clauses on slot context keys).

### Design

#### 4a. Unified Project Filter State

```typescript
// src/services/active-project-tracker.ts
export class ActiveProjectTracker implements vscode.Disposable {
  private _activeProjectDir: string | null = null;
  private _filterEnabled = false;
  private _onDidChange = new vscode.EventEmitter<string | null>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private cache: ProjectMetadataCache) {
    // Track active editor → resolve to project
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return;
      const ctx = cache.findForFile(editor.document.uri);
      if (ctx && ctx.projectDir !== this._activeProjectDir) {
        this._activeProjectDir = ctx.projectDir;
        if (this._filterEnabled) this._onDidChange.fire(ctx.projectDir);
      }
    });
  }

  /** Toggle current-project-only mode */
  setFilterEnabled(enabled: boolean): void { ... }

  /** Get current active project dir (always tracked, even when filter is off) */
  get activeProjectDir(): string | null { return this._activeProjectDir; }
  get filterEnabled(): boolean { return this._filterEnabled; }
}
```

#### 4b. How Each View Responds

| View | Filter Behavior |
|------|----------------|
| **Git Sort slots** | Hide/show via context keys: `commandCentral.slotN.active` set to `false` for non-matching slots. The slot mechanism already supports this. |
| **Agent Status** | Calls existing `filterToProject(dir)`. Already implemented. |
| **Extension Filter** | No change — it already filters per-workspace. When only one workspace is visible, it naturally scopes down. |
| **Grouping Options** | No change — global toggle. |

#### 4c. Toggle UX

- **Command:** `commandCentral.toggleCurrentProjectMode`
- **Toolbar button** on the Command Central container title (like the existing project filter button)
- **Icon:** `$(home)` when active, `$(globe)` when showing all
- **Context key:** `commandCentral.currentProjectMode` for `when` clauses
- **Status bar:** Show active project name when filter is on

#### 4d. Default Behavior

- **Off by default** — show all projects (current behavior)
- Persist preference via `commandCentral.currentProjectMode` configuration setting
- When enabled, auto-tracks the active editor's project
- Manual override: clicking a project group header in Agent Status forces that project regardless of editor focus

---

## 5. VS Code TreeView API Constraints

### What the API Allows

| Capability | Available | Notes |
|-----------|-----------|-------|
| Multiple TreeViews in one container | Yes | Already used: slots + Agent Status |
| Dynamic view creation at runtime | **No** | All views must be declared in `package.json` |
| Hide/show views via context keys | Yes | `when` clauses on view declarations |
| Shared TreeDataProvider across views | Yes | Already used: one provider → Activity Bar + Panel |
| Tree badges | Yes | `treeView.badge = { value, tooltip }` |
| Tree title/description updates | Yes | Dynamic titles already used |
| Drag-and-drop between views | Yes (limited) | `TreeDragAndDropController` — not useful here |
| Nested TreeViews (view inside view) | **No** | Cannot embed one tree inside another |
| Custom webview panels in sidebar | Yes | But loses native tree UX (keyboard nav, context menus) |

### Hard Constraints for This Spec

1. **Cannot merge Git Sort and Agent Status into one tree** without a new unified `TreeDataProvider` (Phase 5 territory)
2. **Cannot create views dynamically** — the 10-slot pattern must remain
3. **Cannot nest Agent Status under a Git Sort slot** — separate `TreeView` instances
4. **View order in sidebar is static** — defined by `package.json` declaration order. Users can reorder manually but we can't programmatically change it.

### Implication

The "unified feel" must come from:
- Shared visual language (matched formatting, icons, section headers)
- Shared filter state (current-project mode)
- Shared metadata (ProjectContext)
- Coordinated refresh (when project context changes, both views update)

NOT from merging views into a single tree.

---

## 6. Short-Term Path (Incremental Steps)

These changes ship independently, each behind a feature flag or as a non-breaking enhancement.

### Step 1: Visual Parity (No New Services)

Already specced in `cc-agent-project-sections-v1.md`. Key changes:
- Agent Status project headers match Git Sort format: `🚀 GHOSTTY-LAUNCHER ▼ (3)`
- Status sub-groups under project headers (Running / Completed / Failed)
- Badge on Agent Status view title

**Files:** `src/providers/agent-status-tree-provider.ts`, `package.json`
**Effort:** Small. Formatting changes only.

### Step 2: ProjectContext Type + Resolver

Introduce the shared project identity type. Initially used only for icon consistency — both views resolve project icons through the same path.

```
src/types/project-context.ts          — ProjectContext interface
src/services/project-context-resolver.ts — builds contexts from workspace folders + task registry
```

Wire it into `extension.ts`:
- `ProjectContextResolver` constructed with workspace folders
- Updated on `onDidChangeWorkspaceFolders`
- Passed to both `ProjectViewManager` and `AgentStatusTreeProvider`

**Files:** New `project-context.ts`, new `project-context-resolver.ts`, modify `extension.ts`
**Effort:** Medium. New service, but thin.

### Step 3: Current-Project Mode (Git Sort)

Implement `ActiveProjectTracker` and wire it to Git Sort slot visibility.

When enabled:
- Determine active project from editor URI
- Set `commandCentral.slotN.active` to `false` for non-matching slots
- Set `commandCentral.agentStatus.projectFilterActive` for Agent Status

**Files:** New `active-project-tracker.ts`, modify `extension.ts`, modify `project-view-manager.ts`, `package.json` (command + menu)
**Effort:** Medium. Slot visibility already works via context keys.

### Step 4: Project Filter Quick Pick (Agent Status)

Enhance the existing project filter with a polished Quick Pick:
- List all known projects from `ProjectMetadataCache`
- Show icon + name + agent count + recent activity indicator
- "Show All Projects" option to clear filter
- "Current Project (auto)" option to enable tracking mode

This replaces the current command that takes a raw project dir.

**Files:** Modify `agent-status-tree-provider.ts` (or new command file), `package.json`
**Effort:** Small.

### Step 5: ProjectMetadataCache

Build the shared cache layer. Wire both views to use it instead of their independent project resolution logic.

**Concrete changes:**
- `ProjectViewManager.getAllWorkspaceDisplayNames()` → delegates to cache
- `AgentStatusTreeProvider`'s project group name/icon resolution → delegates to cache
- Extension Filter's workspace list → delegates to cache
- Single `onDidChange` subscription replaces scattered config watchers

**Files:** New `project-metadata-cache.ts`, modify `project-view-manager.ts`, `agent-status-tree-provider.ts`, `extension-filter-view-manager.ts`
**Effort:** Large. Touches many wiring points, but each change is mechanical.

---

## 7. Milestone Breakdown

### Phase 1: Visual Unity (Steps 1)
**Goal:** Agent Status looks like it belongs next to Git Sort.
**Deliverable:** Matched project header format, status sub-groups, badge.
**Risk:** Low — formatting only.
**Blocked by:** Nothing.

### Phase 2: Shared Identity (Step 2)
**Goal:** One canonical project identity type used by both views.
**Deliverable:** `ProjectContext` type, `ProjectContextResolver` service.
**Risk:** Low — additive, no existing behavior changes.
**Blocked by:** Nothing (can parallel with Phase 1).

### Phase 3: Current-Project Mode (Steps 3 + 4)
**Goal:** "Show me only my current project" toggle.
**Deliverable:** `ActiveProjectTracker`, toolbar toggle, slot visibility control, enhanced project filter Quick Pick.
**Risk:** Medium — slot visibility manipulation needs careful testing (edge cases: no active editor, project not in workspace, rapid editor switching).
**Blocked by:** Phase 2 (needs `ProjectContext` for file → project resolution).

### Phase 4: Shared Cache (Step 5)
**Goal:** Both views share project metadata, eliminating duplicated resolution logic.
**Deliverable:** `ProjectMetadataCache`, wiring changes across providers.
**Risk:** Medium — refactoring multiple consumers. Must maintain backward compatibility for external callers.
**Blocked by:** Phase 2.

### Phase 5: Merged Project Surface (Future — Out of Scope)
**Goal:** Single `TreeDataProvider` per project showing both file changes and agent activity.
**Deliverable:** Unified tree with `FileChanges` and `Agents` as child groups under each project.
**Risk:** High — requires new provider, new tree item types, merging two complex codebases.
**Blocked by:** Phases 1–4.
**Note:** This is documented for direction only. Do not plan implementation.

---

## 8. File/Module Recommendations

### New Files

| File | Purpose |
|------|---------|
| `src/types/project-context.ts` | `ProjectContext` interface |
| `src/services/project-context-resolver.ts` | Builds `ProjectContext[]` from workspace + agent data |
| `src/services/project-metadata-cache.ts` | Event-driven cache wrapping the resolver |
| `src/services/active-project-tracker.ts` | Tracks active editor → project mapping, drives filter |

### Modified Files

| File | Change |
|------|--------|
| `src/providers/agent-status-tree-provider.ts` | Visual parity (Phase 1), cache delegation (Phase 4) |
| `src/services/project-view-manager.ts` | Slot visibility control (Phase 3), cache delegation (Phase 4) |
| `src/providers/extension-filter-view-manager.ts` | Cache delegation (Phase 4) |
| `src/extension.ts` | Wire new services, register commands |
| `package.json` | New commands, menu items, configuration properties |

### Files NOT to Change

| File | Reason |
|------|--------|
| `src/git-sort/sorted-changes-provider.ts` | Git Sort's internal data pipeline stays independent |
| `src/config/project-config-source.ts` | Abstraction layer — resolver sits above it, doesn't replace it |
| `src/services/grouping-state-manager.ts` | Global toggle, orthogonal to project filtering |
| `src/discovery/agent-registry.ts` | Discovery layer stays independent |

---

## 9. Configuration Additions

```json
{
  "commandCentral.currentProjectMode": {
    "type": "boolean",
    "default": false,
    "description": "Show only the active project's views (auto-tracks editor focus)",
    "scope": "window"
  }
}
```

No other new settings required. The active project is derived from editor focus, not configured.

---

## 10. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Slot visibility flicker when switching editors rapidly | Visual jank | Debounce `ActiveProjectTracker` (200ms). Only update if project actually changed. |
| Agent Status has projects not in workspace folders | Filter mismatch — agents for non-workspace projects disappear | `ProjectMetadataCache` includes agent-only projects (no `slotId`). Current-project filter only hides workspace slots, not agent groups. |
| Extension Filter state corruption when slots hide/show | Stale filter references | Extension Filter already uses workspace-keyed state, not slot-keyed. Safe. |
| Phase 5 merge invalidates Phase 1–4 work | Wasted effort | Phases 1–4 are independently valuable. Even if Phase 5 never ships, the sidebar is better. Phase 5 would consume the same services (cache, tracker). |
| 10-slot limit hit in large workspaces | Can't show all projects | Current-project mode is the answer — show only the active one. The slot limit becomes irrelevant when filtering. |

---

## 11. What This Spec Does NOT Cover

- **Webview-based dashboard** — separate concern, already has `AgentDashboardPanel`
- **Cron Jobs integration** — orthogonal, can be added to `ProjectContext` later
- **Remote/SSH workspace support** — same architecture applies, no special handling needed
- **Multi-root workspace edge cases** — the resolver handles them naturally via workspace folder iteration
- **Agent Status internal refactoring** — the provider is large (~1500+ lines) but this spec only touches its project resolution and filter logic, not its core tree rendering
