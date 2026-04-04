ULTRATHINK. Use Claude Opus-level reasoning.

# Command Central: Agent Status UI Polish — v1

## Context

The Agent Status tree view (`src/providers/agent-status-tree-provider.ts`, ~5738 lines) is functional but visually rough. A screenshot review surfaced these issues:

1. **Repetitive stale messages** — "Stale — session ended without completion signal" repeats verbatim across many rows
2. **Dense description lines** — project · diff summary · model · time · reviewed all crammed into one `item.description` string separated by ` · `
3. **Weak visual hierarchy** in expanded task details — "Result: ✅ Success", file list, model, branch all blend together
4. **Low contrast** on secondary metadata text
5. **"Show N older completed..."** node is easy to miss at bottom

## Goals

**Make the tree view feel polished and scannable** without changing architecture or breaking existing tests.

## Scope — ONLY these changes

### 1. Abbreviate stale status descriptions
In `createTaskItem()` around line 5470, when `task.status === "completed_stale"`:
- Current: `descriptionParts.push(STALE_AGENT_STATUS_DESCRIPTION)` which is "Stale — session ended without completion signal"
- Change to: just push `"stale"` (lowercase, terse)
- Keep the long description in the **tooltip** (it's already there via `getStatusDisplayLabel`)

### 2. Tighten description format for completed tasks
In `createTaskItem()`, the description joins everything with ` · `. For completed/done tasks, restructure:
- If project grouping is ON (items are already under project header): omit project name from description
- Keep: `diffSummary · model · timeAgo` (in that order)
- If reviewed: append `✓` (just the checkmark, drop the word "reviewed")
- Max description length: 80 chars. Truncate with `…` if longer.

### 3. Better "older runs" node styling
In `createOlderRunsItem()`, make the node more visible:
- Use `ThemeIcon("history")` instead of current icon
- Use `ThemeColor("descriptionForeground")` for a subtle but visible color
- Label: `"Show ${count} older runs"` (keep current)
- Add description: `"completed"` or `"completed · stopped"` based on hidden statuses

### 4. Compact detail children for expanded tasks
In the `getTaskChildren()` / detail item creation, tighten spacing:
- Combine "Branch" + "Git" into one line: `"main · abc1234"` (branch · short hash)
- For "Result" line: use `"✅ Completed"` / `"❌ Failed (code N)"` / `"⚠️ Stale"` — no "Result: " prefix
- For "Changes" line: keep `"+N / -M · K files"` format but drop the "Changes" label prefix — use icon `ThemeIcon("diff")` instead
- For "Model" line: drop "Model" prefix, use `ThemeIcon("hubot")` icon, show just the alias
- For "Prompt" line: truncate to 60 chars with `…`, use `ThemeIcon("comment")` icon

### 5. Summary line polish
In `getChildren()` root, the summary node (`type: "summary"`):
- Current: `"217 agents · 10 stopped · 207 done"`
- Change counts format: `"217 agents · 10 ⏹ · 207 ✓"` — use status symbols instead of words for compactness
- Keep the full text in tooltip

## Files to change
- `src/providers/agent-status-tree-provider.ts` — all changes are here
- `test/providers/agent-status-tree-provider.test.ts` — update assertions that match on old description strings
- `src/utils/agent-task-registry.ts` — if `STALE_AGENT_STATUS_DESCRIPTION` is used elsewhere, keep it but add a short variant

## Files NOT to change
- No CSS/HTML (this is a VS Code extension, not web UI)
- No new dependencies
- No service layer changes
- No discovery layer changes
- No extension.ts changes

## Test verification
```bash
bun test test/providers/agent-status-tree-provider.test.ts test/services/agent-status-bar.test.ts
```
All existing tests must pass. If description string assertions break, update them to match the new tighter format.

Also run:
```bash
bunx tsc --noEmit
```
Note: there are **pre-existing TS errors** in `src/extension.ts` (lines 2457, 2484) and `test/commands/extension-commands.test.ts` (lines 834, 836, 851, 853). Do NOT attempt to fix those — they are outside scope. Only ensure **no new** TS errors are introduced.

## Commit message
```
fix: polish agent status tree view descriptions and detail items
```

## What NOT to do
- Do NOT refactor the tree provider architecture
- Do NOT add new commands or menus
- Do NOT change the grouping logic
- Do NOT touch discovery/scanner/registry code
- Do NOT add color coding for project names (VS Code tree API doesn't support it natively)
- Do NOT change the icon emoji system (🚀, 🤖, etc) — those come from project-icon-manager
- Do NOT reduce the information shown — just make it more compact and scannable
