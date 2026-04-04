ULTRATHINK. Use Claude Opus-level reasoning.

# Command Central: UI Unity + Smart File Open — v1

## Context

Command Central has two tree views that serve related but different purposes:
1. **Git Sort** (`.OPENCLAW` section) — shows recently changed files across the workspace, sorted by modification time
2. **Agent Status** — shows agent tasks with expandable file changes per task

The views have visual inconsistencies and the file open behavior is disconnected:
- Git Sort: opens the actual file via `vscode.open`
- Agent Status: opens a virtual diff (before/after comparison) via `cc-diff:` URI
- Neither is smart about opening files in the correct VS Code window when projects span multiple directories

## Goals

1. **Unified visual language** between both views for file items
2. **Smart file open** — when clicking a file under an agent task, open the ACTUAL file on disk (not just a diff). Offer diff as a secondary action.
3. **Project-aware opening** — if the file's project is already open in a VS Code window, open it there. If not, offer to add it as a workspace folder.

## Scope — Implementation Details

### 1. Agent Status File Changes: Default to Real File, Diff as Secondary

**Current behavior:** Clicking a file under an agent opens a diff comparison.
**New behavior:** Clicking a file opens the actual file on disk. The diff is available via a context menu action or inline button.

In `createFileChangeItem()` (around line 5649 in `agent-status-tree-provider.ts`):

```typescript
// BEFORE:
item.command = {
    command: "commandCentral.openFileDiff",
    title: "Open File Diff",
    arguments: [node],
};

// AFTER:
item.command = {
    command: "commandCentral.smartOpenFile",
    title: "Open File",
    arguments: [node],
};
```

### 2. New `smartOpenFile` Command

Register a new command `commandCentral.smartOpenFile` in `extension.ts` that:

```typescript
// Pseudocode:
async function smartOpenFile(node: FileChangeNode) {
    const absolutePath = path.isAbsolute(node.filePath)
        ? node.filePath
        : path.join(node.projectDir, node.filePath);
    
    // 1. Check if file exists on disk
    if (!fs.existsSync(absolutePath)) {
        // File was deleted — fall back to showing the diff
        await vscode.commands.executeCommand("commandCentral.openFileDiff", node);
        return;
    }
    
    // 2. Check if the project folder is in the current workspace
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const inWorkspace = workspaceFolders.some(folder => 
        absolutePath.startsWith(folder.uri.fsPath)
    );
    
    if (inWorkspace) {
        // 3a. File is in current workspace — just open it
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(absolutePath));
    } else {
        // 3b. File is NOT in current workspace
        // Try to find an existing VS Code window with this project
        // If not found, open the file directly (VS Code handles cross-workspace files fine)
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(absolutePath));
    }
}
```

Keep `commandCentral.openFileDiff` as-is — it becomes the secondary action available via:
- Right-click context menu: "View Agent Diff"
- Inline button on hover (use the `diff` codicon)

### 3. Context Menu for File Change Items

In `package.json`, add to `menus.view/item/context`:

```json
{
    "command": "commandCentral.openFileDiff",
    "when": "viewItem == agentFileChange",
    "group": "1_actions@1"
},
{
    "command": "commandCentral.smartOpenFile",
    "when": "viewItem == agentFileChange",
    "group": "1_actions@2"
}
```

And add inline button for diff:
```json
{
    "command": "commandCentral.openFileDiff",
    "when": "viewItem == agentFileChange",
    "group": "inline"
}
```

### 4. Unified File Item Icons

Make file items in Agent Status use the same file-type icons as Git Sort.

In `createFileChangeItem()`:
```typescript
// BEFORE:
item.iconPath = new vscode.ThemeIcon("file");

// AFTER:
// Use the file URI so VS Code auto-selects the file-type icon
item.resourceUri = vscode.Uri.file(path.join(node.projectDir, node.filePath));
// VS Code will use its built-in file icon theme based on the file extension
// Remove explicit iconPath — let resourceUri drive the icon
```

This gives you the same file-type icons (JS icon for .js, TS for .ts, JSON for .json, etc.) that Git Sort already uses.

### 5. Git Status Decoration on Agent File Items

Git Sort files show `M` (modified), `U` (untracked) decorations. Agent Status file items should show the same.

In `createFileChangeItem()`, set the `description` to include the git status letter:
```typescript
const statusLetter = node.status === 'added' ? 'A' 
    : node.status === 'deleted' ? 'D' 
    : node.status === 'modified' ? 'M' 
    : '';
// Include in description alongside the +/- stats
item.description = `${statusLetter} +${node.additions} -${node.deletions}`;
```

### 6. File Path Display Consistency

Git Sort shows: `filename` (bold) + `relative/path` (muted)
Agent Status shows: `filename` + `dir · M +5 -5`

Unify: both should show `filename` with `relative/path · +X -Y` in the description.

In `createFileChangeItem()`:
```typescript
const { filename, dirPath } = this.getFileChangePathParts(node.filePath);
item.label = filename;
item.description = [
    dirPath,
    statusLetter,
    `+${node.additions} / -${node.deletions}`,
].filter(Boolean).join(' · ');
```

## Files to Change

- `src/providers/agent-status-tree-provider.ts` — `createFileChangeItem()` changes (icon, command, description, resourceUri)
- `src/extension.ts` — register `commandCentral.smartOpenFile` command
- `package.json` — add context menu entries, command registration
- `test/providers/agent-status-tree-provider.test.ts` — update file change item assertions
- `test/tree-view/agent-status-tree-provider.test.ts` — update if file change tests exist here

## Files NOT to Change

- `src/providers/diff-content-provider.ts` — virtual diff provider stays as-is
- Git Sort tree provider — no changes needed (it's already correct)
- Discovery layer, services, registry

## Verification

```bash
bunx tsc --noEmit          # Must be 0 errors
bun test                    # Full suite must pass
```

## Commit message
```
feat: unify file item UI between views and add smart file open
```

## What NOT to do
- Do NOT remove the diff functionality — it moves to secondary action
- Do NOT change Git Sort behavior — it's already correct
- Do NOT add workspace folder management (too complex for v1)
- Do NOT change the tree structure or grouping logic
