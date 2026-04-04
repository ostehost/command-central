ULTRATHINK. Use Claude Opus-level reasoning.

# Spec: Agent File View Coherence

## Problem

The Agent Status sidebar shows file changes per agent, but these file entries are disconnected
from the VS Code Source Control / Git Sort view. When a user expands an agent and sees changed
files (e.g., `extension.ts +42 -74`), clicking that file should open a clean, native-feeling
diff — not reference temp paths or show disconnected information.

Additionally, the file change nodes in the agent status tree need to display proper
**project-relative paths** so they match what the user sees in their normal Git workflow.

## Current State (v0.5.1-74)

1. ✅ Virtual doc provider (`cc-diff:` scheme) replaces temp files — diff tabs now show
   clean filenames instead of `/var/folders/...` paths.
2. ✅ Per-file diff stats are computed from `git diff --numstat` between start and end commits.
3. ⚠️ File nodes in the tree show just the basename (e.g., `extension.ts`) — no path context.
   When multiple files share a name across directories, this is ambiguous.
4. ⚠️ The diff title in the tab shows `filename (startRef ↔ endRef)` but doesn't include
   the project name, making it unclear which project the diff is from.

## Changes Required

### 1. Show project-relative paths in file change nodes

Currently, `AgentFileChangeItem` shows just the basename. Change to show the path relative
to the project root when the file is not in the root directory.

Example:
- `src/providers/diff-content-provider.ts` instead of just `diff-content-provider.ts`
- Root-level files stay as-is: `package.json`, `.gitignore`

**Where to change:** In `agent-status-tree-provider.ts`, wherever `AgentFileChangeItem` labels
are constructed. Look for where `path.basename()` is called on file paths for the tree item label.

Use `description` property of TreeItem for the directory portion, and `label` for the filename.
This gives VS Code's native "filename — path" display pattern:
```
diff-content-provider.ts  src/providers
extension.ts              src
```

### 2. Include project name in diff tab title

When opening a per-file diff via `commandCentral.openFileDiff`, update the title to include
the project name:

```
diff-content-provider.ts (abc123 ↔ def456) — command-central
```

**Where to change:** In `src/extension.ts`, the `vscode.diff()` call's title parameter.
The `node` parameter already has access to `taskId` and project info.

### 3. Verify end_commit boundary is used correctly

The agent status tree shows "Git: main → 41860d3" for `cc-diff-virtual-docs-v4`, but the
agent's actual `end_commit` is `df10667`. Verify that `getTaskDiffEndCommit()` uses the
task's `end_commit` field, not HEAD. If it falls through to HEAD, the diff may include
commits made after the agent finished.

**Where to check:** `getTaskDiffEndCommit()` in `agent-status-tree-provider.ts`. The logic
should be:
1. If task has `end_commit` → use it
2. If task is running → use HEAD (working tree)
3. If task is completed without `end_commit` → return undefined (no diff, per drift guard)

Also check: the "Git: main → XXXXX" display. Where does it get the hash it shows? It should
show the `end_commit`, not HEAD.

### 4. File change nodes should show status indicators

Add visual indicators matching VS Code's Source Control conventions:
- **A** (Added) — file didn't exist at start_commit, exists at end_commit
- **M** (Modified) — file exists at both commits with changes
- **D** (Deleted) — file existed at start_commit, deleted at end_commit

These can be derived from the `git diff --numstat` output (additions-only = likely new file,
deletions-only = likely deleted). Or use `git diff --name-status` which gives explicit A/M/D.

**Where to change:** The file change item construction. Use `resourceUri` + a decoration
provider, or simply append the status letter to the description.

## Files to modify

1. **MODIFY:** `src/providers/agent-status-tree-provider.ts` — file node labels, descriptions,
   git ref display, status indicators
2. **MODIFY:** `src/extension.ts` — diff tab title format (add project name)
3. **ADD tests:** Update existing tree provider tests for the new label/description format

## Files NOT to modify

- `src/providers/diff-content-provider.ts` — just shipped, working correctly
- `package.json` — no new dependencies
- Any files outside `src/` and `test/`

## Testing

1. `bun test` must pass
2. Tree provider tests verify:
   - File nodes show project-relative paths
   - Description shows directory portion
   - Added/Modified/Deleted status indicators
3. Verify diff title includes project name

## Expected Result

After this change, the Agent Status file list should feel consistent with VS Code's
native Source Control view: relative paths, status indicators, and clean diff titles
that tell you exactly which project and commits you're looking at.
