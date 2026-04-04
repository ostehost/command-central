ULTRATHINK. Use Claude Opus-level reasoning.

# Command Central: Agent Status Project Sections — Visual Parity with Git Sort

## Context

The Git Sort view shows each workspace project as a top-level collapsible section:
```
🌿 .OPENCLAW ▼ (158)
  📅 Today (24 files)
  📅 Yesterday (23 files)
  📅 March (90 files)
```

The Agent Status view currently shows project groups as nested items under a single "AGENT STATUS" heading:
```
AGENT STATUS
  [summary: 222 agents · 10 ⏹ · 212 ✓]
  🚀 ghostty-launcher (3 · 2 ✓ · 1 ⏹ · 23h ago)
  🔲 command-central (15 · 12 ✓ · 3 ⏹ · 3h ago)
```

Mike wants these to **look like the Git Sort sections** — each project should feel like a first-class section, not a nested group.

## The Problem

VS Code's TreeView API doesn't allow dynamically creating multiple view sections. We have ONE tree view (`commandCentral.agentStatus`). But we CAN make project group nodes **visually match** Git Sort's section headers by:

1. Matching the icon + name + count format
2. Adding the same toolbar-style inline actions
3. Using status-group sub-nodes under each project (like Git Sort's time-period groups)

## What to Change

### 1. Project Group Header Format

In `createProjectGroupItem()` (around line 5239):

**Current format:**
```
🚀 ghostty-launcher    3 · 2 ✓ · 1 ⏹ · 23h ago
```

**New format matching Git Sort:**
```
🚀 GHOSTTY-LAUNCHER ▼ (3)    2 ✓ · 1 ⏹
```

Changes:
- Project name in **uppercase** (like Git Sort's `.OPENCLAW`)
- Add `▼` character after name (visual sort indicator)
- Move total count into parentheses in label: `(N)`
- Description: just the status summary, no "ago" time (that's on child items)
- Use `Expanded` collapse state for projects with running agents, `Collapsed` for completed-only

```typescript
const total = counts.total;
const label = `${icon} ${node.projectName.toUpperCase()} ▼ (${total})`;
```

### 2. Status Sub-Groups Under Each Project

Under each project, add status-based sub-groups (like Git Sort's time periods):

```
🚀 GHOSTTY-LAUNCHER ▼ (3)
  ▶ Running (1)
  ▶ Completed (2)
```

This is already partially implemented via `statusGroup` nodes. Ensure they appear when `groupByProject` is enabled by nesting status groups inside project groups.

In `getProjectGroupChildren()`, instead of returning tasks directly, group them by status:

```typescript
// If > 5 tasks in this project, sub-group by status
// If ≤ 5 tasks, show them flat (no sub-grouping needed)
```

Threshold: sub-group only when a project has more than 5 agents. Below that, flat is fine.

### 3. Project Group Toolbar Actions

Add inline action buttons on project group items (matching Git Sort's header buttons):

In `package.json` menus, add:
```json
{
    "command": "commandCentral.filterToProject",
    "when": "viewItem == projectGroup",
    "group": "inline"
}
```

Register `commandCentral.filterToProject` — filters the view to show only that project's agents. (Implementation: set a filter state, re-render tree. The filter clears when clicked again or via a "Show All" action.)

### 4. Summary Node Removal When Grouped

When `groupByProject` is enabled, the global summary node (`222 agents · 10 ⏹ · 212 ✓`) is redundant because each project header already shows counts. Remove it OR collapse it to just an icon + total.

Change: When grouped, replace the summary node with a simple badge on the view title via `this._treeView.badge`:
```typescript
this._treeView.badge = {
    value: runningCount,
    tooltip: `${totalCount} agents · ${runningCount} running`
};
```

This puts the count on the "AGENT STATUS" section header itself (like how Source Control shows a badge number).

### 5. "Current Project" Filter

Add a filter option to show only agents from the currently active editor's project:

- Read `vscode.window.activeTextEditor?.document.uri`
- Determine which project it belongs to
- Filter tree to that project only
- Toggle via command `commandCentral.filterCurrentProject`

This gives users the "show current project only" Mike asked about.

## Files to Change
- `src/providers/agent-status-tree-provider.ts` — project group rendering, status sub-groups, summary removal, badge
- `src/extension.ts` — register filter commands
- `package.json` — command definitions, menus, keybindings
- Test files — update assertions

## Files NOT to Change
- Git Sort provider (it's the reference, not the target)
- Discovery layer
- Service layer

## Verification
```bash
bunx tsc --noEmit    # 0 errors
bun test             # full suite passes
```

## Commit message
```
feat: mirror Git Sort project sections in Agent Status view
```

## Priority Order (if running out of time)
1. Uppercase project names + count format (quick, high visual impact)
2. Badge on view title (replaces summary node)
3. Status sub-groups under projects
4. Current project filter
5. Project toolbar actions

## What NOT to do
- Do NOT create multiple TreeView instances
- Do NOT change Git Sort
- Do NOT change the agent discovery/registry layer
- Do NOT add workspace folder management
