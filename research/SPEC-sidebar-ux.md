# SPEC: Agent Sidebar UX Polish

## Problems (from Mike's screenshot)
1. **Double icons:** Each row shows BOTH an emoji in the label (✅/❌/🔄) AND a ThemeIcon via `iconPath`. Redundant.
2. **No project icon next to name:** Project identity should be visual, not just text.
3. **Grammar:** "1 files" should be "1 file".
4. **Status shows "1 running"** when nothing is actually running (stale task data).

## Changes

### 1. Remove emoji from label — use ONLY ThemeIcon `iconPath`
**File:** `src/providers/agent-status-tree-provider.ts`
**Method:** `createTaskItem()` (around line 1084)

Currently the label is built as:
```ts
const icon = STATUS_ICONS[task.status] || "❓";
const roleIcon = task.role ? ROLE_ICONS[task.role] : null;
const prefix = roleIcon ? `${icon} ${roleIcon}` : icon;
const projectEmoji = this.getProjectEmoji(task.project_dir);
const label = projectEmoji
    ? `${prefix} ${projectEmoji} ${task.id}`
    : `${prefix} ${task.id}`;
```

**Change to:** Remove `STATUS_ICONS` emoji from label entirely. The `iconPath` ThemeIcon already shows status. Keep role icon if present. Keep project emoji if configured.
```ts
const roleIcon = task.role ? ROLE_ICONS[task.role] : null;
const projectEmoji = this.getProjectEmoji(task.project_dir);
const parts = [roleIcon, projectEmoji, task.id].filter(Boolean);
const label = parts.join(" ");
```

The `STATUS_ICONS` map can remain for other uses (notifications, tooltips) but should NOT be in the tree item label.

### 2. Project icon in description
Move the project identity to be more prominent. The `description` field currently shows:
```
project_name · Completed in 33m · +1/-1
```

This is fine. The project emoji (from settings) already appears in the label — that's the project icon. If no emoji is configured, the project name in description suffices.

### 3. Fix "1 files" grammar
**File:** `src/providers/agent-status-tree-provider.ts`
**Method:** `getDiffSummary()` (around line 932)

Find where the file count string is built and use proper pluralization:
```ts
const fileLabel = fileCount === 1 ? "1 file" : `${fileCount} files`;
```

### 4. Verify status count accuracy
**File:** `src/providers/agent-status-tree-provider.ts`
**Method:** Summary/header node creation

Check that the "running" count in the header actually reflects current state. If a task's status was never updated from "running" to "completed/failed", that's a data staleness issue. The tree provider should only count tasks whose status is actively "running" AND whose process is confirmed alive, OR simply trust tasks.json status field.

### 5. UX improvements to consider (agent discretion)
- **Elapsed time format:** Consider "33m" vs "33 min" vs "33m ago" — pick one consistent style
- **Diff stats format:** "+1 / -1" is clear, keep it
- **Failed items:** Already have red icon, which is good. Consider if tooltip should show error details.
- **Stale completed:** Gray icon is good differentiation

## Files to Edit
1. `src/providers/agent-status-tree-provider.ts` — label construction, grammar fix, status accuracy
2. Tests in `src/providers/__tests__/agent-status-tree-provider.test.ts` — update label assertions

## Files NOT to Touch
- `src/extension.ts` — just shipped resume fix, don't touch
- `src/discovery/` — not relevant
- Any launcher code

## Approach
TDD: Write/update tests for expected label format FIRST, then implement to make them pass.

## Verification
```bash
just check   # must pass — 780+ tests, 0 failures
```

SPEC COMPLETE
