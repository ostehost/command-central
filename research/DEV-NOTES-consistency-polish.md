# DEV-NOTES: Agent Status Consistency Polish

## Summary

Polished three display inconsistencies in the Agent Status tree view to align with the Git Changes mental model and ensure consistent UX conventions across all toolbar controls.

## What Changed

### 1. Scope toggle icons — state convention (package.json)

The filter toggle (`$(filter)` / `$(filter-filled)`) and grouping toggle (`$(list-tree)` / `$(list-flat)`) both use a **state** icon convention: the icon shows the current mode, not what clicking will do. The scope toggle was the odd one out — it used **action** icons (showing what you'll switch TO).

Fixed by swapping the icons:
- `toggleAgentScopeCurrentProject` (shown when scope is "all"): `$(project)` → `$(globe)` (current state: global)
- `toggleAgentScopeAll` (shown when scope is "currentProject"): `$(globe)` → `$(project)` (current state: project-scoped)

### 2. Status mode group sorting — freshest activity (agent-status-tree-provider.ts)

In grouped-by-project mode, `status` mode sorted project groups alphabetically while `recency` and `status-recency` modes sorted by freshest child activity. This made status mode the only sort mode where groups jumped around when switching.

Removed the alphabetical shortcut from `compareProjectGroups()` and `compareGroupedRoots()`. All three sort modes now sort groups by freshest activity, with alphabetical as the tiebreaker. Within groups, agents still sort by status priority in status mode.

### 3. Grouping command titles — disambiguated (package.json)

Both `toggleProjectGrouping` and `toggleProjectGroupingFlat` shared the title "Toggle Project Grouping", making the command palette ambiguous. Renamed to:
- `toggleProjectGrouping`: "Show Flat List" (shown when grouped — describes the action)
- `toggleProjectGroupingFlat`: "Group by Project" (shown when flat — describes the action)

## Verification

- Sort-mode cycle button icons: Three toolbar states (`$(history)`, `$(warning)`, `$(pin)`) render correctly with proper `when` clauses — verified in package.json and `agent-menu-contributions.test.ts`.
- Summary row indicator: `↓ Recent` / `⚠ Status` / `▶ Active` labels render correctly — verified in test assertions.
- Scope toggle filtering: `getScopedLauncherTasks()` and `getScopedDiscoveredAgents()` filter correctly by workspace folder match — code review confirmed.
- Group-by-project sorting: All modes now use freshest activity — test updated and passing.
- History cap "Show more...": `applyAgentVisibilityCap()` produces correct `OlderRunsNode` with expansion — verified in test (per-project cap test).
- Visual consistency: Icons, labels, and descriptions follow consistent conventions across all toolbar controls.

## Tests

All 1033 tests pass. Ran:
- `bun test` (full suite)
- `just check` (Biome CI + tsc + knip)
- `just fix` (no formatting changes needed)
