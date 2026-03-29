# SPEC: Agent Status Sorting & Grouping Redesign

> **Author:** Planning agent · **Date:** 2026-03-29
> **Status:** Draft — ready for review
> **Tracks:** M3.5 milestone (post-launch UX hardening)

---

## 1. Problem Statement

Users cannot quickly find their most recent agent runs. The current Agent Status tree prioritizes taxonomy (status buckets, alphabetical project groups) over recency. This is the opposite of what power users need: when you kick off 3–5 agents and come back 10 minutes later, the first thing you want is "what just finished?"

### 1.1 User complaint (paraphrased)

> "The product is hard to use because I can't easily find the latest runs. It feels hard to sort."

### 1.2 Target mental model

The desired UX should feel closer to **Git Changes / Source Control** in VS Code:
- Default view surfaces the **most recent thing** instantly
- Grouping is **optional and user-controlled**, not mandatory
- Hierarchy reduces cognitive load rather than adding it
- Switching between flat-list and grouped views is one click

---

## 2. Diagnosis: Current UX Failure Modes

### 2.1 Sorting: status-first buries recency

**Code:** `src/providers/agent-status-tree-provider.ts:351-376, 1563-1577`

```typescript
const TASK_STATUS_PRIORITY: Record<AgentTaskStatus, number> = {
  failed: 0,    // surfaces failures first
  killed: 1,
  contract_failure: 2,
  running: 3,
  stopped: 4,
  completed: 5,
  completed_dirty: 6,
  completed_stale: 7,
};
```

`sortTasks()` sorts by status priority first, then `started_at` descending as tiebreaker. This means a task that failed 3 hours ago sits above a task that completed 30 seconds ago. The user has to visually scan past stale failures to find what just happened.

**Default:** `commandCentral.agentStatus.sortByStatus` = `true`

### 2.2 Grouping: alphabetical project groups fragment the timeline

**Code:** `src/providers/agent-status-tree-provider.ts:1628-1639`

Projects are sorted alphabetically (`a.projectName.localeCompare(b.projectName)`). A user running agents across `api-gateway`, `frontend`, and `shared-lib` sees them in that alphabetical order — not by which project had the most recent activity.

**Default:** `commandCentral.agentStatus.groupByProject` = `true`

### 2.3 No "all runs" flat view with recency sort

When `groupByProject` is `false`, the flat list still applies status-priority sorting. There is no way to get a pure recency-sorted flat list without also disabling `sortByStatus` — and most users don't know that setting exists.

### 2.4 Group-level recency is invisible

Even when grouped, the tree gives no signal about which project group has the freshest activity. All groups look equally weighted. In Git Changes, the tree naturally surfaces the files you just touched.

### 2.5 Discovered agents sort separately

Discovered agents (line 1301-1307) are appended after launcher tasks in flat mode, each group sorted by `startTime` descending. This creates a visual break: launcher tasks (status-sorted) followed by discovered agents (time-sorted). The two populations don't interleave by recency.

---

## 3. Recommended Default Behavior

### 3.1 New defaults

| Setting | Current default | New default | Rationale |
|---------|----------------|-------------|-----------|
| `sortByStatus` | `true` | `false` | Recency-first by default |
| `groupByProject` | `true` | `false` | Flat list by default, like Git Changes |

### 3.2 Default sort: recency-first (newest on top)

All agents — launcher tasks and discovered — sorted in a single flat list by their most relevant timestamp:
- **Running agents:** sorted by `started_at` descending (newest first)
- **Completed/failed agents:** sorted by `completed_at ?? started_at` descending

This means "what just finished" floats to the top naturally. Running agents interleave with completed ones based on when things actually happened.

### 3.3 Why not running-first-then-recency as default?

Running-first is a valid workflow (and we'll offer it as a mode), but it has the same problem as status-first: it fragments the timeline. If you have 2 running and 8 completed, the 2 running agents sit at the top permanently, pushing the "just finished 5 seconds ago" result to position 3+. The recency-first default lets running agents naturally appear near the top (they started recently) while not pinning them there artificially.

---

## 4. Sort & Group Modes

Replace the two booleans (`sortByStatus`, `groupByProject`) with a single sort-mode enum and an independent grouping toggle.

### 4.1 Sort modes (new enum setting)

**Setting:** `commandCentral.agentStatus.sortMode`

| Mode | Behavior | When to use |
|------|----------|-------------|
| `"recency"` **(default)** | All agents sorted by `completed_at ?? started_at` descending | "What just happened?" |
| `"status"` | Running → failed → completed, then recency within each bucket | "What needs attention?" |
| `"status-recency"` | Running first, then everything else by recency | Hybrid — running stays pinned, rest is timeline |

The old boolean `sortByStatus` becomes a migration alias: `true` maps to `"status"`, `false` maps to `"recency"`.

### 4.2 Grouping toggle (keep, but change default)

**Setting:** `commandCentral.agentStatus.groupByProject`

| Value | Behavior |
|-------|----------|
| `false` **(new default)** | Flat list, all agents interleaved |
| `true` | Grouped by project, groups sorted by most-recent-activity descending |

**Key change when grouped:** Project groups are sorted by the timestamp of their most recent child agent, not alphabetically. This means the project with the freshest activity floats to the top — exactly how Git Changes works with file groups.

### 4.3 Interaction matrix

| sortMode | groupByProject=false | groupByProject=true |
|----------|---------------------|---------------------|
| `recency` | Flat timeline (default) | Groups by project, groups sorted by recency, agents within groups by recency |
| `status` | Flat list, status-bucketed | Groups by project, groups sorted alphabetically (current behavior) |
| `status-recency` | Running pinned top, rest by recency | Groups by project, groups with running agents float to top |

---

## 5. UI/UX Proposal

### 5.1 View title toolbar (existing buttons, refined)

Current toolbar: Launch | Refresh | Filter Running | Toggle Grouping | Clear Terminal Tasks

**Proposed additions/changes:**

1. **Sort mode cycle button** (new, `navigation@3.5` — between filter and group toggles)
   - Icon cycles: `$(history)` → `$(warning)` → `$(pin)` for recency → status → status-recency
   - Tooltip shows current mode name
   - Single click cycles to next mode
   - Command: `commandCentral.cycleSortMode`

2. **Group toggle** (keep existing, icon unchanged)
   - `$(list-flat)` when grouped → click to flatten
   - `$(list-tree)` when flat → click to group

### 5.2 Command palette entries

| Command | Title |
|---------|-------|
| `commandCentral.cycleSortMode` | "Agent Status: Cycle Sort Mode" |
| `commandCentral.setSortMode` | "Agent Status: Set Sort Mode" (quickpick with all 3 options) |

### 5.3 Summary node enhancement

The existing summary node (`"3 running · 2 completed · 1 failed"`) should gain a subtle sort-mode indicator:

- `"↓ Recent · 3 running · 2 completed"` (recency mode)
- `"⚠ Status · 1 failed · 3 running · 2 completed"` (status mode)
- `"▶ Active · 3 running | 2 completed · 1 failed"` (status-recency mode)

This gives immediate visual feedback about the current sort without requiring the user to hover on toolbar buttons.

### 5.4 Grouped view: recency-sorted groups

When grouping is enabled under recency sort:

```
↓ Recent · 5 agents
├── frontend (2s ago)           ← most recent activity
│   ├── task-abc  completed  2s ago  +12/-3
│   └── task-def  running    1m ago
├── api-gateway (45s ago)
│   └── task-ghi  completed  45s ago  +4/-1
└── shared-lib (10m ago)
    ├── task-jkl  failed     10m ago
    └── task-mno  completed  12m ago
```

Group labels include a relative time showing the most recent child's timestamp. This is the key UX improvement: you can instantly see which project had the freshest activity.

### 5.5 Keyboard shortcuts

| Action | Shortcut | Notes |
|--------|----------|-------|
| Cycle sort mode | `Cmd+Shift+S` (when Agent Status focused) | Matches VS Code conventions for sort cycling |
| Toggle grouping | (existing) | Keep current keybinding if any |

---

## 6. Settings & Command Surface Changes

### 6.1 New settings

```jsonc
// package.json contributes.configuration
"commandCentral.agentStatus.sortMode": {
  "type": "string",
  "enum": ["recency", "status", "status-recency"],
  "default": "recency",
  "enumDescriptions": [
    "Sort all agents by most recent activity (newest first)",
    "Sort by status priority (failed → running → completed), then recency",
    "Pin running agents to top, sort everything else by recency"
  ],
  "markdownDescription": "Controls how agents are sorted in the Agent Status tree. `recency` shows the latest runs first. `status` groups by attention-needed. `status-recency` pins active agents while keeping a timeline below.",
  "scope": "window"
}
```

### 6.2 Deprecated settings

| Setting | Migration |
|---------|-----------|
| `commandCentral.agentStatus.sortByStatus` | Read on activation: if `true` → set `sortMode` to `"status"`. Remove from UI but keep reading for one major version. |

### 6.3 New commands

| Command ID | Title | Icon |
|------------|-------|------|
| `commandCentral.cycleSortMode` | Agent Status: Cycle Sort Mode | `$(history)` / `$(warning)` / `$(pin)` |
| `commandCentral.setSortMode` | Agent Status: Set Sort Mode | — |

### 6.4 Context keys (for `when` clauses)

| Key | Purpose |
|-----|---------|
| `commandCentral.agentStatus.sortMode` | Current sort mode string — drives toolbar icon swapping |

---

## 7. Implementation: Key Code Changes

### 7.1 `src/providers/agent-status-tree-provider.ts`

This is the primary file. Changes:

1. **`sortTasks()` (line 1563-1577):** Replace boolean branch with switch on `sortMode` enum. Add `completed_at` fallback for recency sorting.

2. **`getChildren()` root branch (line 1239-1326):** Unify launcher tasks + discovered agents into a single sorted list when `groupByProject=false`. Currently they're concatenated separately — discovered agents always appear after launcher tasks. They need to interleave by the active sort mode.

3. **`buildProjectNodes()` (line 1579-1639):** When `sortMode=recency`, sort project groups by `max(child.completed_at ?? child.started_at)` descending instead of `a.projectName.localeCompare(b.projectName)`.

4. **`buildGroupedRootNodes()` and `buildFolderGroupNodes()`:** Propagate the new sort-by-recency logic to folder groups.

5. **Summary node (line 1312-1316):** Prepend sort-mode indicator.

6. **New method: `getSortMode()`:** Read from config, handle migration from deprecated boolean.

7. **Configuration change listener (line 522-523):** Add `sortMode` to watched configs.

### 7.2 `package.json`

- Add `sortMode` setting definition
- Add `cycleSortMode` / `setSortMode` commands
- Add toolbar menu entries with `when` clauses for icon cycling
- Deprecation note on `sortByStatus`
- Change `groupByProject` default to `false`

### 7.3 `src/commands/` (new or existing)

- Register `cycleSortMode` and `setSortMode` command handlers
- `cycleSortMode`: read current → advance to next → write to config → update context key
- `setSortMode`: show quickpick → write to config → update context key

### 7.4 Tests

- `src/test/agent-status-tree-provider.test.ts`: Update existing sort tests, add cases for each sort mode × grouping combination
- Test migration path: `sortByStatus=true` → `sortMode=status`
- Test group ordering under recency sort
- Test interleaving of launcher + discovered agents

---

## 8. Migration Plan

### Phase 1: Ship new defaults (non-breaking)

1. Add `sortMode` setting with default `"recency"`
2. Change `groupByProject` default to `false`
3. Keep `sortByStatus` functional but deprecated
4. On activation, if user has explicit `sortByStatus=true` in settings, auto-migrate to `sortMode: "status"` and log a deprecation notice
5. Existing users who never changed defaults will see the new behavior (recency + flat) — this is intentional and desired

### Phase 2: Remove deprecated setting (next major)

1. Remove `sortByStatus` from `package.json` configuration
2. Remove migration code from activation
3. Update documentation

### Risk: Existing user disruption

Users who liked status-first + grouped-by-project will see a different default. Mitigation:
- The old behavior is one click away (cycle sort → status, toggle grouping on)
- A "What's New" notification on first activation post-update can explain the change and link to settings

---

## 9. Telemetry & Success Metrics

### 9.1 New telemetry events

| Event | Properties | Purpose |
|-------|-----------|---------|
| `agentStatus.sortModeChanged` | `from`, `to`, `trigger` (toolbar/command/settings) | Track which modes users prefer |
| `agentStatus.groupingToggled` | `enabled`, `sortMode` | Track grouping usage in context of sort mode |

### 9.2 Success criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Sort mode distribution | >60% stay on `recency` after 2 weeks | Telemetry |
| User complaints about finding recent runs | Decrease to zero | Support/feedback channels |
| Sort mode changes per session | <2 avg (users find a mode and stick) | Telemetry |
| Grouping usage | 30-50% enable grouping (validates it's a useful option, not mandatory) | Telemetry |

### 9.3 Failure signal

If >40% of users switch away from `recency` default within the first session, the hypothesis is wrong and status-first serves users better. Reassess.

---

## 10. Acceptance Criteria

### P0 (must ship)

- [ ] Default sort is recency-first (newest on top), flat list
- [ ] Launcher tasks and discovered agents interleave in a single sorted list
- [ ] Sort mode cycles via toolbar button: recency → status → status-recency
- [ ] `setSortMode` command available in command palette
- [ ] `groupByProject` toggle works independently of sort mode
- [ ] When grouped + recency sort, project groups sorted by most recent child activity
- [ ] `sortByStatus` boolean migrated gracefully to `sortMode` enum
- [ ] All existing tests pass; new tests cover each mode × grouping combination
- [ ] Summary node shows current sort mode indicator

### P1 (should ship)

- [ ] Group labels show relative time of most recent child
- [ ] Keyboard shortcut for cycling sort mode
- [ ] Telemetry events for sort mode and grouping changes
- [ ] "What's New" notification on default change

### P2 (nice to have)

- [ ] Persist sort mode per-workspace (not just global)
- [ ] Animate/highlight newly-appeared agents (brief flash on tree item)
- [ ] Sort mode shown in status bar when Agent Status view is focused

---

## 11. Phased Roadmap

### M3.5-1: Core sort redesign (P0)

**Scope:** New `sortMode` enum, recency-first default, unified agent interleaving, toolbar cycle button.

**Files:**
- `src/providers/agent-status-tree-provider.ts` — sorting logic, `getChildren()`, `buildProjectNodes()`
- `package.json` — new setting, commands, toolbar menus
- `src/commands/` — new command handlers
- `src/test/` — updated + new sort tests

**Estimate:** ~200-300 lines changed across 3-4 files.

### M3.5-2: Group recency + polish (P1)

**Scope:** Recency-sorted groups, relative time in group labels, summary node indicator, telemetry.

**Files:**
- `src/providers/agent-status-tree-provider.ts` — group sorting, summary formatting
- `src/services/telemetry-service.ts` — new events

### M3.5-3: Migration + communication (P1)

**Scope:** `sortByStatus` deprecation migration, "What's New" notification, docs update.

**Files:**
- `src/extension.ts` — migration logic on activation
- `package.json` — deprecation markings
- `README.md` — updated feature documentation

---

## 12. Non-Goals

- **Custom sort orders or drag-and-drop reordering:** Over-engineered for current user base.
- **Saved view presets ("layouts"):** Premature abstraction. Three sort modes + a grouping toggle is the right surface area.
- **Status-based grouping (group by running/completed/failed):** This is just the status sort mode with visual headers. If users ask for it post-launch, it's a P2 add.
- **Product code changes in this task:** This is a spec/planning deliverable only.

---

## 13. Open Questions

1. **Should `status-recency` be the default instead of pure `recency`?** The argument: running agents are always interesting and should stay visible. Counter-argument: running agents are already recent, so they'll be near the top anyway. Recommendation: ship `recency` as default, monitor telemetry.

2. **Should we add a "completed today" / "older" visual separator in the flat list?** This would help long lists. Defer to post-launch feedback — premature to add before we know typical list lengths.

3. **Folder group sorting:** Currently `buildFolderGroupNodes()` sorts folder groups alphabetically too. Should inherit the same recency logic. Confirm this doesn't break the workspace multi-root layout assumptions.
