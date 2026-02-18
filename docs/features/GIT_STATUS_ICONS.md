# Git Status Icons

Command Central uses custom Radar B icons for git status visualization.

## Icon Design

- **Working Changes**: Amber radar sweep (actively scanning for changes)
- **Staged Changes**: Green target lock (locked on target, ready to commit)

## Technical Details

- **Location**: `resources/icons/git-status/{light,dark}/*.svg`
- **Size**: 16x16px (optimized for VS Code tree view)
- **Theme Support**: Automatic light/dark variant selection
- **Implementation**: `SortedGitChangesProvider.getGitStatusIcon()`

## Icon Files

| File | Size | Purpose |
|------|------|---------|
| `light/working.svg` | 641 bytes | Working changes (light theme) |
| `light/staged.svg` | 935 bytes | Staged changes (light theme) |
| `dark/working.svg` | 654 bytes | Working changes (dark theme) |
| `dark/staged.svg` | 948 bytes | Staged changes (dark theme) |

## Metaphor

The radar sweep metaphor aligns with Command Central's mission control branding:
- **Scanning** (working): Active radar searching for changes
- **Locked** (staged): Target acquired and ready for deployment

## Usage

Icons are automatically applied to Git ChangeItem elements in the tree view based on whether they're staged or working changes. The implementation uses `Uri.joinPath()` to construct theme-aware paths that VS Code resolves automatically.

## Implementation Details

```typescript
private getGitStatusIcon(iconName: 'staged' | 'working'): { light: vscode.Uri; dark: vscode.Uri } {
    return {
        light: vscode.Uri.joinPath(
            this.context.extensionUri,
            "resources/icons/git-status/light",
            `${iconName}.svg`
        ),
        dark: vscode.Uri.joinPath(
            this.context.extensionUri,
            "resources/icons/git-status/dark",
            `${iconName}.svg`
        ),
    };
}
```

The icons are applied in `getTreeItem()` for GitChangeItem elements:

```typescript
// Custom Radar B icons for Command Central branding
// Radar sweep (working) vs Target lock (staged)
item.iconPath = this.getGitStatusIcon(
    element.isStaged ? "staged" : "working"
);
```
